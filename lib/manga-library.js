'use strict';

const crypto = require('crypto');
const { compareEpisodes, highestEpisode } = require('./episodes');
const { getMangaDetails, searchManga } = require('./allmanga');
const { proxiedThumbnail } = require('./proxy-sign');
const { resolvedTitleMatchesAny } = require('./title-match');

const PRESERVED_MANGA_DETAIL_FIELDS = new Set([
  'name', 'sourceName', 'englishName', 'nativeName', 'title', 'thumbnail', 'thumbnails',
  'description', 'genres', 'score', 'type', 'status', 'airedStart', 'airedEnd',
  'countryOfOrigin', 'chapters', 'chapterCount', 'latestChapter', 'lastChapterDate', 'relations',
]);

function emptyDetail(value) {
  if (value === null || value === undefined || value === '') return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value).length === 0;
  return false;
}

function preserveMangaDetails(existing, partial) {
  return Object.fromEntries(Object.entries(partial).map(([key, value]) => (
    PRESERVED_MANGA_DETAIL_FIELDS.has(key) && existing[key] !== undefined && emptyDetail(value)
      ? [key, existing[key]]
      : [key, value]
  )));
}

function assertSafeMangaRefresh(existing, details) {
  if (!details || details.id !== existing.id) throw new Error('Manga refresh returned the wrong identity');
  const candidate = details.sourceName || details.englishName || details.name || details.title;
  const knownNames = [existing.sourceName, existing.englishName, existing.nativeName, existing.name, existing.title].filter(Boolean);
  if (!candidate || !knownNames.length || !resolvedTitleMatchesAny(candidate, knownNames)) {
    throw new Error('Manga refresh returned mismatched or invalid metadata');
  }
  if (!details.thumbnail && !Number(details.chapterCount) && !details.latestChapter && !details.chapters?.length) {
    throw new Error('Manga refresh returned incomplete metadata');
  }
  return details;
}

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
  const safePartial = preserveMangaDetails(existing, partial);
  state.mangas[partial.id] = {
    ...existing,
    ...safePartial,
    id: partial.id,
    thumbnail: unwrapProxyUrl(safePartial.thumbnail ?? existing.thumbnail),
    tracked: partial.tracked ?? existing.tracked ?? true,
    archived: Boolean(partial.archived ?? existing.archived ?? false),
    readChapters: Array.from(new Set([...(existing.readChapters || []), ...(partial.readChapters || [])])).sort(compareEpisodes),
    updatedAt: new Date().toISOString(),
  };
  delete state.mangas[partial.id].language;
  delete state.mangas[partial.id].chapterCounts;
  delete state.mangas[partial.id].latestChapters;
  delete state.mangas[partial.id].lastChapterDates;
  return state.mangas[partial.id];
}

function presentManga(manga) {
  const currentManga = { ...manga };
  delete currentManga.language;
  delete currentManga.chapterCounts;
  delete currentManga.latestChapters;
  delete currentManga.lastChapterDates;
  const readChapters = (currentManga.readChapters || []).map(String).sort(compareEpisodes);
  const latest = currentManga.latestChapter || currentManga.chapters?.at(-1) || null;
  const lastRead = highestEpisode(readChapters) || '';
  const last = Number(lastRead);
  const latestNumber = Number(latest);
  // Count only chapters after the furthest read point so gaps behind do not inflate "Up next".
  let newCount = 0;
  if (Array.isArray(currentManga.chapters) && currentManga.chapters.length) {
    newCount = currentManga.chapters.filter((chapter) => {
      const value = Number(chapter);
      return Number.isFinite(value) && Number.isFinite(last) && value > last;
    }).length;
  } else if (Number.isFinite(latestNumber) && Number.isFinite(last)) {
    newCount = Math.max(0, Math.floor(latestNumber - last));
  }
  return {
    ...currentManga,
    thumbnail: proxiedThumbnail(currentManga.thumbnail),
    thumbnails: Array.isArray(currentManga.thumbnails)
      ? currentManga.thumbnails.map((item) => proxiedThumbnail(item))
      : currentManga.thumbnails,
    relations: Array.isArray(currentManga.relations)
      ? currentManga.relations.map((item) => {
        const relation = { ...item };
        delete relation.language;
        return { ...relation, thumbnail: proxiedThumbnail(relation.thumbnail) };
      })
      : currentManga.relations,
    readChapters,
    lastRead,
    latestChapter: latest,
    newCount,
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
  const details = await getMangaDetails(manga.id);
  assertSafeMangaRefresh(manga, details);
  return presentManga(mergeManga(state, { ...manga, ...details, lastCheckedAt: new Date().toISOString() }));
}

function normalizeMangaWatchQuery(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function mangaReleaseWatchId(query) {
  return crypto.createHash('sha1')
    .update(normalizeMangaWatchQuery(query).toLowerCase())
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
    status: watch.status || 'watching',
    createdAt: watch.createdAt || null,
    updatedAt: watch.updatedAt || null,
    lastCheckedAt: watch.lastCheckedAt || null,
    foundAt: watch.foundAt || null,
    matchedManga: matched,
  };
}

function createMangaReleaseWatch(state, query) {
  const cleanQuery = normalizeMangaWatchQuery(query);
  if (!cleanQuery) throw new Error('Missing search query');
  const id = mangaReleaseWatchId(cleanQuery);
  const now = new Date().toISOString();
  const existing = state.mangaReleaseWatches[id] || {};
  state.mangaReleaseWatches[id] = {
    ...existing,
    id,
    query: existing.query || cleanQuery,
    status: existing.status || 'watching',
    createdAt: existing.createdAt || now,
    updatedAt: now,
  };
  return state.mangaReleaseWatches[id];
}

async function checkMangaReleaseWatch(state, watch) {
  const now = new Date().toISOString();
  const result = await searchManga(watch.query, { limit: 10 });
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
  assertSafeMangaRefresh,
  presentMangaReleaseWatch,
  createMangaReleaseWatch,
  checkMangaReleaseWatch,
};
