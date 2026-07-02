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

async function fetchAllAnimeRaw(query, variables) {
  const response = await fetch(ALLANIME_API, {
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
  rawFetcher = fn || fetchAllAnimeRaw;
}

async function graphql(query, variables) {
  return processAllAnimeResponse(await rawFetcher(query, variables));
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

async function searchAnime(query, mode = 'sub') {
  const q = String(query || '').trim();
  if (!q) return [];
  const searchQuery = 'query( $search: SearchInput $limit: Int $page: Int $translationType: VaildTranslationTypeEnumType $countryOrigin: VaildCountryOriginEnumType ) { shows( search: $search limit: $limit page: $page translationType: $translationType countryOrigin: $countryOrigin ) { edges { _id name englishName nativeName thumbnail banner thumbnails availableEpisodes relatedShows __typename } }}';
  const json = await graphql(searchQuery, {
    search: { allowAdult: false, allowUnknown: false, query: q },
    limit: 40,
    page: 1,
    translationType: normalizeMode(mode),
    countryOrigin: 'ALL',
  });
  const edges = json?.data?.shows?.edges || [];
  return edges
    .map((edge, index) => showSummary(edge, index, mode))
    .filter((show) => show.id && show.episodeCount);
}

async function popularAnime(range = '0', mode = 'sub') {
  const dateRange = Number(range);
  const popularQuery = 'query($type: VaildPopularTypeEnumType!, $size: Int!, $page: Int, $dateRange: Int) { queryPopular(type: $type, size: $size, page: $page, dateRange: $dateRange, allowAdult: false, allowUnknown: false, denyEcchi: true) { recommendations { anyCard { _id name englishName nativeName thumbnail banner thumbnails availableEpisodes episodeCount score popularity type status relatedShows } } } }';
  const json = await graphql(popularQuery, {
    type: 'anime',
    size: 40,
    page: 1,
    dateRange: Number.isFinite(dateRange) ? dateRange : 0,
  });
  const cards = (json?.data?.queryPopular?.recommendations || [])
    .map((item) => item.anyCard)
    .filter(Boolean);
  return cards
    .map((card, index) => showSummary(card, index, mode))
    .filter((show) => show.id && show.episodeCount);
}

function showSummary(edge, index, mode = 'sub') {
  const episodeCount = edge.availableEpisodes?.[normalizeMode(mode)] || edge.episodeCount || 0;
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
    score: edge.score || null,
    popularity: edge.popularity || null,
    type: edge.type || '',
    status: edge.status || '',
    relatedShows,
    hasNextSeason: hasNextSeason(relatedShows),
    title: `${name} (${episodeCount} episodes)`,
    episodeCount,
    mode: normalizeMode(mode),
  };
}

async function getShowSummaryById(id, mode = 'sub') {
  const summaryQuery = 'query ($showId: String!) { show( _id: $showId ) { _id name englishName nativeName thumbnail banner thumbnails score type status availableEpisodes episodeCount franchiseKey franchiseName }}';
  const json = await graphql(summaryQuery, { showId: id });
  const show = json?.data?.show || {};
  const episodeCount = show.availableEpisodes?.[normalizeMode(mode)] || show.episodeCount || 0;
  const name = preferredName(show);
  return {
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
    franchiseKey: show.franchiseKey || '',
    franchiseName: show.franchiseName || '',
    title: episodeCount ? `${name} (${episodeCount} episodes)` : name,
    episodeCount,
    latestEpisode: episodeCount || null,
    mode: normalizeMode(mode),
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
  const summaries = [];
  for (const relation of normalizeRelatedShows(relatedShows).slice(0, 10)) {
    try {
      summaries.push({
        relation: relation.relation,
        ...(await getShowSummaryById(relation.showId, mode)),
      });
    } catch {
      summaries.push({
        relation: relation.relation,
        id: relation.showId,
        name: relation.showId,
        title: relation.showId,
        mode: normalizeMode(mode),
      });
    }
  }
  return summaries;
}

async function getShowDetails(id, mode = 'sub', options = {}) {
  const episodesQuery = 'query ($showId: String!) { show( _id: $showId ) { _id name englishName nativeName thumbnail banner thumbnails description genres score type status availableEpisodes availableEpisodesDetail lastEpisodeInfo franchiseKey franchiseName relatedShows }}';
  const json = await graphql(episodesQuery, { showId: id });
  const show = json?.data?.show || {};
  const list = show.availableEpisodesDetail?.[normalizeMode(mode)] || [];
  const episodes = list.map(String).sort(compareEpisodes);
  const episodeCount = show.availableEpisodes?.[normalizeMode(mode)] || episodes.length;
  const name = preferredName(show);
  const lastInfo = show.lastEpisodeInfo?.[normalizeMode(mode)] || show.lastEpisodeInfo?.sub || show.lastEpisodeInfo?.raw || {};
  const episodeTitles = {};
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
    franchiseKey: show.franchiseKey || '',
    franchiseName: show.franchiseName || '',
    relatedShows: normalizeRelatedShows(show.relatedShows),
    title: `${name} (${episodeCount} episodes)`,
    episodeCount,
    episodeTitles,
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

  library.seedStateFromHistory(state);
  const tracked = Object.values(state.shows).filter((show) => show.tracked !== false);
  const trackedIds = new Set(tracked.map((show) => show.id));
  const libraryDetails = [];
  for (const show of tracked.slice(0, 30)) {
    try {
      libraryDetails.push({
        ...library.presentShow(show),
        ...(await getCachedShowDetails(state, show.id, show.mode || mode)),
      });
    } catch {
      libraryDetails.push(library.presentShow(show));
    }
  }

  const weights = genreWeights(libraryDetails);
  const candidateMap = new Map();
  for (const range of ['0', '1', '7', '30']) {
    const results = await popularAnime(range, mode);
    for (const result of results.slice(0, 16)) {
      if (!trackedIds.has(result.id) && !candidateMap.has(result.id)) candidateMap.set(result.id, result);
    }
  }

  const candidates = [];
  for (const candidate of Array.from(candidateMap.values()).slice(0, 48)) {
    try {
      candidates.push({
        ...candidate,
        ...(await getCachedShowDetails(state, candidate.id, mode)),
      });
    } catch {
      candidates.push(candidate);
    }
  }

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
  hasNextSeason,
  normalizeRelatedShows,
  showSummary,
  processAllAnimeResponse,
  setRawFetcher,
};
