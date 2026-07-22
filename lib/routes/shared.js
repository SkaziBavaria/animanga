'use strict';

const { DETAIL_CACHE_TTL_MS } = require('../config');
const { episodesThrough, highestEpisode } = require('../episodes');
const { mergeShow } = require('../library');

function touchShow(state, id, details) {
  if (!state.shows[id]) return false;
  mergeShow(state, { ...state.shows[id], ...details, lastCheckedAt: new Date().toISOString() });
  return true;
}

function cachedEpisodeDetails(show) {
  if (!show) return null;
  const latest = show.latestEpisode || show.episodeCount;
  const episodes = show.episodes?.length ? show.episodes : episodesThrough([], latest);
  if (!episodes.length) return null;
  return {
    ...show,
    episodes,
    latestEpisode: highestEpisode(episodes) || latest || null,
    cached: true,
    offline: true,
  };
}

function cacheMetadata(entry, options = {}) {
  const fetchedAt = entry?.createdAt || options.fetchedAt || null;
  const ageSeconds = fetchedAt
    ? Math.max(0, Math.floor((Date.now() - Date.parse(fetchedAt)) / 1000))
    : null;
  return {
    cached: Boolean(options.cached),
    offline: Boolean(options.offline),
    stale: Boolean(options.stale),
    fetchedAt,
    ageSeconds: Number.isFinite(ageSeconds) ? ageSeconds : null,
  };
}

function freshCacheEntry(state, key) {
  const entry = state.cache?.details?.[key] || null;
  if (!entry?.createdAt) return null;
  return Date.now() - Date.parse(entry.createdAt) < DETAIL_CACHE_TTL_MS ? entry : null;
}

module.exports = { touchShow, cachedEpisodeDetails, cacheMetadata, freshCacheEntry };
