'use strict';

const { compareEpisodes, highestEpisode } = require('./episodes');
const { getMangaDetails } = require('./allmanga');

function mergeManga(state, partial) {
  if (!partial?.id) throw new Error('Missing manga id');
  const existing = state.mangas[partial.id] || {};
  state.mangas[partial.id] = {
    ...existing,
    ...partial,
    id: partial.id,
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
    readChapters,
    lastRead: highestEpisode(readChapters) || '',
    latestChapter: latest,
    newCount: unreadCount,
  };
}

async function refreshManga(state, manga) {
  const details = await getMangaDetails(manga.id, manga.language || 'sub');
  return presentManga(mergeManga(state, { ...manga, ...details, lastCheckedAt: new Date().toISOString() }));
}

module.exports = { mergeManga, presentManga, refreshManga };
