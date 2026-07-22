import { api, postBeacon } from './api.js';
import { state } from './state.js';

export function positionKey(showId, episode) {
  return `${showId}:${String(episode || '').trim()}`;
}

export function positionFor(showId, episode) {
  return state.positions[positionKey(showId, episode)] || null;
}

export function latestPositionForShow(show) {
  const showId = typeof show === 'string' ? show : show?.id;
  const watched = new Set((typeof show === 'object' ? show.watchedEpisodes : []).map(String));
  const entries = Object.values(state.positions || {}).filter((entry) => (
    entry.showId === showId && !watched.has(String(entry.episode))
  ));
  if (!entries.length) return null;
  return entries.sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0))[0];
}

export async function loadProgress() {
  const data = await api('/api/progress');
  state.positions = data.positions || {};
  state.mangaPositions = data.mangaPositions || {};
}

export function saveProgress(showId, episode, position, duration) {
  if (!showId || !episode) return;
  const key = positionKey(showId, episode);
  const pos = Number(position);
  const dur = Number(duration);
  const nearEnd = Number.isFinite(dur) && dur > 0 && (pos >= dur - 15 || pos / dur >= 0.95);

  if (!Number.isFinite(pos) || pos < 5 || nearEnd) {
    delete state.positions[key];
  } else {
    state.positions[key] = {
      showId,
      episode: String(episode).trim(),
      position: pos,
      duration: Number.isFinite(dur) && dur > 0 ? dur : null,
      updatedAt: new Date().toISOString(),
    };
  }

  postBeacon('/api/progress', { id: showId, episode, position: pos, duration: dur });
}

export function mangaPositionKey(mangaId, language, chapter) {
  return `${mangaId}:${language === 'raw' ? 'raw' : 'sub'}:${String(chapter || '').trim()}`;
}

export function mangaPositionFor(mangaId, language, chapter) {
  return state.mangaPositions[mangaPositionKey(mangaId, language, chapter)] || null;
}

export function latestMangaPositionFor(manga) {
  const language = manga?.language === 'raw' ? 'raw' : 'sub';
  const read = new Set((manga?.readChapters || []).map(String));
  return Object.values(state.mangaPositions || {})
    .filter((position) => position.mangaId === manga?.id && position.language === language)
    .filter((position) => !read.has(String(position.chapter)))
    .sort((a, b) => Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0))[0] || null;
}

export function saveMangaProgress(manga, chapter, page, pageCount) {
  if (!manga?.id || !chapter) return;
  const language = manga.language === 'raw' ? 'raw' : 'sub';
  const key = mangaPositionKey(manga.id, language, chapter);
  const currentPage = Math.floor(Number(page));
  if (!Number.isFinite(currentPage) || currentPage < 1) return;
  const position = {
    mangaId: manga.id,
    language,
    chapter: String(chapter),
    page: currentPage,
    pageCount: Number(pageCount) > 0 ? Math.floor(Number(pageCount)) : null,
    updatedAt: new Date().toISOString(),
  };
  state.mangaPositions[key] = position;
  postBeacon('/api/manga/progress', position);
}

export function removeMangaProgress(manga, chapter) {
  if (!manga?.id || !chapter) return;
  const language = manga.language === 'raw' ? 'raw' : 'sub';
  const key = mangaPositionKey(manga.id, language, chapter);
  delete state.mangaPositions[key];
}

export function clearMangaProgress(manga, chapter) {
  if (!manga?.id || !chapter) return;
  const language = manga.language === 'raw' ? 'raw' : 'sub';
  removeMangaProgress(manga, chapter);
  postBeacon('/api/manga/progress', {
    mangaId: manga.id,
    language,
    chapter: String(chapter),
    clear: true,
  });
}

export function formatClock(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
