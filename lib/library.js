'use strict';

const crypto = require('crypto');
const {
  cleanTitle,
  preferredName,
  normalizeMode,
  compareEpisodes,
  highestEpisode,
} = require('./episodes');
const { searchAnime, getCachedShowDetails, hasNextSeason, normalizeRelatedShows } = require('./allanime');

const PRESERVED_DETAIL_FIELDS = new Set([
  'name', 'sourceName', 'englishName', 'nativeName', 'title', 'thumbnail', 'banner',
  'thumbnails', 'description', 'genres', 'score', 'type', 'status', 'airedStart',
  'airedEnd', 'season', 'broadcastInterval', 'franchiseKey', 'franchiseName',
  'relatedShows', 'episodeTitles', 'episodeDates', 'episodes', 'episodeCount', 'latestEpisode',
]);

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

function mergeShow(state, partial, options = {}) {
  if (!partial.id) throw new Error('Missing show id');
  const id = partial.id;
  const existing = state.shows[id] || {};
  const rawPartial = { ...partial };
  delete rawPartial.index;
  const partialWithoutBrowseIndex = preserveExistingDetails(existing, rawPartial);
  const watchedEpisodes = options.replaceWatchedEpisodes
    ? Array.from(new Set(partialWithoutBrowseIndex.watchedEpisodes || []))
    : Array.from(new Set([...(existing.watchedEpisodes || []), ...(partialWithoutBrowseIndex.watchedEpisodes || [])]));
  watchedEpisodes.sort(compareEpisodes);
  state.shows[id] = {
    ...existing,
    ...partialWithoutBrowseIndex,
    id,
    sourceName: partialWithoutBrowseIndex.sourceName || existing.sourceName || cleanTitle(partialWithoutBrowseIndex.name || partialWithoutBrowseIndex.title || existing.name || existing.title || ''),
    name: preferredName(partialWithoutBrowseIndex, existing),
    title: partialWithoutBrowseIndex.title || existing.title || partialWithoutBrowseIndex.name || existing.name || '',
    mode: normalizeMode(partialWithoutBrowseIndex.mode || existing.mode || state.settings.mode),
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
  const results = await searchAnime(watch.query, watch.mode || state.settings.mode);
  const match = results[0] || null;
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

async function refreshShow(state, show) {
  const mode = show.mode || state.settings.mode;
  let details = null;
  let detailError = null;
  try {
    details = await getCachedShowDetails(state, show.id, mode, {
      includeNextSeason: true,
      force: true,
    });
  } catch (err) {
    detailError = err;
  }
  if (!details?.thumbnail || !Number(details?.episodeCount || details?.latestEpisode)) {
    const query = show.sourceName || show.name || show.title;
    const summary = (await searchAnime(query, mode)).find((item) => item.id === show.id);
    if (summary) {
      details = {
        ...summary,
        ...(details || {}),
        name: details?.name || summary.name,
        sourceName: details?.sourceName || summary.sourceName,
        thumbnail: details?.thumbnail || summary.thumbnail,
        thumbnails: details?.thumbnails?.length ? details.thumbnails : summary.thumbnails,
        episodeCount: Number(details?.episodeCount) > 0 ? details.episodeCount : summary.episodeCount,
        latestEpisode: details?.latestEpisode || summary.latestEpisode,
        title: Number(details?.episodeCount) > 0 ? details.title : summary.title,
      };
    }
  }
  if (!details) throw detailError || new Error(`Could not refresh ${show.id}`);
  const merged = mergeShow(state, {
    ...show,
    ...details,
    lastCheckedAt: new Date().toISOString(),
  });
  return presentShow(merged);
}

function presentShow(show) {
  const watched = new Set(show.watchedEpisodes || []);
  const latest = show.latestEpisode || show.episodeCount || null;
  const lastWatched = show.lastWatched || highestEpisode(show.watchedEpisodes || []);
  const relatedShows = normalizeRelatedShows(show.relatedShows);
  return {
    ...show,
    relatedShows,
    hasNextSeason: Boolean(show.nextSeason || show.hasNextSeason || hasNextSeason(relatedShows)),
    nextSeason: show.nextSeason || null,
    name: preferredName(show),
    lastWatched,
    latestEpisode: latest,
    newCount: latest && lastWatched ? Math.max(0, Math.floor(Number(latest) - Number(lastWatched))) : 0,
    watchedCount: watched.size,
    canContinue: Boolean(latest),
  };
}

module.exports = {
  mergeShow,
  presentShow,
  presentReleaseWatch,
  createReleaseWatch,
  checkReleaseWatch,
  refreshShow,
};
