'use strict';

const {
  ALLANIME_API,
  ALLANIME_BASE,
  ALLANIME_REFERER,
  USER_AGENT,
} = require('./config');
const {
  MKISSA_ORIGIN,
  buildAaRequest,
  decryptAaResponse,
  resolveCompleteCryptoConfig,
  discardCompleteConfig,
  markConfigVerified,
  formatCryptoFailure,
  candidateKey,
} = require('./mkissa-crypto');
const { normalizeEpisode, normalizeMode } = require('./episodes');
const { fetchWithTimeout: upstreamFetch } = require('./upstream');
const { fetchPublic, parseProxyTarget } = require('./proxy');

const MP4UPLOAD_REFERER = 'https://www.mp4upload.com';
const RESOLVER_ATTEMPTS = 3;
const EPISODE_SOURCES_QUERY = 'query($showId:String!,$translationType:VaildTranslationTypeEnumType!,$episodeString:String!){episode(showId:$showId translationType:$translationType episodeString:$episodeString){episodeString sourceUrls show{_id countryOfOrigin}}}';

let fetchImpl = fetch;
let mediaFetcher = null;

function setFetchForTests(fetcher) {
  fetchImpl = fetcher || fetch;
  mediaFetcher = fetcher
    ? (url, options = {}, timeoutMs = 12_000) => upstreamFetch(fetcher, url, options, timeoutMs)
    : null;
}

function fetchWithTimeout(url, options = {}, timeoutMs = 12_000) {
  return upstreamFetch(fetchImpl, url, options, timeoutMs);
}

async function fetchMedia(url, options = {}, timeoutMs = 12_000) {
  if (mediaFetcher) {
    parseProxyTarget(url);
    return mediaFetcher(url, options, timeoutMs);
  }
  return fetchPublic(url, options, timeoutMs);
}

function cryptoError(result) {
  return (result?.errors || []).find((error) => {
    const value = String(error?.extensions?.code || error?.message || '');
    return value.startsWith('AA_CRYPTO');
  });
}

async function fetchEpisodeSources(showId, episode, mode = 'sub') {
  if (!showId) throw new Error('Missing anime id');
  const episodeString = normalizeEpisode(episode);
  if (!episodeString) throw new Error('Missing episode');

  const triedKeys = new Set();
  let lastError = null;
  for (let attempt = 0; attempt < RESOLVER_ATTEMPTS; attempt += 1) {
    let config;
    try {
      config = await resolveCompleteCryptoConfig({
        forceRefresh: attempt > 0,
        excludeKeys: triedKeys,
        allowLastVerifiedFallback: attempt === 0,
      });
    } catch (error) {
      lastError = error;
      break;
    }

    const key = config.candidateKey || candidateKey(config.maskHex, config.buildId);
    if (triedKeys.has(key)) break;
    triedKeys.add(key);

    const variables = {
      showId: String(showId),
      translationType: normalizeMode(mode),
      episodeString,
    };

    const response = await fetchWithTimeout(ALLANIME_API, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': USER_AGENT,
        referer: `${MKISSA_ORIGIN}/`,
        origin: MKISSA_ORIGIN,
        'x-build-id': config.buildId,
      },
      body: JSON.stringify({
        query: EPISODE_SOURCES_QUERY,
        variables,
        extensions: { aaReq: buildAaRequest(EPISODE_SOURCES_QUERY, config) },
      }),
    });
    if (!response.ok) throw new Error(`AllAnime episode API returned ${response.status}`);
    const result = await response.json();
    const aaError = cryptoError(result);
    if (aaError) {
      discardCompleteConfig(config);
      lastError = new Error(formatCryptoFailure({
        message: aaError.message,
        code: aaError.extensions?.code,
        epoch: config.epoch,
        buildId: config.buildId,
      }));
      continue;
    }
    if (result.errors?.length) {
      throw new Error(result.errors.map((error) => error.message).filter(Boolean).join('; ') || 'AllAnime episode query failed');
    }

    let data;
    try {
      data = result.data?.tobeparsed ? decryptAaResponse(result.data.tobeparsed, config) : result.data;
    } catch (error) {
      discardCompleteConfig(config);
      lastError = new Error(formatCryptoFailure({
        message: `AllAnime response decryption failed: ${error.message}`,
        epoch: config.epoch,
        buildId: config.buildId,
      }));
      continue;
    }

    const sources = data?.episode?.sourceUrls;
    if (!Array.isArray(sources) || !sources.length) {
      throw new Error(`Episode ${episodeString} has no sources`);
    }
    markConfigVerified(config);
    return sources;
  }
  throw lastError || new Error('AllAnime episode crypto exhausted unique candidates');
}

