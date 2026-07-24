'use strict';

const crypto = require('crypto');
const { compareEpisodes, highestEpisode } = require('./episodes');
const { getMangaDetails, searchManga } = require('./allmanga');
const { proxiedThumbnail } = require('./proxy-sign');

function unwrapProxyUrl(value) {
  const text = String(value || '').trim();
  if (!text.startsWith('/api/proxy?')) return text;
  try {
    return new URL(text, 'http://local.invalid').searchParams.get('url') || text;
  } catch {
    return text;
  }
}

function mergeManga(state, partial) {
  if (!partial?.id) throw new Error('Missing manga id');
  const existing = state.mangas[partial.id] || {};
  state.mangas[partial.id] = {
    ...existing,
    ...partial,
    id: partial.id,
    thumbnail: unwrapProxyUrl(partial.thumbnail ?? existing.thumbnail),
    tracked: partial.tracked ?? existing.tracked ?? true,
    readChapters: Array.from(new Set([...(existing.readChapters || []), ...(partial.readChapters || [])])).sort(compareEpisodes),
    updatedAt: new Date().toISOString(),
  };
  return state.mangas[partial.id];
}

function presentManga(manga) {
  const readChapters = (manga.readChapters || []).map(String).sort(compareEpisodes);
  const latest = manga.latestChapter || manga.chapters?.at(-1) || null;
  const read = new Set(readChapters);
  const unreadCount = Array.isArray(manga.chapters)
    ? manga.chapters.filter((chapter) => !read.has(String(chapter))).length
    : 0;
  return {
    ...manga,
    thumbnail: proxiedThumbnail(manga.thumbnail),
    thumbnails: Array.isArray(manga.thumbnails)
      ? manga.thumbnails.map((item) => proxiedThumbnail(item))
      : manga.thumbnails,
    relations: Array.isArray(manga.relations)
      ? manga.relations.map((item) => ({ ...item, thumbnail: proxiedThumbnail(item.thumbnail) }))
      : manga.relations,
    readChapters,
    lastRead: highestEpisode(readChapters) || '',
    latestChapter: latest,
    newCount: unreadCount,
  };
}

function presentMangaResults(payload = {}) {
  return {
    ...payload,
    results: (payload.results || []).map((item) => ({
      ...item,
      thumbnail: proxiedThumbnail(item.thumbnail),
    })),
  };
}

async function refreshManga(state, manga) {
  const details = await getMangaDetails(manga.id, manga.language || 'sub');
  return presentManga(mergeManga(state, { ...manga, ...details, lastCheckedAt: new Date().toISOString() }));
}

function normalizeMangaWatchQuery(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function mangaReleaseWatchId(query, language = 'sub') {
  return crypto.createHash('sha1')
    .update(`${language}:${normalizeMangaWatchQuery(query).toLowerCase()}`)
    .digest('hex')
    .slice(0, 16);
}

function presentMangaReleaseWatch(watch) {
  const matched = watch.matchedManga
    ? { ...watch.matchedManga, thumbnail: proxiedThumbnail(watch.matchedManga.thumbnail) }
    : null;
  return {
    id: watch.id,
    query: watch.query,
    language: watch.language || 'sub',
    status: watch.status || 'watching',
    createdAt: watch.createdAt || null,
    updatedAt: watch.updatedAt || null,
    lastCheckedAt: watch.lastCheckedAt || null,
    foundAt: watch.foundAt || null,
    matchedManga: matched,
  };
}

function createMangaReleaseWatch(state, query, language = 'sub') {
  const cleanQuery = normalizeMangaWatchQuery(query);
  if (!cleanQuery) throw new Error('Missing search query');
  const id = mangaReleaseWatchId(cleanQuery, language);
  const now = new Date().toISOString();
  const existing = state.mangaReleaseWatches[id] || {};
  state.mangaReleaseWatches[id] = {
    ...existing,
    id,
    query: existing.query || cleanQuery,
    language: existing.language || language,
    status: existing.status || 'watching',
    createdAt: existing.createdAt || now,
    updatedAt: now,
  };
  return state.mangaReleaseWatches[id];
}

async function checkMangaReleaseWatch(state, watch) {
  const now = new Date().toISOString();
  const result = await searchManga(watch.query, {
    language: watch.language || 'sub',
    limit: 10,
  });
  const match = result.results?.[0] || null;
  state.mangaReleaseWatches[watch.id] = {
    ...watch,
    status: match ? 'found' : 'watching',
    matchedManga: match,
    foundAt: match ? (watch.foundAt || now) : null,
    lastCheckedAt: now,
    updatedAt: now,
  };
  return state.mangaReleaseWatches[watch.id];
}

module.exports = {
  mergeManga,
  presentManga,
  presentMangaResults,
  refreshManga,
  presentMangaReleaseWatch,
  createMangaReleaseWatch,
  checkMangaReleaseWatch,
};
