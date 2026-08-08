'use strict';

const {
  DETAIL_CACHE_TTL_MS,
  RECOMMENDATION_CACHE_TTL_MS,
  ANIDB_ORIGIN,
} = require('./config');
const {
  preferredName,
  normalizeMode,
  normalizeEpisode,
  compareEpisodes,
  highestEpisode,
} = require('./episodes');
const { cacheGet, cacheSet, trimCache } = require('./state');
const { fetchAnidbText, setAnidbTextFetcherForTests } = require('./anidb-fetch');

const ANIDB_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*-\d+$/i;
const sequelSummaryCache = new Map();
const SEQUEL_SUMMARY_TTL_MS = 6 * 60 * 60 * 1000;
const SEARCH_STOP_WORDS = new Set(['a', 'an', 'and', 'of', 'on', 'the', 'to']);

function normalizeSearchTitle(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function animeTitleScore(query, candidate) {
  const wanted = normalizeSearchTitle(query);
  const name = normalizeSearchTitle(candidate?.name || candidate?.englishName || candidate?.sourceName || candidate?.title);
  if (!wanted || !name) return 0;
  if (wanted === name) return 100;
  if (name.startsWith(`${wanted} `)) return 90;
  const wantedTokens = wanted.split(' ').filter((token) => token && !SEARCH_STOP_WORDS.has(token));
  const nameTokens = new Set(name.split(' ').filter(Boolean));
  if (!wantedTokens.length || wantedTokens.some((token) => !nameTokens.has(token))) return 0;
  return Math.max(70, 85 - Math.max(0, nameTokens.size - wantedTokens.length) * 3);
}

function relevantSearchResults(query, results) {
  const q = String(query || '').trim();
  if (!q || !normalizeSearchTitle(q)) return results;
  return results
    .map((item) => ({ item, score: animeTitleScore(q, item) }))
    .filter(({ score }) => score >= 70)
    .sort((left, right) => right.score - left.score || Number(left.item.index || 0) - Number(right.item.index || 0))
    .map(({ item }) => item);
}

function decodeHtmlEntities(value) {
  const named = { amp: '&', quot: '"', lt: '<', gt: '>', apos: "'" };
  return String(value || '').replace(/&(?:#(\d+)|#x([0-9a-f]+)|(amp|quot|lt|gt|apos));/gi, (entity, decimal, hex, name) => {
    if (decimal) return String.fromCodePoint(Number(decimal));
    if (hex) return String.fromCodePoint(Number.parseInt(hex, 16));
    return named[String(name).toLowerCase()] || entity;
  });
}

function textContent(value) {
  let text = '';
  let insideTag = false;
  for (const character of String(value || '')) {
    if (character === '<') insideTag = true;
    else if (character === '>') insideTag = false;
    else if (!insideTag) text += character;
  }
  return text;
}

function sectionText(html, heading) {
  const escaped = String(heading).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const block = String(html || '').match(
    new RegExp(`<h[1-6][^>]*>\\s*${escaped}\\s*</h[1-6]>([\\s\\S]*?)(?=<h[1-6]\\b|$)`, 'i')
  )?.[1];
  if (!block) return '';
  return decodeHtmlEntities(textContent(
    block
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(?:p|div|li)>/gi, '\n')
  )).split('\n').map((line) => line.trim()).filter(Boolean).join('\n\n');
}

function isAnidbShowId(id) {
  return ANIDB_SLUG_RE.test(String(id || '').trim());
}

function numericAnimeId(showId) {
  const value = String(showId || '').trim();
  const match = value.match(/-(\d+)$/);
  if (!match) throw new Error(`Invalid anidb show id: ${showId}`);
  return match[1];
}

function absoluteUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    return new URL(raw, ANIDB_ORIGIN).href;
  } catch {
    return '';
  }
}