function decodeSourceUrl(value) {
  const input = String(value || '');
  if (!input.startsWith('--')) return input;
  const hex = input.slice(2);
  if (!hex || hex.length % 2 || !/^[0-9a-f]+$/i.test(hex)) throw new Error('AllAnime encoded source URL is invalid');
  const bytes = [];
  for (let index = 0; index < hex.length; index += 2) {
    bytes.push(Number.parseInt(hex.slice(index, index + 2), 16) ^ 0x38);
  }
  return Buffer.from(bytes).toString('utf8').replace('/clock', '/clock.json');
}

function absoluteUrl(value, base) {
  try {
    return new URL(value, base).href;
  } catch {
    return '';
  }
}

function qualityNumber(value) {
  const match = String(value || '').match(/(\d{3,4})/);
  return match ? Number(match[1]) : null;
}

function collectClockLinks(value, output, context = {}) {
  if (Array.isArray(value)) {
    for (const item of value) collectClockLinks(item, output, context);
    return;
  }
  if (!value || typeof value !== 'object') return;

  const referrer = value.Referer || value.referer || context.referrer || ALLANIME_REFERER;
  const url = value.link || value.url;
  if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
    const looksPlayable = value.dash !== true && (value.link
      || value.hls
      || /\.(?:m3u8|mp4)(?:$|\?)/i.test(url)
      || value.resolutionStr);
    if (looksPlayable) {
      output.push({
        url,
        quality: qualityNumber(value.resolutionStr || value.height || value.quality),
        referrer,
        provider: 'Default',
      });
    }
  }
  for (const child of Object.values(value)) collectClockLinks(child, output, { referrer });
}

function decodeHtmlAttribute(value) {
  return String(value || '')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function parseOkRuMetadata(html) {
  const encoded = String(html || '').match(/\bdata-options="([^"]+)"/i)?.[1];
  if (!encoded) return null;
  try {
    const options = JSON.parse(decodeHtmlAttribute(encoded));
    return JSON.parse(options?.flashvars?.metadata || 'null');
  } catch {
    return null;
  }
}

async function expandM3u8(link) {
  if (!/\.m3u8(?:$|\?)/i.test(link.url)) return [link];
  let response;
  try {
    response = await fetchMedia(link.url, {
      headers: { 'user-agent': USER_AGENT, referer: link.referrer || ALLANIME_REFERER },
    });
  } catch {
    return [link];
  }
  if (!response.ok) return [link];
  const manifest = await response.text();
  if (!manifest.includes('#EXT-X-STREAM-INF')) return [link];
  const lines = manifest.split(/\r?\n/);
  const variants = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].startsWith('#EXT-X-STREAM-INF')) continue;
    const next = lines.slice(index + 1).find((line) => line.trim() && !line.startsWith('#'));
    if (!next) continue;
    variants.push({
      ...link,
      url: absoluteUrl(next.trim(), link.url),
      quality: qualityNumber(lines[index].match(/RESOLUTION=\d+x(\d+)/i)?.[1]) || link.quality,
    });
  }
  return variants.length ? variants : [link];
}

async function resolveClockSource(sourceUrl) {
  const decoded = decodeSourceUrl(sourceUrl);
  const endpoint = absoluteUrl(decoded, `https://${ALLANIME_BASE}`);
  if (!endpoint) return [];
  const response = await fetchMedia(endpoint, {
    headers: { 'user-agent': USER_AGENT, referer: ALLANIME_REFERER },
  });
  if (!response.ok) throw new Error(`AllAnime source endpoint returned ${response.status}`);
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error('AllAnime source endpoint returned invalid JSON');
  }
  const links = [];
  collectClockLinks(payload, links);
  return (await Promise.all(links.map(expandM3u8))).flat();
}

