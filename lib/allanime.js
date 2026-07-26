'use strict';

const crypto = require('crypto');
const {
  ALLANIME_API,
  ALLANIME_REFERER,
  USER_AGENT,
  DETAIL_CACHE_TTL_MS,
  RECOMMENDATION_CACHE_TTL_MS,
} = require('./config');
const {
  preferredName,
  normalizeMode,
  normalizeEpisode,
  compareEpisodes,
  highestEpisode,
} = require('./episodes');
const { cacheGet, cacheSet, trimCache } = require('./state');
const { fetchWithTimeout } = require('./upstream');

async function fetchAllAnimeRaw(query, variables) {
  const response = await fetchWithTimeout(fetch, ALLANIME_API, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'user-agent': USER_AGENT,
      referer: ALLANIME_REFERER,
      origin: ALLANIME_REFERER,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!response.ok) throw new Error(`AllAnime API returned ${response.status}`);
  return response.text();
}

// Swappable transport so tests can feed canned GraphQL payloads without network.
let rawFetcher = fetchAllAnimeRaw;

function setRawFetcher(fn) {
  sequelSummaryCache.clear();
  rawFetcher = fn || fetchAllAnimeRaw;
}

async function graphql(query, variables) {
  const result = processAllAnimeResponse(await rawFetcher(query, variables));
  if (result?.errors?.length) {
    throw new Error(result.errors.map((error) => error.message).filter(Boolean).join('; ') || 'AllAnime GraphQL error');
  }
  return result;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryDelay(error, attempt) {
  const seconds = Number(String(error?.message || '').match(/try again in\s+(\d+)\s+seconds?/i)?.[1]);
  if (Number.isFinite(seconds) && seconds > 0) return (seconds * 1000) + 150;
  return 150 * (attempt + 1);
}

async function fetchShowWithRetry(query, id, attempts = 4) {
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const json = await graphql(query, { showId: id });
      const show = json?.data?.show;
      if (show?._id && (show.name || show.englishName || show.nativeName)) return show;
      lastError = new Error(`Incomplete show details for ${id}`);
    } catch (err) {
      lastError = err;
    }
    if (attempt < attempts - 1) await wait(retryDelay(lastError, attempt));
  }
  throw lastError || new Error(`Could not fetch show details for ${id}`);
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

function availableEpisodeCounts(value) {
  const counts = value || {};
  return Object.fromEntries(
    ['sub', 'dub']
      .map((mode) => [mode, Number(counts[mode] || 0)])
      .filter(([, count]) => count > 0)
  );
}

function processAllAnimeResponse(raw) {
  const parsed = JSON.parse(raw);
  if (!parsed.tobeparsed) return parsed;

  const key = crypto.createHash('sha256').update('Xot36i3lK3:v1').digest();
  const data = Buffer.from(parsed.tobeparsed, 'base64');
  const iv = data.subarray(1, 13);
  const payload = data.subarray(13, data.length - 16);
  const counter = Buffer.concat([iv, Buffer.from([0, 0, 0, 2])]);
  const decipher = crypto.createDecipheriv('aes-256-ctr', key, counter);
  const plain = Buffer.concat([decipher.update(payload), decipher.final()]).toString('utf8');
  return JSON.parse(plain);
}

async function searchAnime(query, mode = 'sub', options = {}) {
  const q = String(query || '').trim();
  const genres = (Array.isArray(options.genres) ? options.genres : [options.genre])
    .map((genre) => String(genre || '').trim())
    .filter(Boolean);
  const year = Number(options.year);
  const validYear = Number.isInteger(year) && year >= 1917 && year <= 2100 ? year : null;
  const sortBy = String(options.sortBy || options.sort || '').trim();
  const allowEmpty = Boolean(sortBy) || options.allowEmpty;
  if (!q && !genres.length && !validYear && !allowEmpty) return [];
  const searchQuery = 'query( $search: SearchInput $limit: Int $page: Int $translationType: VaildTranslationTypeEnumType $countryOrigin: VaildCountryOriginEnumType ) { shows( search: $search limit: $limit page: $page translationType: $translationType countryOrigin: $countryOrigin ) { edges { _id name englishName nativeName thumbnail banner thumbnails genres status airedStart airedEnd season broadcastInterval nextAiringEpisode lastEpisodeDate lastEpisodeTimestamp availableEpisodes relatedShows __typename } }}';
  const json = await graphql(searchQuery, {
    search: {
      allowAdult: false,
      allowUnknown: false,
      ...(q ? { query: q } : {}),
      ...(genres.length ? { genres, includeGenres: true } : {}),
      ...(validYear ? { year: validYear } : {}),
      ...(sortBy ? { sortBy, sortDirection: 'DSC' } : {}),
    },
    limit: 40,
    page: 1,
    translationType: normalizeMode(mode),
    countryOrigin: 'ALL',
  });
  const edges = json?.data?.shows?.edges || [];
  const results = edges
    .map((edge, index) => showSummary(edge, index, mode))
    .filter((show) => show.id && show.episodeCount);
  return enrichNextSeasons(results, mode);
}

