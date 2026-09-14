'use strict';

const { searchAnime } = require('./hianime');
const { applyAnimeCatalogMapping, hasAnimeCatalogMapping } = require('./library-identity');

function normalizeTitle(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function score(query, candidate) {
  const wanted = normalizeTitle(query);
  const name = normalizeTitle(candidate?.name || candidate?.title);
  if (!wanted || !name) return 0;
  if (wanted === name) return 100;
  const tokens = wanted.split(' ').filter(Boolean);
  const candidateTokens = new Set(name.split(' ').filter(Boolean));
  const overlap = tokens.filter((token) => candidateTokens.has(token)).length;
  return tokens.length && overlap === tokens.length ? 75 : 0;
}

function pickMatch(show, results) {
  const query = show.sourceName || show.englishName || show.name || show.title;
  const ranked = (results || []).map((item) => ({ item, score: score(query, item) }))
    .filter((entry) => entry.score >= 90)
    .sort((a, b) => b.score - a.score);
  if (!ranked.length || (ranked[1] && ranked[1].score === ranked[0].score)) return null;
  return ranked[0].item;
}

async function migrateShowToHianime(show) {
  if (!show?.id || hasAnimeCatalogMapping(show)) return { changed: false };
  const results = await searchAnime(show.sourceName || show.englishName || show.name || show.title);
  const match = pickMatch(show, results);
  if (!match) return { changed: false, pending: true, reason: 'no-confident-match' };
  return {
    changed: true,
    value: applyAnimeCatalogMapping(show, {
      provider: 'hianime',
      providerId: match.id,
    }),
  };
}

async function migrateLibraryToHianime(state, { limit = 25, save = null } = {}) {
  const now = Date.now();
  const shows = Object.values(state.shows || {})
    .filter((show) => !hasAnimeCatalogMapping(show) && (!show.providerMigrationAttemptedAt || now - Date.parse(show.providerMigrationAttemptedAt) >= 24 * 60 * 60_000))
    .sort((a, b) => String(a.providerMigrationAttemptedAt || '').localeCompare(String(b.providerMigrationAttemptedAt || '')))
    .slice(0, limit);
  const report = { total: shows.length, migrated: 0, pending: 0, errors: 0 };
  for (const show of shows) {
    try {
      const result = await migrateShowToHianime(show);
      if (result.value) {
        state.shows[show.id] = result.value;
        report.migrated += 1;
        if (save) save(state);
      } else if (result.pending) {
        state.shows[show.id] = { ...show, providerMigrationStatus: 'pending', providerMigrationReason: result.reason || 'no-confident-match', providerMigrationAttemptedAt: new Date().toISOString() };
        report.pending += 1;
        if (save) save(state);
      }
    } catch {
      state.shows[show.id] = { ...show, providerMigrationStatus: 'error', providerMigrationReason: 'provider-error', providerMigrationAttemptedAt: new Date().toISOString() };
      if (save) save(state);
      report.errors += 1;
    }
  }
  return report;
}

module.exports = { normalizeTitle, score, pickMatch, migrateShowToHianime, migrateLibraryToHianime };
