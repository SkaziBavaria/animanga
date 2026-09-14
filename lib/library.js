'use strict';

const crypto = require('crypto');
const {
  cleanTitle,
  preferredName,
  normalizeMode,
  highestEpisode,
  alignWatchedEpisodesToList,
  episodeListForWatchAlignment,
} = require('./episodes');
const { resolvedTitleMatchesAny } = require('./title-match');
const animeProvider = require('./anime-provider');
const {
  applyAnimeCatalogMapping,
  catalogIdFromItem,
  catalogFieldsFromClient,
  hasAnimeCatalogMapping,
} = require('./library-identity');

const PRESERVED_DETAIL_FIELDS = new Set([
  'name', 'sourceName', 'englishName', 'nativeName', 'title', 'thumbnail', 'banner',
  'thumbnails', 'description', 'genres', 'score', 'type', 'rating', 'sourceQuality', 'status', 'airedStart',
  'airedEnd', 'season', 'broadcastInterval', 'franchiseKey', 'franchiseName',
  'relatedShows', 'relations', 'nextSeason', 'hasNextSeason', 'episodeTitles', 'episodeDates', 'episodes', 'episodeCount', 'latestEpisode', 'episodeCounts', 'lastActivityAt', 'malId',
]);

const SEARCH_STOP_WORDS = new Set(['a', 'an', 'and', 'of', 'on', 'the', 'to']);