function parseSearchResults(html) {
  const page = String(html || '').replace(/\n/g, ' ').replace(/<a href/g, '\n<a href');
  const results = [];
  const seen = new Set();
  for (const line of page.split('\n')) {
    const match = line.match(/anime\/([a-z0-9-]+-\d+)"[^>]*.*?alt="([^"]+)"/i)
      || line.match(/anime\/([a-z0-9-]+-\d+)"[^>]*title="([^"]+)"/i);
    if (!match) continue;
    const id = match[1];
    if (seen.has(id)) continue;
    seen.add(id);
    const name = decodeHtmlEntities(match[2]).trim();
    if (!name) continue;
    const thumbMatch = line.match(/src="([^"]+)"/i);
    results.push({
      id,
      name,
      sourceName: name,
      englishName: name,
      thumbnail: absoluteUrl(thumbMatch?.[1] || ''),
    });
  }
  return results;
}

function parseEpisodeList(raw) {
  const text = String(raw || '').trim();
  if (!text) return [];
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Fall through to loose object splitting used by ani-cli.
  }
  const items = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.episodes)
      ? parsed.episodes
      : Array.isArray(parsed?.data)
        ? parsed.data
        : text.split(/\},\{/).map((chunk) => {
          const wrapped = chunk.startsWith('{') ? chunk : `{${chunk}`;
          const closed = wrapped.endsWith('}') ? wrapped : `${wrapped}}`;
          try {
            return JSON.parse(closed.replace(/^\[/, '').replace(/\]$/, ''));
          } catch {
            const id = chunk.match(/"id"\s*:\s*(\d+)/)?.[1];
            const number = chunk.match(/"number"\s*:\s*([0-9.]+)/)?.[1];
            return id && number ? { id: Number(id), number: Number(number) } : null;
          }
        }).filter(Boolean);

  return items
    .map((item) => ({
      id: Number(item?.id),
      number: normalizeEpisode(item?.number ?? item?.episode ?? item?.ep),
      title: String(item?.title || item?.name || '').trim(),
    }))
    .filter((item) => Number.isFinite(item.id) && item.number)
    .sort((a, b) => compareEpisodes(a.number, b.number));
}

function parseLanguageSources(raw, mode = 'sub') {
  const lang = normalizeMode(mode) === 'dub' ? 'eng' : 'jpn';
  const text = String(raw || '');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  const rows = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.languages)
      ? parsed.languages
      : Array.isArray(parsed?.data)
        ? parsed.data
        : text.split(/\},\{/).map((chunk) => {
          const langCode = chunk.match(/"lang(?:uage)?"\s*:\s*"([^"]+)"/i)?.[1]
            || chunk.match(/\b(jpn|eng|jap|english|japanese)\b/i)?.[1];
          const embed = chunk.match(/"embed_url"\s*:\s*"([^"]+)"/i)?.[1];
          return embed ? { lang: langCode, language: langCode, embed_url: embed } : null;
        }).filter(Boolean);

  const normalized = rows.map((row) => {
    const code = String(row?.lang || row?.language || row?.code || '').toLowerCase();
    const embed = String(row?.embed_url || row?.embedUrl || row?.url || '')
      .replace(/\\\//g, '/')
      .trim();
    return { code, embed };
  }).filter((row) => row.embed);

  const exact = normalized.find((row) => row.code === lang || row.code.startsWith(lang));
  if (exact) return exact.embed;
  if (lang === 'jpn') {
    return normalized.find((row) => /jpn|jap|japanese|sub/i.test(row.code))?.embed
      || normalized[0]?.embed
      || '';
  }
  return normalized.find((row) => /eng|english|dub/i.test(row.code))?.embed || '';
}

function parseEmbedMaster(html) {
  const match = String(html || '').match(/file:\s*'([^']+)'/i)
    || String(html || '').match(/file:\s*"([^"]+)"/i)
    || String(html || '').match(/source\s+src=["']([^"']+\.m3u8[^"']*)["']/i);
  return match?.[1] || '';
}

function parseM3u8Qualities(playlist) {
  const lines = String(playlist || '').split(/\r?\n/);
  const links = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.startsWith('#EXT-X-STREAM-INF')) continue;
    const quality = Number(line.match(/RESOLUTION=\d+x(\d+)/i)?.[1] || line.match(/(\d{3,4})p/i)?.[1]);
    const url = lines[index + 1]?.trim();
    if (!url || url.startsWith('#')) continue;
    links.push({
      url: absoluteUrl(url),
      quality: Number.isFinite(quality) ? quality : null,
      provider: 'anidb',
      referrer: ANIDB_ORIGIN + '/',
    });
  }
  if (!links.length && /#EXTM3U/i.test(playlist)) {
    links.push({
      url: '',
      quality: null,
      provider: 'anidb',
      referrer: ANIDB_ORIGIN + '/',
      master: true,
    });
  }
  return links;
}