async function popularAnime(range = '0', mode = 'sub') {
  const dateRange = Number(range);
  const popularQuery = 'query($type: VaildPopularTypeEnumType!, $size: Int!, $page: Int, $dateRange: Int) { queryPopular(type: $type, size: $size, page: $page, dateRange: $dateRange, allowAdult: false, allowUnknown: false, denyEcchi: true) { recommendations { anyCard { _id name englishName nativeName thumbnail banner thumbnails availableEpisodes episodeCount score popularity type status airedStart airedEnd season broadcastInterval nextAiringEpisode lastEpisodeDate lastEpisodeTimestamp relatedShows } } } }';
  const json = await graphql(popularQuery, {
    type: 'anime',
    size: 40,
    page: 1,
    dateRange: Number.isFinite(dateRange) ? dateRange : 0,
  });
  const cards = (json?.data?.queryPopular?.recommendations || [])
    .map((item) => item.anyCard)
    .filter(Boolean);
  const results = cards
    .map((card, index) => showSummary(card, index, mode))
    .filter((show) => show.id && show.episodeCount);
  return enrichNextSeasons(results, mode);
}

function mergeSequelSummaries(byId, ids, data, mode) {
  const normalizedMode = normalizeMode(mode);
  ids.forEach((id, index) => {
    if (byId.has(id)) return;
    const show = data?.[`s${index}`];
    if (!show?._id) return;
    const episodeCounts = availableEpisodeCounts(show.availableEpisodes);
    const episodeCount = episodeCounts[normalizedMode] || Number(show.episodeCount) || 0;
    const summary = {
      id: show._id,
      name: preferredName(show),
      status: show.status || '',
      episodeCount,
      latestEpisode: episodeCount || null,
      mode: normalizedMode,
    };
    byId.set(id, summary);
    writeSequelCache(id, normalizedMode, summary);
  });
}

const SEQUEL_SUMMARY_TTL_MS = 6 * 60 * 60 * 1000;
const sequelSummaryCache = new Map();

function sequelCacheKey(mode, id) {
  return `${normalizeMode(mode)}:${id}`;
}

function readSequelCache(id, mode = 'sub') {
  const key = sequelCacheKey(mode, id);
  const hit = sequelSummaryCache.get(key);
  if (!hit) return null;
  if (hit.expiresAt <= Date.now()) {
    sequelSummaryCache.delete(key);
    return null;
  }
  return hit.summary;
}

function writeSequelCache(id, mode, summary) {
  if (!summary?.id) return;
  sequelSummaryCache.set(sequelCacheKey(mode, id), {
    summary,
    expiresAt: Date.now() + SEQUEL_SUMMARY_TTL_MS,
  });
}

function pendingSequelLinks(results) {
  const pending = [];
  for (const show of results) {
    if (show?.nextSeason?.status || !show?.hasNextSeason) continue;
    const sequel = normalizeRelatedShows(show.relatedShows)
      .find((relation) => relation.relation.toLowerCase() === 'sequel');
    if (sequel?.showId) pending.push({ showId: show.id, sequelId: sequel.showId, relation: sequel.relation });
  }
  return pending;
}

function applySequelMap(results, pending, byId) {
  if (!pending.length || !byId.size) return results;
  return results.map((show) => {
    const match = pending.find((item) => item.showId === show.id);
    if (!match) return show;
    const nextSeason = byId.get(match.sequelId);
    if (!nextSeason) return show;
    return {
      ...show,
      hasNextSeason: true,
      nextSeason: { ...nextSeason, relation: match.relation },
    };
  });
}

