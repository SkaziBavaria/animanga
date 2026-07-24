'use strict';

function cleanTitle(title) {
  return String(title || '').replace(/\s*\(\d+(?:\.\d+)? episodes?\)\s*$/i, '').trim();
}

function queryTitle(payload = {}) {
  return cleanTitle(
    payload.englishName ||
    payload.name ||
    payload.sourceName ||
    payload.title
  );
}

function parseEpisodeCount(title) {
  const match = String(title || '').match(/\((\d+(?:\.\d+)?) episodes?\)/i);
  return match ? Number(match[1]) : null;
}

function preferredName(input = {}, fallback = {}) {
  return cleanTitle(
    input.customName ||
      fallback.customName ||
      input.englishName ||
      fallback.englishName ||
      input.displayName ||
      fallback.displayName ||
      input.name ||
      input.title ||
      fallback.name ||
      fallback.title ||
      fallback.sourceName ||
      ''
  );
}

function normalizeMode(mode) {
  return mode === 'dub' ? 'dub' : 'sub';
}

function normalizeEpisode(ep) {
  return String(ep || '').trim();
}

function episodeKey(ep) {
  return normalizeEpisode(ep);
}

function episodesThrough(episodes, target) {
  const targetValue = Number(target);
  if (!Number.isFinite(targetValue)) return [normalizeEpisode(target)].filter(Boolean);
  const sourceEpisodes = (episodes || []).length
    ? episodes
    : Array.from({ length: Math.max(0, Math.floor(targetValue)) }, (_, index) => String(index + 1));
  const selected = sourceEpisodes.filter((episode) => {
    const value = Number(episode);
    return Number.isFinite(value) && value <= targetValue;
  });
  const normalizedTarget = normalizeEpisode(target);
  if (normalizedTarget && !selected.includes(normalizedTarget)) selected.push(normalizedTarget);
  selected.sort(compareEpisodes);
  return selected;
}

function compareEpisodes(a, b) {
  const an = Number(a);
  const bn = Number(b);
  if (Number.isFinite(an) && Number.isFinite(bn)) return an - bn;
  return String(a).localeCompare(String(b), undefined, { numeric: true });
}

function highestEpisode(episodes) {
  return [...episodes].filter(Boolean).sort(compareEpisodes).at(-1) || null;
}

module.exports = {
  cleanTitle,
  queryTitle,
  parseEpisodeCount,
  preferredName,
  normalizeMode,
  normalizeEpisode,
  episodeKey,
  episodesThrough,
  compareEpisodes,
  highestEpisode,
};