function normalizeProviderStatus(raw) {
  const value = decodeHtmlEntities(String(raw || '')).trim().toLowerCase();
  if (!value) return '';
  if (value.includes('not yet') || value.includes('upcoming')) return 'Not Yet Released';
  if (value.includes('currently airing') || value.includes('ongoing') || value === 'airing') return 'Ongoing';
  if (value.includes('finished') || value.includes('completed')) return 'Finished';
  if (value.includes('hiatus')) return 'Hiatus';
  if (value.includes('cancel') || value.includes('discontinu')) return 'Cancelled';
  return decodeHtmlEntities(String(raw || '')).trim();
}

function parseJsonLd(html) {
  const match = String(html || '').match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!match) return null;
  try {
    return JSON.parse(match[1].replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&amp;/g, '&'));
  } catch {
    return null;
  }
}

function parseSeasons(html, showId) {
  const page = String(html || '');
  const start = page.search(/<h3[^>]*>\s*Seasons\s*<\/h3>/i);
  if (start < 0) return [];
  const rest = page.slice(start);
  const nextHeading = rest.slice(80).search(/<h3\b/i);
  const block = nextHeading >= 0 ? rest.slice(0, nextHeading + 80) : rest.slice(0, 80_000);
  const entries = [];
  const seen = new Set();
  for (const match of block.matchAll(/href="[^"]*\/anime\/([a-z0-9-]+-\d+)"([^>]*)>([\s\S]{0,4000}?)(?=href="[^"]*\/anime\/[a-z0-9-]+-\d+"|$)/gi)) {
    const id = match[1];
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const attrs = match[2] || '';
    const chunk = match[3] || '';
    const number = Number(
      chunk.match(/top-2 left-2[^>]*>\s*(\d+)\s*</i)?.[1]
      || chunk.match(/min-w-\[[^\]]+\][^>]*>\s*(\d+)\s*</i)?.[1]
      || 0
    );
    const title = decodeHtmlEntities(
      chunk.match(/line-clamp-2[^>]*>([^<]+)</i)?.[1]
      || attrs.match(/title="([^"]+)"/i)?.[1]
      || chunk.match(/alt="([^"]+)"/i)?.[1]
      || id
    ).trim();
    const year = Number(chunk.match(/<span>\s*(20\d{2}|19\d{2})\s*<\/span>/)?.[1] || 0) || null;
    entries.push({ id, number, title, year });
  }
  const current = entries.find((entry) => entry.id === showId);
  const currentNumber = current?.number || 0;
  return entries
    .filter((entry) => entry.id !== showId)
    .map((entry) => ({
      relation: entry.number > currentNumber ? 'sequel' : (entry.number && currentNumber ? 'prequel' : 'related'),
      showId: entry.id,
      name: entry.title,
      year: entry.year,
      number: entry.number,
    }));
}