async function softFetchSequelSummaries(ids, mode = 'sub', options = {}) {
  const byId = new Map();
  if (!ids.length) return byId;
  const chunkSize = Number(options.chunkSize) > 0 ? Number(options.chunkSize) : 5;
  const maxChunks = Number(options.maxChunks) > 0 ? Number(options.maxChunks) : Infinity;
  const pauseOnLimit = options.pauseOnLimit !== false;
  let chunksDone = 0;
  for (let offset = 0; offset < ids.length; offset += chunkSize) {
    if (chunksDone >= maxChunks) break;
    const chunk = ids.slice(offset, offset + chunkSize);
    const fields = chunk.map((id, index) => (
      `s${index}: show(_id: ${JSON.stringify(id)}) { _id name englishName status availableEpisodes episodeCount }`
    )).join('\n');
    let rateLimited = false;
    try {
      // Soft-parse: keep successes even when upstream rate-limits sibling fields.
      const payload = processAllAnimeResponse(await rawFetcher(`query { ${fields} }`, {}));
      mergeSequelSummaries(byId, chunk, payload?.data || {}, mode);
      const message = (payload?.errors || []).map((error) => error.message).join(' ');
      rateLimited = /too many requests|try again/i.test(message);
      if (rateLimited && pauseOnLimit) {
        await wait(Math.min(retryDelay({ message }, 0), 10_000));
      }
    } catch {}
    chunksDone += 1;
    if (!rateLimited && offset + chunkSize < ids.length && chunksDone < maxChunks) {
      await wait(150);
    }
  }
  return byId;
}

async function fetchShowSummaryLight(id, mode = 'sub') {
  const normalizedMode = normalizeMode(mode);
  const summaryQuery = 'query ($showId: String!) { show( _id: $showId ) { _id name englishName status availableEpisodes episodeCount } }';
  try {
    const payload = processAllAnimeResponse(await rawFetcher(summaryQuery, { showId: id }));
    const show = payload?.data?.show;
    if (!show?._id) return null;
    const episodeCounts = availableEpisodeCounts(show.availableEpisodes);
    const episodeCount = episodeCounts[normalizedMode] || Number(show.episodeCount) || 0;
    const summary = {
      id: show._id,
      name: preferredName(show),
      status: show.status || '',
      episodeCount,
      latestEpisode: episodeCount || null,
      mode: normalizedMode,
    };
    writeSequelCache(id, normalizedMode, summary);
    return summary;
  } catch {
    return null;
  }
}

async function resolveSequelSummaries(ids, mode = 'sub') {
  const uniqueIds = [...new Set((Array.isArray(ids) ? ids : []).map((id) => String(id || '').trim()).filter(Boolean))];
  const byId = new Map();
  const missing = [];
  for (const id of uniqueIds) {
    const cached = readSequelCache(id, mode);
    if (cached) byId.set(id, cached);
    else missing.push(id);
  }
  if (missing.length) {
    const soft = await softFetchSequelSummaries(missing, mode, { pauseOnLimit: true });
    soft.forEach((summary, id) => byId.set(id, summary));
  }
  const stillMissing = uniqueIds.filter((id) => !byId.has(id));
  // One attempt each — Discover hydrates in small batches with pauses between calls.
  if (stillMissing.length) {
    for (const id of stillMissing) {
      const summary = await fetchShowSummaryLight(id, mode);
      if (summary?.id) {
        byId.set(id, summary);
        continue;
      }
      await wait(1200);
    }
  }
  return byId;
}

async function enrichNextSeasons(results, mode = 'sub') {
  const pending = pendingSequelLinks(results);
  if (!pending.length) return results;

  const uniqueIds = [...new Set(pending.map((item) => item.sequelId))];
  const byId = new Map();
  const missing = [];
  for (const id of uniqueIds) {
    const cached = readSequelCache(id, mode);
    if (cached) byId.set(id, cached);
    else missing.push(id);
  }

  // Quick first-pass only so Popular stays snappy; progressive /api/sequels fills the rest.
  if (missing.length) {
    const soft = await softFetchSequelSummaries(missing, mode, {
      maxChunks: 2,
      pauseOnLimit: false,
    });
    soft.forEach((summary, id) => byId.set(id, summary));
  }

  return applySequelMap(results, pending, byId);
}

function showSummary(edge, index, mode = 'sub') {
  const episodeCounts = availableEpisodeCounts(edge.availableEpisodes);
  const episodeCount = episodeCounts[normalizeMode(mode)] || edge.episodeCount || 0;
  const normalizedMode = normalizeMode(mode);
  const name = preferredName(edge);
  const relatedShows = normalizeRelatedShows(edge.relatedShows);
  return {
    index: index + 1,
    id: edge._id,
    name,
    sourceName: edge.name,
    englishName: edge.englishName,
    nativeName: edge.nativeName,
    thumbnail: edge.thumbnail || edge.thumbnails?.[0] || '',
    banner: edge.banner || '',
    thumbnails: edge.thumbnails || [],
    genres: edge.genres || [],
    score: edge.score || null,
    popularity: edge.popularity || null,
    type: edge.type || '',
    status: edge.status || '',
    airedStart: edge.airedStart || null,
    airedEnd: edge.airedEnd || null,
    season: edge.season || null,
    broadcastInterval: edge.broadcastInterval || null,
    nextAiringEpisode: edge.nextAiringEpisode || null,
    lastEpisodeDate: edge.lastEpisodeDate?.[normalizedMode] || null,
    lastEpisodeTimestamp: edge.lastEpisodeTimestamp?.[normalizedMode] || null,
    relatedShows,
    hasNextSeason: hasNextSeason(relatedShows),
    title: `${name} (${episodeCount} episodes)`,
    episodeCount,
    episodeCounts,
    mode: normalizedMode,
  };
}

