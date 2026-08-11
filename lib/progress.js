'use strict';

const { normalizeEpisode } = require('./episodes');

const MIN_POSITION = 5;
const END_MARGIN = 15;
const END_RATIO = 0.95;

function positionKey(showId, episode) {
  return `${showId}:${normalizeEpisode(episode)}`;
}

function setPosition(state, { id, episode, position, duration }) {
  state.positions ||= {};
  if (!id || !episode) return { cleared: true };
  const key = positionKey(id, episode);
  const pos = Number(position);
  const dur = Number(duration);
  if (!Number.isFinite(pos) || pos < 0) return { cleared: true };

  const nearEnd = Number.isFinite(dur) && dur > 0 && (pos >= dur - END_MARGIN || pos / dur >= END_RATIO);
  if (pos < MIN_POSITION || nearEnd) {
    delete state.positions[key];
    return { cleared: true };
  }

  state.positions[key] = {
    showId: id,
    episode: normalizeEpisode(episode),
    position: pos,
    duration: Number.isFinite(dur) && dur > 0 ? dur : null,
    updatedAt: new Date().toISOString(),
  };
  return { position: state.positions[key] };
}

function clearPosition(state, id, episode) {
  state.positions ||= {};
  delete state.positions[positionKey(id, episode)];
}

function presentPositions(state) {
  return state.positions || {};
}

function mangaPositionKey(mangaId, languageOrChapter, maybeChapter) {
  const chapter = maybeChapter === undefined ? languageOrChapter : maybeChapter;
  return `${mangaId}:sub:${String(chapter || '').trim()}`;
}

function setMangaPosition(state, { id, mangaId, chapter, page, pageCount, clear = false }) {
  state.mangaPositions ||= {};
  const resolvedId = mangaId || id;
  const normalizedChapter = String(chapter || '').trim();
  if (!resolvedId || !normalizedChapter) return { cleared: true };
  const key = mangaPositionKey(resolvedId, normalizedChapter);
  const currentPage = Math.floor(Number(page));
  const totalPages = Math.floor(Number(pageCount));
  if (clear || !Number.isFinite(currentPage) || currentPage < 1) {
    delete state.mangaPositions[key];
    return { cleared: true };
  }
  state.mangaPositions[key] = {
    mangaId: resolvedId,
    language: 'sub',
    chapter: normalizedChapter,
    page: currentPage,
    pageCount: Number.isFinite(totalPages) && totalPages > 0 ? totalPages : null,
    updatedAt: new Date().toISOString(),
  };
  return { position: state.mangaPositions[key] };
}

function presentMangaPositions(state) {
  return state.mangaPositions || {};
}

module.exports = {
  positionKey,
  setPosition,
  clearPosition,
  presentPositions,
  mangaPositionKey,
  setMangaPosition,
  presentMangaPositions,
};
