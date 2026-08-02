'use strict';

const { compareEpisodes } = require('./episodes');
const { searchManga } = require('./comick');

function normalizeTitle(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function titleScore(query, candidate) {
  const wanted = normalizeTitle(query);
  const names = [candidate?.name, candidate?.englishName, candidate?.sourceName, ...(candidate?.alternativeTitles || [])]
    .map(normalizeTitle)
    .filter(Boolean);
  if (!wanted || !names.length) return 0;
  if (names.includes(wanted)) return 100;
  let best = 0;
  const wantedTokens = new Set(wanted.split(/\s+/));
  for (const name of names) {
    if (name.startsWith(wanted) || wanted.startsWith(name)) best = Math.max(best, 80);
    else if (name.includes(wanted) || wanted.includes(name)) best = Math.max(best, 60);
    const tokens = new Set(name.split(/\s+/));
    const overlap = [...wantedTokens].filter((token) => tokens.has(token)).length;
    best = Math.max(best, Math.round((overlap / wantedTokens.size) * 50));
  }
  return best;
}

function pickBestMatch(manga, results) {
  const queries = [manga?.sourceName, manga?.name, manga?.englishName, manga?.title, ...(manga?.alternativeTitles || [])]
    .filter(Boolean);
  let best = null;
  let bestScore = 0;
  for (const candidate of results || []) {
    const score = Math.max(...queries.map((query) => titleScore(query, candidate)), 0);
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return bestScore >= 60 ? best : null;
}

function isComicKManga(manga) {
  return manga?.provider === 'comick' && !manga.needsRematch;
}

function migratePositions(state, from, to) {
  state.mangaPositions ||= {};
  for (const [key, position] of Object.entries({ ...state.mangaPositions })) {
    if (position?.mangaId !== from && !key.startsWith(`${from}:`)) continue;
    const suffix = key.startsWith(`${from}:`) ? key.slice(from.length) : `:${position.language || 'sub'}:${position.chapter}`;
    const nextKey = `${to}${suffix}`;
    state.mangaPositions[nextKey] = { ...(state.mangaPositions[nextKey] || {}), ...position, mangaId: to };
    delete state.mangaPositions[key];
  }
}

async function migrateMangaEntry(state, manga, { search = searchManga } = {}) {
  if (!manga?.id || isComicKManga(manga)) return { changed: false };
  const query = manga.sourceName || manga.name || manga.englishName || manga.title || '';
  if (!query) {
    state.mangas[manga.id] = { ...manga, needsRematch: true };
    return { changed: true, needsRematch: true };
  }
  try {
    const payload = await search(query, { language: manga.language || 'sub', limit: 10 });
    const match = pickBestMatch(manga, payload?.results || payload);
    if (!match) {
      state.mangas[manga.id] = { ...manga, provider: manga.provider || 'allmanga-legacy', needsRematch: true };
      return { changed: true, needsRematch: true };
    }
    const existing = state.mangas[match.id] || {};
    const migrated = {
      ...manga,
      ...existing,
      ...match,
      id: match.id,
      legacyAllMangaId: manga.legacyAllMangaId || (manga.id !== match.id ? manga.id : undefined),
      provider: 'comick',
      needsRematch: false,
      tracked: manga.tracked ?? existing.tracked,
      archived: manga.archived ?? existing.archived,
      readChapters: [...new Set([...(manga.readChapters || []), ...(existing.readChapters || [])])].sort(compareEpisodes),
      updatedAt: new Date().toISOString(),
    };
    if (manga.id !== match.id) {
      delete state.mangas[manga.id];
      migratePositions(state, manga.id, match.id);
      for (const watch of Object.values(state.mangaReleaseWatches || {})) {
        if (watch?.matchedManga?.id === manga.id) watch.matchedManga = { ...watch.matchedManga, ...match, id: match.id };
      }
    }
    state.mangas[match.id] = migrated;
    return { changed: true, from: manga.id, to: match.id };
  } catch (error) {
    state.mangas[manga.id] = { ...manga, needsRematch: true, rematchError: error.message || String(error) };
    return { changed: true, needsRematch: true, error: error.message || String(error) };
  }
}

async function migrateLibraryToComicK(state, { limit = 50, search = searchManga } = {}) {
  const mangas = Object.values(state.mangas || {});
  const pending = mangas.filter((manga) => !isComicKManga(manga));
  const report = { total: mangas.length, pending: pending.length, migrated: 0, needsRematch: 0, errors: 0 };
  for (const manga of pending.slice(0, limit)) {
    const result = await migrateMangaEntry(state, manga, { search });
    if (result.to) report.migrated += 1;
    else if (result.needsRematch) report.needsRematch += 1;
    if (result.error) report.errors += 1;
  }
  return report;
}

module.exports = { normalizeTitle, titleScore, pickBestMatch, isComicKManga, migrateMangaEntry, migrateLibraryToComicK };