async function getShowSummaryById(id, mode = 'sub') {
  const summaryQuery = 'query ($showId: String!) { show( _id: $showId ) { _id name englishName nativeName thumbnail banner thumbnails score type status airedStart airedEnd season broadcastInterval nextAiringEpisode lastEpisodeDate lastEpisodeTimestamp availableEpisodes episodeCount franchiseKey franchiseName }}';
  const show = await fetchShowWithRetry(summaryQuery, id);
  const normalizedMode = normalizeMode(mode);
  const episodeCounts = availableEpisodeCounts(show.availableEpisodes);
  const episodeCount = episodeCounts[normalizedMode] || show.episodeCount || 0;
  const name = preferredName(show);
  const summary = {
    id: show._id || id,
    name,
    sourceName: show.name,
    englishName: show.englishName,
    nativeName: show.nativeName,
    thumbnail: show.thumbnail || show.thumbnails?.[0] || '',
    banner: show.banner || '',
    thumbnails: show.thumbnails || [],
    score: show.score || null,
    type: show.type || '',
    status: show.status || '',
    airedStart: show.airedStart || null,
    airedEnd: show.airedEnd || null,
    season: show.season || null,
    broadcastInterval: show.broadcastInterval || null,
    nextAiringEpisode: show.nextAiringEpisode || null,
    lastEpisodeDate: show.lastEpisodeDate?.[normalizedMode] || null,
    lastEpisodeTimestamp: show.lastEpisodeTimestamp?.[normalizedMode] || null,
    franchiseKey: show.franchiseKey || '',
    franchiseName: show.franchiseName || '',
    title: episodeCount ? `${name} (${episodeCount} episodes)` : name,
    episodeCount,
    episodeCounts,
    latestEpisode: episodeCount || null,
    mode: normalizedMode,
  };
  writeSequelCache(summary.id, normalizedMode, {
    id: summary.id,
    name: summary.name,
    status: summary.status,
    episodeCount: summary.episodeCount,
    latestEpisode: summary.latestEpisode,
    mode: summary.mode,
  });
  return summary;
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

async function getEpisodeMetadata(showId, episodes, mode = 'sub') {
  const numericEpisodes = episodes
    .map((episode) => Number(episode))
    .filter((episode) => Number.isFinite(episode));
  if (!showId || !numericEpisodes.length) return { episodeDates: {}, episodeTitles: {} };

  const start = Math.min(...numericEpisodes);
  const end = Math.max(...numericEpisodes);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end - start > 1500) {
    return { episodeDates: {}, episodeTitles: {} };
  }

  try {
    const query = 'query($showId:String!, $episodeNumStart:Float!, $episodeNumEnd:Float!){ episodeInfos(showId:$showId, episodeNumStart:$episodeNumStart, episodeNumEnd:$episodeNumEnd){ notes uploadDates episodeIdNum } }';
    const json = await graphql(query, { showId, episodeNumStart: start, episodeNumEnd: end });
    const episodeDates = {};
    const episodeTitles = {};
    for (const info of json?.data?.episodeInfos || []) {
      const episode = normalizeEpisode(info.episodeIdNum);
      if (!episode) continue;
      const uploadedAt = info.uploadDates?.[normalizeMode(mode)] || info.uploadDates?.sub || info.uploadDates?.dub || null;
      if (uploadedAt) episodeDates[episode] = uploadedAt;
      if (info.notes) episodeTitles[episode] = String(info.notes).split('<note-split>')[0].trim();
    }
    return { episodeDates, episodeTitles };
  } catch {
    return { episodeDates: {}, episodeTitles: {} };
  }
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
  return mapConcurrent(relations, 4, async (relation) => {
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
  const episodesQuery = 'query ($showId: String!) { show( _id: $showId ) { _id name englishName nativeName thumbnail banner thumbnails description genres score type status airedStart airedEnd season broadcastInterval nextAiringEpisode lastEpisodeDate lastEpisodeTimestamp availableEpisodes availableEpisodesDetail lastEpisodeInfo franchiseKey franchiseName relatedShows }}';
  const show = await fetchShowWithRetry(episodesQuery, id);
  const normalizedMode = normalizeMode(mode);
  const episodeCounts = availableEpisodeCounts(show.availableEpisodes);
  const list = show.availableEpisodesDetail?.[normalizedMode] || [];
  const episodes = list.map(String).sort(compareEpisodes);
  const episodeCount = episodeCounts[normalizedMode] || episodes.length;
  const name = preferredName(show);
  const lastInfo = show.lastEpisodeInfo?.[normalizedMode] || show.lastEpisodeInfo?.sub || {};
  const episodeMetadata = await getEpisodeMetadata(id, episodes, normalizedMode);
  const episodeTitles = { ...episodeMetadata.episodeTitles };
  if (lastInfo.episodeString && lastInfo.notes) {
    episodeTitles[normalizeEpisode(lastInfo.episodeString)] = String(lastInfo.notes).split('<note-split>')[0].trim();
  }
  const details = {
    id,
    name,
    sourceName: show.name,
    englishName: show.englishName,
    nativeName: show.nativeName,
    thumbnail: show.thumbnail || show.thumbnails?.[0] || '',
    banner: show.banner || '',
    thumbnails: show.thumbnails || [],
    description: show.description || '',
    genres: show.genres || [],
    score: show.score || null,
    type: show.type || '',
    status: show.status || '',
    airedStart: show.airedStart || null,
    airedEnd: show.airedEnd || null,
    season: show.season || null,
    broadcastInterval: show.broadcastInterval || null,
    nextAiringEpisode: show.nextAiringEpisode || null,
    lastEpisodeDate: show.lastEpisodeDate?.[normalizedMode] || null,
    lastEpisodeTimestamp: show.lastEpisodeTimestamp?.[normalizedMode] || null,
    franchiseKey: show.franchiseKey || '',
    franchiseName: show.franchiseName || '',
    relatedShows: normalizeRelatedShows(show.relatedShows),
    title: `${name} (${episodeCount} episodes)`,
    episodeCount,
    episodeCounts,
    episodeTitles,
    episodeDates: episodeMetadata.episodeDates,
    episodes,
    latestEpisode: highestEpisode(episodes),
  };
  if (options.includeRelations) {
    details.relations = await getRelatedShowSummaries(show.relatedShows, mode);
    details.nextSeason = details.relations.find((relation) => relation.relation.toLowerCase() === 'sequel') || null;
  } else if (options.includeNextSeason) {
    details.nextSeason = await getNextSeasonSummary(show.relatedShows, mode);
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
  const libraryDetails = await mapConcurrent(tracked.slice(0, 30), 4, async (show) => {
    try {
      return {
        ...library.presentShow(show),
        ...(await getCachedShowDetails(state, show.id, show.mode || mode)),
      };
    } catch {
      return library.presentShow(show);
    }
  });

  const weights = genreWeights(libraryDetails);
  const candidateMap = new Map();
  for (const range of ['0', '1', '7', '30']) {
    const results = await popularAnime(range, mode);
    for (const result of results.slice(0, 16)) {
      if (!trackedIds.has(result.id) && !candidateMap.has(result.id)) candidateMap.set(result.id, result);
    }
  }

  const candidates = await mapConcurrent(Array.from(candidateMap.values()).slice(0, 48), 4, async (candidate) => {
    try {
      return {
        ...candidate,
        ...(await getCachedShowDetails(state, candidate.id, mode)),
      };
    } catch {
      return candidate;
    }
  });

  const ranked = candidates
    .map((candidate) => {
      const rankedCandidate = recommendationScore(candidate, weights);
      return {
        ...candidate,
        recommendationScore: rankedCandidate.score,
        recommendationReason: rankedCandidate.reason,
      };
    })
    .sort((a, b) => (b.recommendationScore - a.recommendationScore) || Number(b.score || 0) - Number(a.score || 0))
    .slice(0, 24)
    .map((candidate, index) => ({
      ...candidate,
      index: index + 1,
      recommendationReason: candidate.recommendationReason || 'Popular with anime viewers',
    }));

  cacheSet(state, 'recommendations', key, ranked);
  trimCache(state, 'recommendations', 8);
  return ranked;
}

module.exports = {
  searchAnime,
  popularAnime,
  getShowDetails,
  getCachedShowDetails,
  recommendedAnime,
  resolveSequelSummaries,
  hasNextSeason,
  normalizeRelatedShows,
  showSummary,
  processAllAnimeResponse,
  setRawFetcher,
};
