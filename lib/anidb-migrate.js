'use strict';

const { isAnidbShowId, searchAnime } = require('./anidb');

function normalizeTitle(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function titleScore(query, candidate) {
  const q = normalizeTitle(query);
  const name = normalizeTitle(candidate?.name || candidate?.englishName || candidate?.title);
  if (!q || !name) return 0;
  if (q === name) return 100;
  if (name.startsWith(q) || q.startsWith(name)) return 80;
  if (name.includes(q) || q.includes(name)) return 60;
  const qTokens = new Set(q.split(/\s+/).filter(Boolean));
  const nTokens = new Set(name.split(/\s+/).filter(Boolean));
  let overlap = 0;
  for (const token of qTokens) {
    if (nTokens.has(token)) overlap += 1;
  }
  if (!qTokens.size) return 0;
  return Math.round((overlap / qTokens.size) * 50);
}

function pickBestMatch(show, results) {
  const query = show.sourceName || show.name || show.englishName || show.title || '';
  let best = null;
  let bestScore = 0;
  for (const candidate of results || []) {
    const score = Math.max(
      titleScore(query, candidate),
      titleScore(show.englishName, candidate),
      titleScore(show.name, candidate),
    );
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  if (bestScore < 60) return null;
  return best;
}

async function migrateShowEntry(state, show) {
  if (!show?.id) return { changed: false };
  if (isAnidbShowId(show.id) && !show.needsRematch) {
    return { changed: false };
  }

  const query = show.sourceName || show.name || show.englishName || show.title || '';
  if (!query) {
    state.shows[show.id] = { ...show, needsRematch: true };
    return { changed: true, needsRematch: true };
  }

  try {
    const results = await searchAnime(query, show.mode || state.settings?.mode || 'sub');
    const match = pickBestMatch(show, results);
    if (!match) {
      state.shows[show.id] = {
        ...show,
        needsRematch: true,
        provider: show.provider || 'allanime-legacy',
      };
      return { changed: true, needsRematch: true };
    }

    const legacyId = show.legacyAllAnimeId || (isAnidbShowId(show.id) ? show.legacyAllAnimeId : show.id);
    const migrated = {
      ...show,
      ...match,
      id: match.id,
      legacyAllAnimeId: legacyId || undefined,
      needsRematch: false,
      provider: 'anidb',
      watchedEpisodes: show.watchedEpisodes || [],
      lastWatched: show.lastWatched,
      tracked: show.tracked,
      archived: show.archived,
      mode: show.mode || match.mode,
      updatedAt: new Date().toISOString(),
    };

    if (show.id !== match.id) {
      delete state.shows[show.id];
      // Migrate playback positions keyed by show id when present.
      if (state.positions && state.positions[show.id]) {
        state.positions[match.id] = {
          ...(state.positions[match.id] || {}),
          ...state.positions[show.id],
        };
        delete state.positions[show.id];
      }
    }
    state.shows[match.id] = migrated;
    return { changed: true, from: show.id, to: match.id };
  } catch (error) {
    state.shows[show.id] = {
      ...show,
      needsRematch: true,
      rematchError: error.message || String(error),
    };
    return { changed: true, needsRematch: true, error: error.message };
  }
}

async function migrateLibraryToAnidb(state, { limit = 50 } = {}) {
  const shows = Object.values(state.shows || {});
  const pending = shows.filter((show) => !isAnidbShowId(show.id) || show.needsRematch);
  const report = {
    total: shows.length,
    pending: pending.length,
    migrated: 0,
    needsRematch: 0,
    errors: 0,
  };
  for (const show of pending.slice(0, limit)) {
    const result = await migrateShowEntry(state, show);
    if (!result.changed) continue;
    if (result.to) report.migrated += 1;
    else if (result.needsRematch) report.needsRematch += 1;
    if (result.error) report.errors += 1;
  }
  return report;
}

module.exports = {
  normalizeTitle,
  titleScore,
  pickBestMatch,
  migrateShowEntry,
  migrateLibraryToAnidb,
};