function normalizeSearchTitle(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function catalogTitleScore(query, candidate) {
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

function isEmptyDetail(value) {
  if (value === null || value === undefined || value === '') return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value).length === 0;
  return false;
}

function preserveExistingDetails(existing, partial) {
  return Object.fromEntries(Object.entries(partial).map(([key, value]) => {
    const oldValue = existing[key];
    const emptyEpisodeCount = key === 'episodeCount' && Number(value) === 0 && Number(oldValue) > 0;
    const emptyGeneratedTitle = key === 'title' && /^\s*\(0 episodes?\)\s*$/i.test(String(value || ''));
    if (PRESERVED_DETAIL_FIELDS.has(key) && oldValue !== undefined && (isEmptyDetail(value) || emptyEpisodeCount || emptyGeneratedTitle)) {
      return [key, oldValue];
    }
    return [key, value];
  }));
}

function assertSafeShowRefresh(existing, details) {
  if (!details || details.id !== existing.id) throw new Error('Anime refresh returned the wrong identity');
  const candidate = details.sourceName || details.englishName || details.name || details.title;
  const knownNames = [existing.sourceName, existing.englishName, existing.nativeName, existing.name, existing.title].filter(Boolean);
  if (!candidate || !knownNames.length || !resolvedTitleMatchesAny(candidate, knownNames)) {
    throw new Error('Anime refresh returned mismatched or invalid metadata');
  }
  if (!details.thumbnail && !details.banner && !Number(details.episodeCount || details.latestEpisode)) {
    throw new Error('Anime refresh returned incomplete metadata');
  }
  return details;
}

function pickAvailableMode(partial, existing, fallback) {
  const requested = normalizeMode(partial.mode || existing.mode || fallback);
  const counts = partial.episodeCounts || existing.episodeCounts || {};
  const hasCounts = Object.values(counts).some((value) => Number(value) > 0);
  if (!hasCounts || Number(counts[requested] || 0) > 0) return requested;
  if (Number(counts.sub || 0) > 0) return 'sub';
  if (Number(counts.dub || 0) > 0) return 'dub';
  return requested;
}

function mergeShow(state, partial, options = {}) {
  if (!partial.id) throw new Error('Missing show id');
  const id = partial.id;
  const existing = state.shows[id] || {};
  const rawPartial = { ...partial };
  delete rawPartial.index;
  const partialWithoutBrowseIndex = preserveExistingDetails(existing, rawPartial);
  const watchedEpisodes = alignWatchedEpisodesToList(
    options.replaceWatchedEpisodes
      ? Array.from(new Set(partialWithoutBrowseIndex.watchedEpisodes || []))
      : Array.from(new Set([...(existing.watchedEpisodes || []), ...(partialWithoutBrowseIndex.watchedEpisodes || [])])),
    episodeListForWatchAlignment({
      ...existing,
      ...partialWithoutBrowseIndex,
      episodes: partialWithoutBrowseIndex.episodes || existing.episodes,
    }),
  );
  state.shows[id] = {
    ...existing,
    ...partialWithoutBrowseIndex,
    id,
    sourceName: partialWithoutBrowseIndex.sourceName || existing.sourceName || cleanTitle(partialWithoutBrowseIndex.name || partialWithoutBrowseIndex.title || existing.name || existing.title || ''),
    name: preferredName(partialWithoutBrowseIndex, existing),
    title: partialWithoutBrowseIndex.title || existing.title || partialWithoutBrowseIndex.name || existing.name || '',
    mode: pickAvailableMode(partialWithoutBrowseIndex, existing, state.settings.mode),
    tracked: partialWithoutBrowseIndex.tracked ?? existing.tracked ?? true,
    archived: Boolean(partialWithoutBrowseIndex.archived ?? existing.archived ?? false),
    watchedEpisodes,
    updatedAt: new Date().toISOString(),
  };
  return state.shows[id];
}

function normalizeWatchQuery(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function releaseWatchId(query, mode) {
  return crypto.createHash('sha1').update(`${normalizeMode(mode)}:${normalizeWatchQuery(query).toLowerCase()}`).digest('hex').slice(0, 16);
}

function presentReleaseWatch(watch) {
  return {
    id: watch.id,
    query: watch.query,
    mode: normalizeMode(watch.mode),
    status: watch.status || 'watching',
    createdAt: watch.createdAt || null,
    updatedAt: watch.updatedAt || null,
    lastCheckedAt: watch.lastCheckedAt || null,
    foundAt: watch.foundAt || null,
    matchedShow: watch.matchedShow || null,
  };
}

function createReleaseWatch(state, query, mode = state.settings.mode) {
  const cleanQuery = normalizeWatchQuery(query);
  if (!cleanQuery) throw new Error('Missing search query');
  const normalizedMode = normalizeMode(mode);
  const id = releaseWatchId(cleanQuery, normalizedMode);
  const now = new Date().toISOString();
  const existing = state.releaseWatches[id] || {};
  state.releaseWatches[id] = {
    ...existing,
    id,
    query: existing.query || cleanQuery,
    mode: existing.mode || normalizedMode,
    status: existing.status || 'watching',
    createdAt: existing.createdAt || now,
    updatedAt: now,
  };
  return state.releaseWatches[id];
}

async function checkReleaseWatch(state, watch) {
  const now = new Date().toISOString();
  const results = animeProvider.bindCatalogToLibrary(state, await animeProvider.search(watch.query));
  const match = pickReleaseWatchMatch(watch.query, results);
  state.releaseWatches[watch.id] = {
    ...watch,
    status: match ? 'found' : 'watching',
    matchedShow: match,
    foundAt: match ? (watch.foundAt || now) : null,
    lastCheckedAt: now,
    updatedAt: now,
  };
  return state.releaseWatches[watch.id];
}

function pickReleaseWatchMatch(query, results) {
  return (results || [])
    .map((show) => ({ show, score: catalogTitleScore(query, show) }))
    .filter(({ score }) => score >= 90)
    .sort((left, right) => right.score - left.score)[0]?.show || null;
}

async function matchCatalogTitle(state, id, providerId, query) {
  const existing = state.shows[id];
  if (!existing) throw Object.assign(new Error('Show not found'), { status: 404 });
  const results = await animeProvider.search(query || existing.sourceName || existing.name || existing.title);
  const candidate = results.find((item) => catalogIdFromItem(item) === providerId);
  if (!candidate) throw Object.assign(new Error('Selected catalog title is no longer available'), { status: 422 });
  return mergeShow(state, applyAnimeCatalogMapping(existing, {
    provider: 'hianime',
    providerId: catalogIdFromItem(candidate),
  }));
}

async function refreshShow(state, show) {
  const mode = show.mode || state.settings.mode;
  if (!hasAnimeCatalogMapping(show)) {
    throw Object.assign(new Error('This title needs a catalog match before it can refresh'), { status: 409 });
  }
  const details = await animeProvider.details(state, show, mode, { force: true, enrichEpisodeTitles: true });
  assertSafeShowRefresh(show, details);
  const merged = mergeShow(state, {
    ...show,
    ...details,
    ...catalogFieldsFromClient(details),
    lastCheckedAt: new Date().toISOString(),
  });
  return presentShow(merged);
}

function presentShow(show) {
  const watchedEpisodes = alignWatchedEpisodesToList(show.watchedEpisodes, episodeListForWatchAlignment(show));
  const latest = show.latestEpisode || show.episodeCount || null;
  const lastWatched = highestEpisode(watchedEpisodes) || '';
  const relatedShows = normalizeRelatedShows(show.relatedShows);
  return {
    ...show,
    watchedEpisodes,
    relatedShows,
    hasNextSeason: Boolean(show.nextSeason || show.hasNextSeason || hasNextSeason(relatedShows)),
    nextSeason: show.nextSeason || null,
    name: preferredName(show),
    lastWatched,
    latestEpisode: latest,
    newCount: latest && lastWatched ? Math.max(0, Math.floor(Number(latest) - Number(lastWatched))) : 0,
    watchedCount: watchedEpisodes.length,
    canContinue: Boolean(latest),
  };
}

module.exports = {
  matchCatalogTitle,
  matchHiAnime: matchCatalogTitle,
  mergeShow,
  presentShow,
  presentReleaseWatch,
  createReleaseWatch,
  checkReleaseWatch,
  pickReleaseWatchMatch,
  refreshShow,
  assertSafeShowRefresh,
};
