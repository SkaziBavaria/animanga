'use strict';

const { fetchWebText } = require('./web-fetch');
const { recordProviderFailure } = require('./provider-health');
const { normalizeEpisode, normalizeMode, compareEpisodes } = require('./episodes');
const { fetchMegaplayCaptionConfig } = require('./megaplay-captions');

const HIANIME_ORIGIN = 'https://hianime.at';
const HIANIME_REFERER = `${HIANIME_ORIGIN}/`;

function decodeEntities(value) {
  return String(value || '')
    .replace(/&#039;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
}

function stripHtmlTags(value) {
  let text = String(value || '');
  for (let n = 0; n < 8; n += 1) {
    const next = text.replace(/<[^>]*>/g, '');
    if (next === text) break;
    text = next;
  }
  return text.replace(/[<>]/g, '');
}

function unescapeHtml(value) {
  return decodeEntities(String(value || '').replace(/\\\//g, '/').replace(/\\"/g, '"'));
}

function absoluteUrl(value, base = HIANIME_ORIGIN) {
  if (!value) return '';
  try {
    const url = new URL(String(value), base || HIANIME_ORIGIN);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
  } catch { return ''; }
}

async function fetchHiAnime(pathOrUrl, options = {}) {
  const url = /^https?:\/\//i.test(pathOrUrl) ? pathOrUrl : `${HIANIME_ORIGIN}${String(pathOrUrl).startsWith('/') ? '' : '/'}${pathOrUrl}`;
  return fetchWebText(url, {
    timeoutMs: options.timeoutMs || 15_000,
    headers: { Referer: HIANIME_REFERER, ...(options.headers || {}) },
    ipv4: options.ipv4,
  });
}

function tickCount(html, kind) {
  const match = String(html || '').match(new RegExp(`<div[^>]*class=["'][^"']*tick-item[^"']*tick-${kind}[^"']*["'][^>]*>([\\s\\S]*?)</div>`, 'i'));
  const count = Number(String(match?.[1] || '').replace(/<[^>]+>/g, '').trim());
  return Number.isFinite(count) && count > 0 ? count : 0;
}

function tickLabel(html, kind) {
  const match = String(html || '').match(new RegExp(`<div[^>]*class=["'][^"']*tick-item[^"']*tick-${kind}[^"']*["'][^>]*>([\\s\\S]*?)</div>`, 'i'));
  return decodeEntities(String(match?.[1] || '').replace(/<[^>]+>/g, '').trim());
}

function parseAiredRange(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return {};
  const [startRaw, endRaw] = text.split(/\s+to\s+/i);
  const parsePart = (part) => {
    const cleaned = String(part || '').replace(/\?/g, '').trim();
    if (!cleaned) return null;
    const named = cleaned.match(/^([A-Za-z]{3})\s+(\d{1,2}),\s+(\d{4})$/);
    if (named) {
      const months = {
        jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
        jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
      };
      const month = months[named[1].toLowerCase()];
      if (month == null) return null;
      return { year: Number(named[3]), month, date: Number(named[2]) };
    }
    const year = cleaned.match(/^(\d{4})$/);
    return year ? { year: Number(year[1]), month: 0, date: 1 } : null;
  };
  const airedStart = parsePart(startRaw);
  const airedEnd = parsePart(endRaw);
  return { ...(airedStart ? { airedStart } : {}), ...(airedEnd ? { airedEnd } : {}) };
}

function catalogMeta(html) {
  const type = decodeEntities(
    String(html || '').match(/<span[^>]*class=["']fdi-item["'][^>]*>([^<]+)/i)?.[1]
    || [...String(html || '').matchAll(/<span class=["']item["']>([^<]+)/gi)].map((match) => decodeEntities(match[1].trim())).find((item) => !/^\d+m$/i.test(item))
    || '',
  ).trim();
  const nativeName = decodeEntities(String(html || '').match(/data-jname=["']([^"']+)/i)?.[1] || '').trim();
  const rating = tickLabel(html, 'pg');
  const sourceQuality = tickLabel(html, 'quality');
  return {
    ...(type ? { type } : {}),
    ...(nativeName ? { nativeName } : {}),
    ...(rating ? { rating } : {}),
    ...(sourceQuality ? { sourceQuality } : {}),
  };
}

function catalogCardHtml(block) {
  const text = String(block || '');
  const detail = text.search(/class=["'][^"']*film-detail/i);
  if (detail < 0) return text.slice(0, 2000);
  const rest = text.slice(detail);
  const stop = rest.search(/<div[^>]+class=["'][^"']*(?:flw-item|anif-block|film-poster)|<div[^>]+id=["'](?:main-sidebar|top-viewed-)/i);
  return text.slice(0, detail) + (stop > 0 ? rest.slice(0, stop) : rest.slice(0, 2000));
}

function parseCatalogCard(block) {
  const scoped = catalogCardHtml(block);
  const match = scoped.match(/<a[^>]+href=["'][^"']*\/([^/"'?]+)["'][^>]+title=["']([^"']+)["']/i);
  if (!match) return null;
  const id = match[1];
  const name = decodeEntities(match[2]).trim();
  if (!id || !name) return null;
  const image = scoped.match(/(?:data-src|src)=["']([^"']+)["']/i)?.[1];
  const sub = tickCount(scoped, 'sub');
  const dub = tickCount(scoped, 'dub');
  // tick-eps can include unaired episodes. Available sub/dub ticks match the episode list.
  const episodeCount = Math.max(sub, dub) || tickCount(scoped, 'eps') || 0;
  const item = {
    id, name, sourceName: name, englishName: name, thumbnail: absoluteUrl(image),
    ...catalogMeta(scoped),
  };
  if (episodeCount) {
    item.episodeCount = episodeCount;
    item.latestEpisode = String(episodeCount);
    item.episodeCounts = { ...(sub ? { sub } : {}), ...(dub ? { dub } : {}) };
    item.title = `${name} (${episodeCount} episodes)`;
  }
  return item;
}

function parseSearchResults(html) {
  const page = String(html || '').replace(/\n/g, ' ');
  const main = page.split(/id=["']main-sidebar["']/i)[0];
  const results = [];
  const seen = new Set();
  const add = (item) => {
    if (!item || seen.has(item.id)) return;
    seen.add(item.id);
    results.push(item);
  };
  const cards = main.split(/<div[^>]+class=["'][^"']*flw-item[^"']*["'][^>]*>/i);
  if (cards.length > 1) {
    for (const card of cards.slice(1)) add(parseCatalogCard(card));
    return results;
  }
  for (const block of main.split(/<div[^>]+class=["'][^"']*film-detail[^"']*["'][^>]*>/i).slice(1)) {
    add(parseCatalogCard(block));
  }
  return results;
}

function jsonHtmlPayload(raw) {
  const text = String(raw || '');
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed?.html === 'string') return parsed.html;
    } catch { /* Fall through to HTML fragments used by fixtures. */ }
  }
  return unescapeHtml(text).replace(/\\n/g, ' ');
}

function episodeListHtml(raw) {
  return jsonHtmlPayload(raw);
}

function usableEpisodeTitle(value) {
  const title = decodeEntities(value).replace(/\s+/g, ' ').trim();
  if (!title || /^episode\s*\d+(?:\.\d+)?$/i.test(title)) return '';
  return title;
}

function parseEpisodeTitle(block) {
  const tag = String(block || '').match(/<(?:a|div|span)[^>]*ep-name[^>]*>/i)?.[0] || '';
  const inner = String(block || '').match(/<(?:a|div|span)[^>]*ep-name[^>]*>([\s\S]*?)<\/(?:a|div|span)>/i)?.[1] || '';
  return usableEpisodeTitle(tag.match(/\stitle=["']([^"']+)["']/i)?.[1] || stripHtmlTags(inner));
}

function parseEpisodes(raw, slug) {
  const text = episodeListHtml(raw);
  const escapedSlug = String(slug || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const items = [];
  for (const block of text.split(/ep-item/i).slice(1)) {
    const number = block.match(/data-number=["']([^"']+)["']/i)?.[1];
    const id = block.match(/data-id=["'](\d+)["']/i)?.[1];
    const href = block.match(/href=["'][^"']*\/watch\/([^?"']+)\?ep=/i)?.[1];
    if (!number || !id || !href || !new RegExp(`^${escapedSlug}$`, 'i').test(href)) continue;
    items.push({
      id: Number(id),
      number: normalizeEpisode(number),
      title: parseEpisodeTitle(block) || usableEpisodeTitle(block.match(/data-title=["']([^"']+)["']/i)?.[1]),
    });
  }
  const seen = new Set();
  return items.filter((item) => item.number && !seen.has(item.number) && seen.add(item.number)).sort((a, b) => compareEpisodes(a.number, b.number));
}

function decodeEmbedBlob(value) {
  const bytes = Buffer.from(String(value || ''), 'base64');
  const key = Buffer.from('otaku-embed-v1');
  const output = Buffer.alloc(bytes.length);
  for (let i = 0; i < bytes.length; i += 1) output[i] = bytes[i] ^ key[i % key.length];
  return output.toString('utf8');
}

function isEnglishSubtitleTrack(track) {
  const lang = String(track?.lang || track?.language || '').toLowerCase();
  const label = String(track?.label || '').toLowerCase();
  return /^(?:en|eng|english)(?:[-_][a-z]+)?$/.test(lang) || /\benglish\b/.test(label);
}

function pickSubtitleTrack(config, baseUrl = HIANIME_ORIGIN) {
  const tracks = Array.isArray(config?.subtitles) ? config.subtitles : [];
  const usable = tracks.filter((item) => item && (item.src || item.file || item.url));
  const preferred = usable.find((item) => item.default)
    || usable.find(isEnglishSubtitleTrack)
    || usable[0]
    || null;
  const src = absoluteUrl(preferred?.src || preferred?.file || preferred?.url, baseUrl);
  if (!src) return null;
  return {
    src,
    lang: String(preferred.lang || preferred.language || 'en').trim().slice(0, 16) || 'en',
    label: String(preferred.label || 'English').trim().slice(0, 64) || 'English',
  };
}

function withResolvedSubtitle(link, track, serverName) {
  return {
    ...link,
    server: serverName,
    ...(track ? {
      subtitle: track.src,
      subtitleLang: track.lang,
      subtitleLabel: track.label,
      ...(track.referrer ? { subtitleReferrer: track.referrer } : {}),
    } : {}),
  };
}

function parseM3u8(playlist, masterUrl, referrer) {
  const lines = String(playlist || '').split(/\r?\n/);
  const links = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!/^#EXT-X-STREAM-INF:/i.test(lines[i])) continue;
    const info = lines[i].match(/RESOLUTION=\d+x(\d+)/i);
    const url = absoluteUrl(lines[i + 1], masterUrl);
    if (url) links.push({ url, quality: info?.[1] ? Number(info[1]) : null, referrer, provider: 'hianime' });
  }
  return links.sort((a, b) => (b.quality || 0) - (a.quality || 0));
}

function selectQuality(links, quality = 'best') {
  if (!links.length) return null;
  if (String(quality).toLowerCase() === 'worst') return links.at(-1);
  const target = Number(String(quality).match(/\d{3,4}/)?.[0]);
  return links.find((item) => item.quality === target) || links.find((item) => item.quality && item.quality <= target) || links[0];
}

async function searchAnime(query) {
  const html = await fetchHiAnime(`/search?keyword=${encodeURIComponent(String(query || '').trim())}`);
  return parseSearchResults(html).map((item, index) => ({ ...item, index: index + 1, title: item.title || item.name, ...catalogIdentity(item.id) }));
}

async function browseAnime(path = '/most-popular') {
  const html = await fetchHiAnime(path);
  return parseSearchResults(html).map((item, index) => ({ ...item, index: index + 1, title: item.title || item.name, ...catalogIdentity(item.id) }));
}

const ANIME_BROWSE_PAGES = {
  '0': '/most-popular',
  popular: '/most-popular',
  airing: '/top-airing',
  favorite: '/most-favorite',
};
const ANIME_BROWSE_CHARTS = { '1': 'day', '7': 'week', '30': 'month' };

function resolvePopularBrowse(range = '0') {
  const key = String(range ?? '0');
  const period = ANIME_BROWSE_CHARTS[key];
  if (period) return { type: 'chart', period, range: key };
  const path = ANIME_BROWSE_PAGES[key];
  if (!path) throw Object.assign(new Error('Unknown catalog browse'), { status: 422 });
  return { type: 'page', path };
}

function parseChart(html, range) {
  const period = resolvePopularBrowse(range).period;
  if (!period) throw new Error('Unknown HiAnime chart range');
  const section = String(html).split(`id="top-viewed-${period}"`)[1];
  if (!section) throw new Error('HiAnime chart missing');
  return parseSearchResults(section.split(/id="top-viewed-/)[0]);
}

async function popularAnime(range = '0') {
  const browse = resolvePopularBrowse(range);
  if (browse.type === 'page') return browseAnime(browse.path);
  return parseChart(await fetchHiAnime('/home'), browse.range).map((item) => ({ ...item, title: item.title || item.name, ...catalogIdentity(item.id) }));
}

function pageSlug(value) {
  return String(value || '').replace(/^watch\//i, '').replace(/\/+$/, '').trim();
}

function catalogIdentity(id) {
  return { provider: 'hianime', providerId: id, hianimeId: id };
}

function relationFromBlock(block, relation) {
  const id = pageSlug(block.match(/href=["']https?:\/\/hianime\.at\/([^"'?#]+)/i)?.[1]);
  const name = decodeEntities(block.match(/title=["']([^"']+)/i)?.[1] || '').trim();
  if (!id || !name) return null;
  const image = block.match(/url\((['"]?)([^)'"]+)\1\)/i)?.[2]
    || block.match(/(?:data-src|src)=["']([^"']+)/i)?.[1];
  const sub = tickCount(block, 'sub');
  const dub = tickCount(block, 'dub');
  const episodeCount = Math.max(sub, dub) || tickCount(block, 'eps') || 0;
  const type = decodeEntities(block.match(/class=["']dot["']><\/div>\s*([A-Za-z][A-Za-z -]*)/i)?.[1] || '').trim();
  return {
    relation,
    id,
    ...catalogIdentity(id),
    name,
    sourceName: name,
    title: name,
    thumbnail: absoluteUrl(image),
    ...(type ? { type } : {}),
    ...(episodeCount ? { episodeCount, latestEpisode: String(episodeCount) } : {}),
    ...(sub || dub ? { episodeCounts: { ...(sub ? { sub } : {}), ...(dub ? { dub } : {}) } } : {}),
  };
}

function parseMoreSeasons(html, currentSlug) {
  const section = String(html || '').split(/>\s*More Seasons\s*</i)[1]?.split(/<\/section>/i)[0] || '';
  const seasons = [];
  for (const tag of section.split(/<a\b/i).slice(1)) {
    if (!/os-item/i.test(tag)) continue;
    const item = relationFromBlock(tag, 'related');
    if (!item) continue;
    seasons.push(item);
    if (seasons.length >= 16) break;
  }
  const currentIndex = seasons.findIndex((item) => item.id === currentSlug);
  return seasons.map((item, index) => ({
    ...item,
    relation: currentIndex < 0 ? 'related' : index < currentIndex ? 'prequel' : index > currentIndex ? 'sequel' : 'current',
  }));
}

function parseRelatedAnime(html) {
  const section = String(html || '').split(/>\s*Related Anime\s*</i)[1]?.split(/<section\b/i)[0] || '';
  const items = [];
  for (const li of section.split(/<li\b/i).slice(1)) {
    const item = relationFromBlock(li, 'related');
    if (!item) continue;
    items.push(item);
    if (items.length >= 12) break;
  }
  return items;
}

function parseRelations(html, currentSlug) {
  const slug = pageSlug(currentSlug);
  const seasons = parseMoreSeasons(html, slug);
  const nextSeason = seasons.find((item) => item.relation === 'sequel') || null;
  const seen = new Set([slug]);
  const relations = [];
  for (const item of [...seasons.filter((item) => item.relation !== 'current'), ...parseRelatedAnime(html)]) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    relations.push(item);
  }
  return {
    relatedShows: relations.map((item) => ({ relation: item.relation, showId: item.id })),
    relations,
    ...(nextSeason ? { nextSeason, hasNextSeason: true } : {}),
  };
}

function parseShowDetails(html, slug) {
  const name = decodeEntities(html.match(/<h2[^>]+class=["'][^"']*film-name[^"']*["'][^>]*>([\s\S]*?)<\/h2>/i)?.[1].replace(/<[^>]+>/g, '').trim() || '');
  const description = decodeEntities(html.match(/class=["'][^"']*film-description[^"']*["'][\s\S]*?<div class=["']text["'][^>]*>([\s\S]*?)<\/div>/i)?.[1].replace(/<[^>]+>/g, '').trim() || '');
  if (!name) throw new Error('HiAnime returned invalid title details');
  const poster = html.match(/<img\b[^>]*class=["'][^"']*film-poster-img[^"']*["'][^>]*>/i)?.[0] || '';
  const thumbnail = poster.match(/(?:data-src|src)=["']([^"']+)/i)?.[1] || '';
  const info = html.split(/class=["']anisc-info["']/i)[1]?.split(/class=["']film-text/i)[0] || '';
  const stats = html.split(/class=["']film-stats["']/i)[1]?.split(/class=["'](?:film-description|anisc-info)/i)[0] || '';
  const genres = [...info.matchAll(/href=["']https?:\/\/hianime\.at\/genres\/[^"']+["'][^>]*>([^<]+)</gi)].map((m) => decodeEntities(m[1].trim())).filter(Boolean);
  const field = (label) => decodeEntities(info.match(new RegExp(`${label}:<\\/span>\\s*<span[^>]*>([^<]+)`, 'i'))?.[1]?.trim() || '');
  const nativeName = decodeEntities(html.match(/<h2[^>]+class=["'][^"']*film-name[^"']*["'][^>]*data-jname=["']([^"']+)/i)?.[1] || '').trim()
    || field('Japanese');
  return {
    id: slug, ...catalogIdentity(slug), name, sourceName: name, title: name, description,
    thumbnail: absoluteUrl(thumbnail), genres: [...new Set(genres)], status: field('Status'), score: field('MAL Score'),
    ...catalogMeta(`${stats} ${info}`),
    ...(nativeName ? { nativeName } : {}),
    ...parseAiredRange(field('Aired')),
    ...parseRelations(html, slug),
  };
}

async function getShowDetails(showId) {
  const slug = String(showId || '').trim();
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(slug)) throw new Error('Invalid HiAnime show id');
  const details = parseShowDetails(await fetchHiAnime(`/${slug}`), slug);
  const episodes = await listEpisodes(slug);
  return { ...details, episodes, episodeCount: episodes.length, latestEpisode: episodes.at(-1)?.number || null };
}

async function listEpisodes(showId) {
  const slug = String(showId || '').trim();
  if (!slug) throw new Error('Missing HiAnime show id');
  const numericId = slug.match(/-(\d+)$/)?.[1] || slug;
  return parseEpisodes(await fetchHiAnime(`/api/theme/episode/list/${encodeURIComponent(numericId)}`), slug);
}

const MEGAPLAY_CAPTION_SERVERS = new Set(['HD-2', 'Vidstream-2']);

function parseServerItems(raw, mode) {
  const language = normalizeMode(mode);
  return [...jsonHtmlPayload(raw).matchAll(/<[^>]+class=["'][^"']*server-item[^"']*["'][^>]*>/gi)]
    .map(([tag]) => ({
      language: tag.match(/data-type=["']([^"']+)/i)?.[1],
      name: tag.match(/data-server-name=["']([^"']+)/i)?.[1],
      hash: tag.match(/data-hash=["']([^"']+)/i)?.[1],
    }))
    .filter((server) => server.language === language && server.hash);
}

function parseSupportedServers(raw, mode) {
  // Each player format needs its own decoder. Never apply Zoko's format to
  // unrelated players just because they occur on the same server list.
  return parseServerItems(raw, mode)
    .filter((server) => server.name === 'ZokoAnime')
    .slice(0, 4);
}

function parseMegaplayCaptionServers(raw, mode) {
  return parseServerItems(raw, mode)
    .filter((server) => MEGAPLAY_CAPTION_SERVERS.has(server.name))
    .slice(0, 2);
}

async function resolveEpisodeLinks(showId, episode, mode = 'sub') {
  const slug = String(showId || '').trim();
  const wanted = normalizeEpisode(episode);
  const episodes = await listEpisodes(slug);
  const match = episodes.find((item) => item.number === wanted);
  if (!match) throw new Error(`Episode ${wanted} has no HiAnime sources`);
  const servers = unescapeHtml(await fetchHiAnime(`/api/theme/episode/servers?episodeId=${match.id}`));
  const language = normalizeMode(mode) === 'dub' ? 'dub' : 'sub';
  const serversForLanguage = parseSupportedServers(servers, language);
  if (!serversForLanguage.length) throw new Error(`No ${language} HiAnime source found`);
  let captionFallbackPromise = null;
  const loadCaptionFallback = () => {
    if (!captionFallbackPromise) {
      captionFallbackPromise = (async () => {
        for (const server of parseMegaplayCaptionServers(servers, language)) {
          try {
            const captionEmbed = Buffer.from(server.hash, 'base64').toString('utf8');
            if (!/^https?:\/\//i.test(captionEmbed)) continue;
            const captionConfig = await fetchMegaplayCaptionConfig(captionEmbed);
            const track = pickSubtitleTrack(captionConfig, captionConfig?.baseUrl);
            if (track) return { ...track, referrer: captionConfig.referrer };
          } catch {
            // Caption fallback is optional; keep the playable Zoko stream.
          }
        }
        return null;
      })();
    }
    return captionFallbackPromise;
  };
  let lastError = null;
  for (const server of serversForLanguage.slice(0, 4)) {
    try {
      const embedUrl = Buffer.from(server.hash, 'base64').toString('utf8');
      if (!/^https?:\/\//i.test(embedUrl)) throw new Error(`${server.name} returned an invalid embed URL`);
      const referrer = `${new URL(embedUrl).origin}/`;
      const embed = await fetchHiAnime(embedUrl, { headers: { Referer: referrer } });
      const blob = embed.match(/window\.__P\s*=\s*["']([^"']+)["']/i)?.[1];
      if (!blob) throw new Error(`${server.name} embed configuration missing`);
      let config;
      try { config = JSON.parse(decodeEmbedBlob(blob)); } catch { throw new Error(`${server.name} returned invalid embed configuration`); }
      const masterUrl = absoluteUrl(config.src || config.file, embedUrl);
      if (!masterUrl) throw new Error(`${server.name} embed did not include an m3u8 playlist`);
      const playlist = await fetchHiAnime(masterUrl, { headers: { Referer: referrer } });
      if (!/^#EXTM3U/m.test(playlist)) throw new Error('HiAnime returned an invalid playlist');
      const links = parseM3u8(playlist, masterUrl, referrer);
      const track = pickSubtitleTrack(config, embedUrl) || await loadCaptionFallback();
      if (!links.length) {
        if (!/#EXTINF:/.test(playlist)) throw new Error('HiAnime returned an empty playlist');
        return [withResolvedSubtitle({ url: masterUrl, quality: null, referrer, provider: 'hianime' }, track, server.name)];
      }
      return links.map((link) => withResolvedSubtitle(link, track, server.name));
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error(`No working ${language} HiAnime source found`);
}

async function resolveEpisodePlayback({ showId, episode, mode = 'sub', quality = 'best' }) {
  try {
    const links = await resolveEpisodeLinks(showId, episode, mode);
    const selected = selectQuality(links, quality);
    if (!selected) throw new Error('HiAnime returned no playable sources');
    return selected;
  } catch (error) {
    recordProviderFailure('hianime', error);
    throw error;
  }
}

module.exports = {
  HIANIME_ORIGIN,
  HIANIME_REFERER,
  parseSearchResults,
  parseEpisodes,
  decodeEmbedBlob,
  pickSubtitleTrack,
  parseM3u8,
  searchAnime,
  browseAnime,
  popularAnime,
  parseChart,
  resolvePopularBrowse,
  getShowDetails,
  parseShowDetails,
  parseSupportedServers,
  parseMegaplayCaptionServers,
  listEpisodes,
  resolveEpisodeLinks,
  resolveEpisodePlayback,
};
