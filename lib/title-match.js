'use strict';

function normalizeResolverTitle(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function resolverTitleScore(query, candidate) {
  const wanted = normalizeResolverTitle(query);
  const found = normalizeResolverTitle(candidate);
  if (!wanted || !found) return 0;
  if (wanted === found) return 100;
  const wantedTokens = new Set(wanted.split(' '));
  const foundTokens = new Set(found.split(' '));
  const overlap = [...wantedTokens].filter((token) => foundTokens.has(token)).length;
  const wantedCoverage = overlap / wantedTokens.size;
  const foundCoverage = overlap / foundTokens.size;
  // Both titles must substantially describe each other. This rejects generic suffixes.
  if (wantedCoverage < 0.75 || foundCoverage < 0.75) return 0;
  const sameTokens = wantedTokens.size === foundTokens.size && overlap === wantedTokens.size;
  if (sameTokens) return 95;
  return Math.round(Math.min(wantedCoverage, foundCoverage) * 90);
}

function pickSafeResolverMatch(names, rows, { minimum = 70 } = {}) {
  const scored = (rows || []).map((row) => ({
    row,
    score: Math.max(...(names || []).map((name) => resolverTitleScore(name, row.name)), 0),
  })).filter((item) => item.score >= minimum)
    .sort((a, b) => b.score - a.score || String(a.row.id).localeCompare(String(b.row.id)));
  if (!scored.length) return null;
  if (scored[1] && scored[1].score === scored[0].score && scored[1].row.id !== scored[0].row.id) return null;
  return scored[0].row;
}

function resolvedTitleMatchesAny(resolvedTitle, names, { minimum = 70 } = {}) {
  return (names || []).some((name) => resolverTitleScore(name, resolvedTitle) >= minimum);
}

module.exports = {
  normalizeResolverTitle,
  resolverTitleScore,
  pickSafeResolverMatch,
  resolvedTitleMatchesAny,
};
