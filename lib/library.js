'use strict';

const fs = require('fs');
const crypto = require('crypto');
const { HISTORY_FILE } = require('./config');
const {
  cleanTitle,
  preferredName,
  normalizeMode,
  normalizeEpisode,
  compareEpisodes,
  highestEpisode,
  parseEpisodeCount,
  episodeKey,
} = require('./episodes');
const { searchAnime, getCachedShowDetails, hasNextSeason, normalizeRelatedShows } = require('./allanime');

function readHistory() {
  const text = fs.existsSync(HISTORY_FILE) ? fs.readFileSync(HISTORY_FILE, 'utf8') : '';
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [lastWatched, id, ...titleParts] = line.split('\t');
      const title = titleParts.join('\t');
      return {
        id,
        title,
        name: cleanTitle(title),
        lastWatched,
        episodeCount: parseEpisodeCount(title),
      };
    })
    .filter((entry) => entry.id && entry.title);
}

function writeHistoryEntry(show, episode) {
  const rows = readHistory().filter((row) => row.id !== show.id);
  const normalizedEpisode = normalizeEpisode(episode);
  if (!normalizedEpisode) {
    const body = rows.map((row) => `${row.lastWatched}\t${row.id}\t${row.title}`).join('\n');
    fs.writeFileSync(HISTORY_FILE, body ? `${body}\n` : '');
    return;
  }
  const count = show.latestEpisode || show.episodeCount || parseEpisodeCount(show.title);
  const titleName = preferredName(show) || cleanTitle(show.title || show.name);
  const title = count ? `${titleName} (${count} episodes)` : titleName;
  rows.push({ id: show.id, title, lastWatched: normalizedEpisode });
  const body = rows.map((row) => `${row.lastWatched}\t${row.id}\t${row.title}`).join('\n');
  fs.writeFileSync(HISTORY_FILE, body ? `${body}\n` : '');
}

function mergeShow(state, partial, options = {}) {
  if (!partial.id) throw new Error('Missing show id');
  const id = partial.id;
  const existing = state.shows[id] || {};
  const { index: _browseIndex, ...partialWithoutBrowseIndex } = partial;
  const watchedEpisodes = options.replaceWatchedEpisodes
    ? Array.from(new Set(partialWithoutBrowseIndex.watchedEpisodes || []))
    : Array.from(new Set([...(existing.watchedEpisodes || []), ...(partialWithoutBrowseIndex.watchedEpisodes || [])]));
  watchedEpisodes.sort(compareEpisodes);
  state.shows[id] = {
    ...existing,
    ...partialWithoutBrowseIndex,
    id,
    sourceName: partial.sourceName || existing.sourceName || cleanTitle(partial.name || partial.title || existing.name || existing.title || ''),
    name: preferredName(partial, existing),
    title: partial.title || existing.title || partial.name || existing.name || '',
    mode: normalizeMode(partial.mode || existing.mode || state.settings.mode),
    tracked: partial.tracked ?? existing.tracked ?? true,
    watchedEpisodes,
    updatedAt: new Date().toISOString(),
  };
  return state.shows[id];
}

function seedStateFromHistory(state) {
  for (const row of readHistory()) {
    const existing = state.shows[row.id] || {};
    const watchedEpisodes = new Set(existing.watchedEpisodes || []);
    if (row.lastWatched) watchedEpisodes.add(row.lastWatched);
    mergeShow(state, {
      id: row.id,
      title: row.title,
      sourceName: row.name,
      lastWatched: row.lastWatched,
      episodeCount: row.episodeCount,
      latestEpisode: existing.latestEpisode || row.episodeCount,
      tracked: existing.tracked ?? true,
      watchedEpisodes: Array.from(watchedEpisodes),
    });
  }
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
  const details = await getCachedShowDetails(state, show.id, show.mode || state.settings.mode, {
    includeNextSeason: true,
    force: true,
  });
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
    hasNextSeason: show.hasNextSeason ?? hasNextSeason(relatedShows),
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
  readHistory,
  writeHistoryEntry,
  mergeShow,
  seedStateFromHistory,
  presentShow,
  presentReleaseWatch,
  createReleaseWatch,
  checkReleaseWatch,
  refreshShow,
};