function parseShowPage(html, showId) {
  const page = String(html || '');
  const flat = page.replace(/\n/g, ' ');
  const jsonLd = parseJsonLd(page);
  const title = decodeHtmlEntities(
    textContent(flat.match(/<h1[^>]*>(.*?)<\/h1>/i)?.[1]).trim()
    || jsonLd?.name
    || flat.match(/property="og:title"\s+content="([^"]+)"/i)?.[1]
    || flat.match(/<title>([^<]+)<\/title>/i)?.[1]?.replace(/\s*[|-].*$/, '').trim()
    || showId
  );
  const description = sectionText(page, 'Synopsis') || decodeHtmlEntities(
    jsonLd?.description
    || flat.match(/property="og:description"\s+content="([^"]+)"/i)?.[1]
    || ''
  );
  const thumbnail = absoluteUrl(
    jsonLd?.image
    || flat.match(/property="og:image"\s+content="([^"]+)"/i)?.[1]
    || ''
  );
  const malId = flat.match(/https:\/\/myanimelist\.net\/anime\/(\d+)/i)?.[1] || null;

  const ldGenres = Array.isArray(jsonLd?.genre) ? jsonLd.genre.map(String) : [];
  const chipGenres = [...flat.matchAll(/href="\/genres\/\d+"[^>]*class="filter-chip[^"]*"[^>]*>([^<]+)</gi)]
    .map((match) => decodeHtmlEntities(match[1]).trim())
    .filter(Boolean);
  const uniqueGenres = [...new Set([...ldGenres, ...chipGenres].map((value) => value.trim()).filter(Boolean))];

  const relatedShows = parseSeasons(page, showId);

  const subEp = flat.match(/release-time-type-subs[^>]*>[\s\S]*?Episode\s+([0-9]+)/i)?.[1];
  const dubEp = flat.match(/release-time-type-dub[^>]*>[\s\S]*?Episode\s+([0-9]+)/i)?.[1];
  const subAt = flat.match(/class="countdown-time"\s+datetime="([^"]+)"/i)?.[1];
  const dubAt = flat.match(/class="countdown-time countdown-time-dub"\s+datetime="([^"]+)"/i)?.[1];
  const nextAiringEpisode = subAt || dubAt
    ? {
      episode: Number(subEp || dubEp) || null,
      airingAt: Math.floor(new Date(subAt || dubAt).getTime() / 1000) || null,
      datetime: subAt || dubAt,
    }
    : null;

  const scoreRaw = flat.match(/text-yellow-400[\s\S]{0,200}?<\/svg>\s*([0-9]+(?:\.[0-9]+)?)\s*</i)?.[1]
    || flat.match(/badge[^>]*>[\s\S]*?<\/svg>\s*([0-9]+(?:\.[0-9]+)?)\s*</i)?.[1];
  const statusRaw = flat.match(/browse\?status=([^"&]+)/i)?.[1]
    || flat.match(/badge[^>]*>\s*(Finished Airing|Currently Airing|Not yet aired|Ongoing|Completed|Upcoming|Hiatus|Cancelled)\s*</i)?.[1];
  const status = normalizeProviderStatus(statusRaw ? decodeURIComponent(String(statusRaw).replace(/\+/g, ' ')) : '');

  const seasonMatch = flat.match(/browse\?season=([a-z]+)&year=(\d{4})/i);
  const seasonName = seasonMatch?.[1] ? decodeHtmlEntities(seasonMatch[1]) : '';
  const seasonYear = seasonMatch?.[2] ? Number(seasonMatch[2]) : null;
  const type = decodeHtmlEntities(flat.match(/browse\?type=([^"&]+)/i)?.[1] || '').replace(/\+/g, ' ');

  return {
    id: showId,
    name: title,
    sourceName: title,
    englishName: title,
    nativeName: decodeHtmlEntities(jsonLd?.alternateName || ''),
    thumbnail,
    banner: thumbnail,
    thumbnails: thumbnail ? [thumbnail] : [],
    description,
    genres: uniqueGenres,
    score: scoreRaw ? Number(scoreRaw) : null,
    type,
    status,
    airedStart: seasonYear ? { year: seasonYear, month: 0, date: 1 } : null,
    airedEnd: status.toLowerCase().includes('finished') && seasonYear
      ? { year: seasonYear, month: 0, date: 1 }
      : null,
    season: seasonYear ? { year: seasonYear, season: seasonName } : null,
    broadcastInterval: null,
    nextAiringEpisode,
    malId: malId ? Number(malId) : null,
    relatedShows: relatedShows.map(({ relation, showId: id }) => ({ relation, showId: id })),
    relatedSummaries: relatedShows,
  };
}

async function fetchText(pathOrUrl) {
  return fetchAnidbText(pathOrUrl);
}

function showSummaryFromSearch(item, index, mode = 'sub') {
  const normalizedMode = normalizeMode(mode);
  const name = preferredName(item);
  return {
    index: index + 1,
    id: item.id,
    name,
    sourceName: item.sourceName || item.name,
    englishName: item.englishName || item.name,
    nativeName: item.nativeName || '',
    thumbnail: item.thumbnail || '',
    banner: item.banner || item.thumbnail || '',
    thumbnails: item.thumbnails || (item.thumbnail ? [item.thumbnail] : []),
    genres: item.genres || [],
    score: item.score || null,
    popularity: item.popularity || null,
    type: item.type || '',
    status: item.status || '',
    airedStart: item.airedStart || null,
    airedEnd: item.airedEnd || null,
    season: item.season || null,
    broadcastInterval: item.broadcastInterval || null,
    nextAiringEpisode: item.nextAiringEpisode || null,
    lastEpisodeDate: null,
    lastEpisodeTimestamp: null,
    relatedShows: item.relatedShows || [],
    hasNextSeason: hasNextSeason(item.relatedShows || []),
    title: name,
    episodeCount: Number(item.episodeCount) || 0,
    episodeCounts: item.episodeCounts || {},
    mode: normalizedMode,
    provider: 'anidb',
  };
}

function normalizeRelatedShows(relatedShows) {
  const seen = new Set();
  return (Array.isArray(relatedShows) ? relatedShows : [])
    .map((relation) => ({
      relation: String(relation?.relation || 'related').trim() || 'related',
      showId: String(relation?.showId || '').trim(),
    }))
    .filter((relation) => {
      if (!relation.showId || seen.has(relation.showId)) return false;
      seen.add(relation.showId);
      return true;
    });
}

function hasNextSeason(relatedShows) {
  return normalizeRelatedShows(relatedShows).some((relation) => relation.relation.toLowerCase() === 'sequel');
}

function sequelCacheKey(mode, id) {
  return `${normalizeMode(mode)}:${id}`;
}

function readSequelCache(id, mode = 'sub') {
  const key = sequelCacheKey(mode, id);
  const hit = sequelSummaryCache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    sequelSummaryCache.delete(key);
    return null;
  }
  return { ...hit.value };
}

function writeSequelCache(id, mode, summary) {
  sequelSummaryCache.set(sequelCacheKey(mode, id), {
    expiresAt: Date.now() + SEQUEL_SUMMARY_TTL_MS,
    value: { ...summary },
  });
}

async function mapConcurrent(items, limit, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function enrichShowSummaries(results, mode = 'sub', { limit = 24, concurrency = 4 } = {}) {
  const normalizedMode = normalizeMode(mode);
  const targets = results.slice(0, limit);
  await mapConcurrent(targets, concurrency, async (show) => {
    if (!show?.id) return;
    try {
      const [page, episodes] = await Promise.all([
        getShowPage(show.id),
        listEpisodes(show.id).catch(() => []),
      ]);
      const episodeCount = episodes.length || Number(show.episodeCount) || 0;
      const name = preferredName(page) || show.name;
      Object.assign(show, {
        name,
        sourceName: page.sourceName || show.sourceName,
        englishName: page.englishName || show.englishName,
        nativeName: page.nativeName || show.nativeName,
        thumbnail: page.thumbnail || show.thumbnail,
        banner: page.banner || show.banner || page.thumbnail || show.thumbnail,
        thumbnails: page.thumbnails?.length ? page.thumbnails : show.thumbnails,
        genres: page.genres?.length ? page.genres : show.genres,
        score: page.score ?? show.score,
        type: page.type || show.type,
        status: page.status || show.status,
        airedStart: page.airedStart || show.airedStart,
        airedEnd: page.airedEnd || show.airedEnd,
        season: page.season || show.season,
        nextAiringEpisode: page.nextAiringEpisode || show.nextAiringEpisode,
        relatedShows: page.relatedShows?.length ? page.relatedShows : show.relatedShows,
        hasNextSeason: hasNextSeason(page.relatedShows || show.relatedShows || []),
        episodeCount,
        episodeCounts: episodeCount ? { [normalizedMode]: episodeCount } : {},
        latestEpisode: highestEpisode(episodes.map((item) => item.number)) || episodeCount || show.latestEpisode || null,
        title: episodeCount ? `${name} (${episodeCount} episodes)` : name,
        malId: page.malId || show.malId,
        provider: 'anidb',
      });
      writeSequelCache(show.id, normalizedMode, {
        id: show.id,
        name: show.name,
        status: show.status,
        episodeCount: show.episodeCount,
        latestEpisode: show.latestEpisode,
        mode: normalizedMode,
      });
    } catch {
      // Keep browse-card summary if enrichment fails.
    }
  });
  return results;
}

function browsePathForSort(sortBy) {
  const sort = String(sortBy || '').trim();
  if (!sort) return '';
  if (sort === 'Latest_Update' || sort === 'order_updated') return '/browse?sort=order_updated';
  if (sort === 'order_popular') return '/browse?sort=order_popular';
  if (sort === 'order_trending') return '/browse?sort=order_trending';
  if (sort === 'order_top') return '/browse?sort=order_top';
  if (sort === 'order_favorite') return '/browse?sort=order_favorite';
  if (sort === 'order_top_airing') return '/browse?sort=order_top_airing&status=Currently+Airing';
  return '';
}

function parseHomeChart(html, title) {
  const page = String(html || '');
  const escaped = String(title || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const headingRe = new RegExp(`<h3[^>]*>\\s*${escaped}\\s*<\\/h3>`, 'i');
  const start = page.search(headingRe);
  if (start < 0) return [];
  const after = page.slice(start);
  const end = after.slice(20).search(/<h3\b/i);
  const block = end >= 0 ? after.slice(0, end + 20) : after.slice(0, 120_000);
  return parseSearchResults(block);
}

function popularSourceForRange(range) {
  const value = String(range ?? '0').trim();
  if (value === '1') return { kind: 'chart', title: 'Top 10 Today' };
  if (value === '7') return { kind: 'chart', title: 'Top 10 This Week' };
  if (value === '30') return { kind: 'chart', title: 'Top 10 This Month' };
  return { kind: 'browse', path: '/browse?sort=order_popular' };
}

async function searchAnime(query, mode = 'sub', options = {}) {
  const q = String(query || '').trim();
  const sortPath = !q ? browsePathForSort(options.sortBy) : '';
  if (!q && !sortPath && !options.allowEmpty) return [];
  const path = q
    ? `/browse?q=${encodeURIComponent(q)}`
    : (sortPath || '/browse');
  const html = await fetchText(path);
  const parsedResults = parseSearchResults(html);
  const results = (options.filterRelevance === false ? parsedResults : relevantSearchResults(q, parsedResults))
    .map((item, index) => showSummaryFromSearch(item, index, mode));
  await enrichShowSummaries(results, mode);
  return enrichNextSeasons(results, mode);
}

async function popularAnime(range = '0', mode = 'sub') {
  const source = popularSourceForRange(range);
  let results = [];
  if (source.kind === 'chart') {
    const home = await fetchText('/home');
    results = parseHomeChart(home, source.title);
  }
  if (!results.length) {
    const path = source.kind === 'browse'
      ? source.path
      : '/browse?sort=order_trending';
    const html = await fetchText(path);
    results = parseSearchResults(html);
  }
  const summaries = results.map((item, index) => showSummaryFromSearch(item, index, mode));
  await enrichShowSummaries(summaries, mode);
  return enrichNextSeasons(summaries, mode);
}

async function listEpisodes(showId) {
  const numericId = numericAnimeId(showId);
  const raw = await fetchText(`/api/frontend/anime/${numericId}/episodes`);
  return parseEpisodeList(raw);
}

async function getShowPage(showId) {
  if (!isAnidbShowId(showId)) throw new Error(`Incomplete show details for ${showId}`);
  const html = await fetchText(`/anime/${encodeURIComponent(showId)}`);
  return parseShowPage(html, showId);
}

async function getShowSummaryById(id, mode = 'sub') {
  const page = await getShowPage(id);
  const episodes = await listEpisodes(id).catch(() => []);
  const episodeCount = episodes.length;
  const name = preferredName(page);
  const summary = {
    id: page.id,
    name,
    sourceName: page.sourceName,
    englishName: page.englishName,
    nativeName: page.nativeName,
    thumbnail: page.thumbnail,
    banner: page.banner,
    thumbnails: page.thumbnails,
    score: page.score,
    type: page.type,
    status: page.status,
    airedStart: page.airedStart,
    airedEnd: page.airedEnd,
    season: page.season,
    broadcastInterval: page.broadcastInterval,
    nextAiringEpisode: page.nextAiringEpisode,
    lastEpisodeDate: null,
    lastEpisodeTimestamp: null,
    franchiseKey: '',
    franchiseName: '',
    title: episodeCount ? `${name} (${episodeCount} episodes)` : name,
    episodeCount,
    episodeCounts: episodeCount ? { [normalizeMode(mode)]: episodeCount } : {},
    latestEpisode: highestEpisode(episodes.map((item) => item.number)) || episodeCount || null,
    mode: normalizeMode(mode),
    provider: 'anidb',
    malId: page.malId,
  };
  writeSequelCache(summary.id, mode, {
    id: summary.id,
    name: summary.name,
    status: summary.status,
    episodeCount: summary.episodeCount,
    latestEpisode: summary.latestEpisode,
    mode: summary.mode,
  });
  return summary;
}

async function resolveSequelSummaries(ids, mode = 'sub') {
  const unique = [...new Set((ids || []).map(String).filter(Boolean))];
  const byId = new Map();
  await mapConcurrent(unique, 3, async (id) => {
    const cached = readSequelCache(id, mode);
    if (cached) {
      byId.set(id, cached);
      return;
    }
    try {
      const summary = await getShowSummaryById(id, mode);
      byId.set(id, {
        id: summary.id,
        name: summary.name,
        status: summary.status,
        episodeCount: summary.episodeCount,
        latestEpisode: summary.latestEpisode,
        mode: summary.mode,
      });
    } catch {
      // leave missing
    }
  });
  return byId;
}

function pendingSequelLinks(results) {
  const pending = [];
  for (const show of results) {
    const sequel = normalizeRelatedShows(show.relatedShows)
      .find((relation) => relation.relation.toLowerCase() === 'sequel');
    if (sequel?.showId) pending.push({ showId: show.id, sequelId: sequel.showId, relation: sequel.relation });
  }
  return pending;
}

function applySequelMap(results, pending, byId) {
  const nextByShow = new Map();
  for (const match of pending) {
    const nextSeason = byId.get(match.sequelId);
    if (!nextSeason) continue;
    nextByShow.set(match.showId, { relation: match.relation, ...nextSeason });
  }
  return results.map((show) => {
    const nextSeason = nextByShow.get(show.id);
    if (!nextSeason) return show;
    return {
      ...show,
      hasNextSeason: true,
      nextSeason,
    };
  });
}

async function enrichNextSeasons(results, mode = 'sub') {
  const pending = pendingSequelLinks(results);
  if (!pending.length) return results;
  const uniqueIds = [...new Set(pending.map((item) => item.sequelId))];
  const byId = await resolveSequelSummaries(uniqueIds.slice(0, 8), mode);
  return applySequelMap(results, pending, byId);
}

async function getNextSeasonSummary(relatedShows, mode = 'sub') {
  const sequel = normalizeRelatedShows(relatedShows)
    .find((relation) => relation.relation.toLowerCase() === 'sequel');
  if (!sequel) return null;
  try {
    return {
      relation: sequel.relation,
      ...(await getShowSummaryById(sequel.showId, mode)),
    };
  } catch {
    return {
      relation: sequel.relation,
      id: sequel.showId,
      name: sequel.showId,
      title: sequel.showId,
      mode: normalizeMode(mode),
    };
  }
}

async function getRelatedShowSummaries(relatedShows, mode = 'sub') {
  const relations = normalizeRelatedShows(relatedShows).slice(0, 10);
  return mapConcurrent(relations, 3, async (relation) => {
    try {
      return {
        relation: relation.relation,
        ...(await getShowSummaryById(relation.showId, mode)),
      };
    } catch {
      return {
        relation: relation.relation,
        id: relation.showId,
        name: relation.showId,
        title: relation.showId,
        mode: normalizeMode(mode),
      };
    }
  });
}

async function getShowDetails(id, mode = 'sub', options = {}) {
  const page = await getShowPage(id);
  if (!page?.name) throw new Error(`Incomplete show details for ${id}`);
  const episodesMeta = await listEpisodes(id);
  const episodes = episodesMeta.map((item) => item.number).sort(compareEpisodes);
  const episodeCount = episodes.length;
  const name = preferredName(page);
  const episodeTitles = {};
  for (const item of episodesMeta) {
    if (item.title) episodeTitles[item.number] = item.title;
  }
  const details = {
    id,
    name,
    sourceName: page.sourceName,
    englishName: page.englishName,
    nativeName: page.nativeName,
    thumbnail: page.thumbnail,
    banner: page.banner,
    thumbnails: page.thumbnails,
    description: page.description,
    genres: page.genres,
    score: page.score,
    type: page.type,
    status: page.status,
    airedStart: page.airedStart,
    airedEnd: page.airedEnd,
    season: page.season,
    broadcastInterval: page.broadcastInterval,
    nextAiringEpisode: page.nextAiringEpisode,
    lastEpisodeDate: null,
    lastEpisodeTimestamp: null,
    franchiseKey: '',
    franchiseName: '',
    relatedShows: normalizeRelatedShows(page.relatedShows),
    title: `${name} (${episodeCount} episodes)`,
    episodeCount,
    episodeCounts: episodeCount ? { [normalizeMode(mode)]: episodeCount } : {},
    episodeTitles,
    episodeDates: {},
    episodes,
    latestEpisode: highestEpisode(episodes),
    mode: normalizeMode(mode),
    provider: 'anidb',
    malId: page.malId,
    episodeMap: Object.fromEntries(episodesMeta.map((item) => [item.number, item.id])),
  };
  if (options.includeRelations) {
    details.relations = await getRelatedShowSummaries(page.relatedShows, mode);
    details.nextSeason = details.relations.find((relation) => relation.relation.toLowerCase() === 'sequel') || null;
  } else if (options.includeNextSeason) {
    details.nextSeason = await getNextSeasonSummary(page.relatedShows, mode);
  }
  return details;
}

async function getCachedShowDetails(state, id, mode = 'sub', options = {}) {
  const flavor = options.includeRelations ? 'relations' : options.includeNextSeason ? 'next' : 'base';
  const key = `${normalizeMode(mode)}:${flavor}:${id}`;
  if (!options.force) {
    const cached = cacheGet(state, 'details', key, DETAIL_CACHE_TTL_MS);
    if (cached) return cached;
  }
  const details = await getShowDetails(id, mode, options);
  cacheSet(state, 'details', key, details);
  trimCache(state, 'details', 160);
  return details;
}

function genreWeights(shows) {
  const weights = new Map();
  for (const show of shows) {
    const progressBoost = Number(show.watchedCount || 0) > 0 || show.lastWatched ? 1 : 0;
    for (const genre of show.genres || []) {
      const key = String(genre || '').trim();
      if (!key) continue;
      weights.set(key, (weights.get(key) || 0) + 2 + progressBoost);
    }
  }
  return weights;
}

function recommendationScore(show, weights) {
  const matches = (show.genres || [])
    .map((genre) => ({ genre, weight: weights.get(genre) || 0 }))
    .filter((match) => match.weight > 0)
    .sort((a, b) => b.weight - a.weight);
  const score = matches.reduce((total, match) => total + match.weight, 0) + Number(show.score || 0) / 10;
  return {
    score,
    reason: matches.slice(0, 2).map((match) => match.genre).join(' + '),
  };
}

async function recommendedAnime(state, mode = 'sub') {
  const library = require('./library');
  const key = normalizeMode(mode);
  const cached = cacheGet(state, 'recommendations', key, RECOMMENDATION_CACHE_TTL_MS);
  if (cached) return cached;

  const tracked = Object.values(state.shows).filter((show) => show.tracked !== false);
  const trackedIds = new Set(tracked.map((show) => show.id));
  const libraryDetails = await mapConcurrent(tracked.slice(0, 30), 3, async (show) => {
    try {
      return {
        ...show,
        ...(await getCachedShowDetails(state, show.id, show.mode || mode)),
      };
    } catch {
      return show;
    }
  });
  const weights = genreWeights(libraryDetails.map((show) => library.presentShow(show)));
  const popular = await popularAnime('0', mode);
  const ranked = [];
  for (const candidate of popular) {
    if (trackedIds.has(candidate.id)) continue;
    let details = candidate;
    try {
      details = {
        ...candidate,
        ...(await getCachedShowDetails(state, candidate.id, mode)),
      };
    } catch {
      // keep summary
    }
    const { score, reason } = recommendationScore(details, weights);
    ranked.push({
      ...details,
      recommendationScore: score,
      recommendationReason: reason || 'Popular with anime viewers',
    });
  }
  ranked.sort((a, b) => b.recommendationScore - a.recommendationScore);
  const result = ranked
    .slice(0, 24)
    .map((candidate, index) => ({
      ...candidate,
      index: index + 1,
      recommendationReason: candidate.recommendationReason || 'Popular with anime viewers',
    }));
  cacheSet(state, 'recommendations', key, result);
  trimCache(state, 'recommendations', 8);
  return result;
}

function setRawFetcher(fn) {
  sequelSummaryCache.clear();
  setAnidbTextFetcherForTests(fn ? async (url) => fn(url) : null);
}

module.exports = {
  ANIDB_ORIGIN,
  isAnidbShowId,
  numericAnimeId,
  parseSearchResults,
  normalizeSearchTitle,
  animeTitleScore,
  relevantSearchResults,
  parseEpisodeList,
  parseLanguageSources,
  parseEmbedMaster,
  parseM3u8Qualities,
  parseShowPage,
  parseSeasons,
  parseHomeChart,
  normalizeProviderStatus,
  popularSourceForRange,
  enrichShowSummaries,
  searchAnime,
  popularAnime,
  listEpisodes,
  getShowDetails,
  getCachedShowDetails,
  recommendedAnime,
  resolveSequelSummaries,
  hasNextSeason,
  normalizeRelatedShows,
  showSummaryFromSearch,
  setRawFetcher,
  setAnidbTextFetcherForTests,
};