async function resolveMp4Upload(sourceUrl) {
  const response = await fetchMedia(sourceUrl, {
    headers: { 'user-agent': USER_AGENT, referer: ALLANIME_REFERER },
  });
  if (!response.ok) throw new Error(`Mp4Upload returned ${response.status}`);
  const html = await response.text();
  const url = html.match(/\bsrc\s*:\s*["'](https?:\/\/[^"']+\.mp4(?:\?[^"']*)?)["']/i)?.[1];
  return url ? [{ url, quality: null, referrer: MP4UPLOAD_REFERER, provider: 'Mp4Upload' }] : [];
}

async function resolveOkRu(sourceUrl) {
  const response = await fetchMedia(sourceUrl, {
    headers: { 'user-agent': USER_AGENT, referer: ALLANIME_REFERER },
  });
  if (!response.ok) throw new Error(`OK.ru returned ${response.status}`);
  const metadata = parseOkRuMetadata(await response.text());
  if (!metadata) return [];

  const direct = (metadata.videos || [])
    .filter((video) => /^https?:\/\//i.test(video?.url || '') && !video.disallowed)
    .map((video) => ({
      url: video.url,
      quality: qualityNumber(video.name) || qualityNumber(metadata.movie?.height),
      referrer: sourceUrl,
      provider: 'OK.ru',
    }));
  if (direct.length) return direct;

  if (metadata.ondemandHls) {
    return expandM3u8({
      url: metadata.ondemandHls,
      quality: null,
      referrer: sourceUrl,
      provider: 'OK.ru',
    });
  }
  return [];
}

async function resolveSource(source) {
  const sourceUrl = String(source?.sourceUrl || '');
  if (!sourceUrl) return [];
  if (sourceUrl.startsWith('--')) return resolveClockSource(sourceUrl);
  if (/mp4upload\.com\/embed-/i.test(sourceUrl)) return resolveMp4Upload(sourceUrl);
  // Temporarily disabled: OK.ru often wins "best" quality but buffers poorly in the browser.
  // if (/ok\.ru\/videoembed\//i.test(sourceUrl)) return resolveOkRu(sourceUrl);
  if (/ok\.ru\/videoembed\//i.test(sourceUrl)) return [];
  if (/\.(?:mp4|m3u8)(?:$|\?)/i.test(sourceUrl) || /tools\.fast4speed\.rsvp/i.test(sourceUrl)) {
    return [{
      url: sourceUrl,
      quality: qualityNumber(source.quality),
      referrer: /sharepoint/i.test(source.sourceName || sourceUrl) ? '' : ALLANIME_REFERER,
      provider: source.sourceName || 'direct',
    }];
  }
  return [];
}

function selectQuality(links, preferred = 'best') {
  const usable = links.filter((link) => /^https?:\/\//i.test(link.url));
  if (!usable.length) return null;
  const sorted = [...usable].sort((a, b) => (b.quality || 0) - (a.quality || 0));
  const target = qualityNumber(preferred);
  if (String(preferred).toLowerCase() === 'worst') return sorted.at(-1);
  if (!target || String(preferred).toLowerCase() === 'best') return sorted[0];
  return sorted.find((link) => link.quality === target)
    || sorted.find((link) => link.quality && link.quality <= target)
    || sorted[0];
}

async function resolveEpisodePlayback({ showId, episode, mode = 'sub', quality = 'best' }) {
  const sources = await fetchEpisodeSources(showId, episode, mode);
  const preferred = [...sources].sort((a, b) => Number(b.priority || 0) - Number(a.priority || 0));
  const settled = await Promise.allSettled(preferred.map(resolveSource));
  const links = settled.filter((item) => item.status === 'fulfilled').flatMap((item) => item.value);
  const selected = selectQuality(links, quality);
  if (!selected) {
    const failures = settled.filter((item) => item.status === 'rejected').map((item) => item.reason?.message).filter(Boolean);
    throw new Error(failures[0] || 'AllAnime returned no directly playable sources');
  }
  return {
    url: selected.url,
    referrer: selected.referrer || '',
    provider: selected.provider,
    quality: selected.quality,
    resolver: 'node',
  };
}

module.exports = {
  fetchEpisodeSources,
  EPISODE_SOURCES_QUERY,
  resolveEpisodePlayback,
  decodeSourceUrl,
  collectClockLinks,
  selectQuality,
  resolveMp4Upload,
  resolveOkRu,
  parseOkRuMetadata,
  setFetchForTests,
};
