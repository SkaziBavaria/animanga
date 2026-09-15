'use strict';

function cleanTitle(title) {
  // Trim first, then match a single space before the suffix (not \s*) to avoid ReDoS.
  return String(title || '').trim().replace(/ \(\d+(?:\.\d+)? episodes?\)$/i, '');
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

function remapOutsideWatched(outside, episodes) {
  const listNums = (episodes || []).map(Number).filter(Number.isFinite).sort((left, right) => left - right);
  const watchedNums = (outside || []).map(Number).filter(Number.isFinite).sort((left, right) => left - right);
  if (!listNums.length || !watchedNums.length) return [];
  const minList = listNums[0];
  const maxList = listNums.at(-1);
  const minWatched = watchedNums[0];
  const maxWatched = watchedNums.at(-1);
  if (minWatched <= maxList) return [];
  if ((maxWatched - minWatched + 1) > (maxList - minList + 1)) return [];
  const offset = minWatched - minList;
  const remapped = watchedNums.map((value) => String(value - offset));
  const listSet = new Set((episodes || []).map(String));
  return remapped.every((episode) => listSet.has(episode)) ? remapped : [];
}

function alignWatchedEpisodesToList(watched, episodes) {
  const list = [...new Set((episodes || []).map(String).filter(Boolean))];
  const unique = [...new Set((watched || []).map(String).filter(Boolean))];
  if (!list.length || !unique.length) return unique.sort(compareEpisodes);
  const listSet = new Set(list);
  const inside = unique.filter((episode) => listSet.has(episode));
  const outside = unique.filter((episode) => !listSet.has(episode));
  if (!outside.length) return unique.sort(compareEpisodes);
  return [...new Set([...inside, ...remapOutsideWatched(outside, list)])].sort(compareEpisodes);
}

function episodeListForWatchAlignment(show = {}) {
  if (Array.isArray(show.episodes) && show.episodes.length) return show.episodes;
  const latest = Number(show.latestEpisode || show.episodeCount);
  if (!Number.isFinite(latest) || latest <= 0) return [];
  return episodesThrough([], latest);
}

function latestKnownEpisode(show = {}) {
  return highestEpisode(episodeListForWatchAlignment(show));
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
  alignWatchedEpisodesToList,
  episodeListForWatchAlignment,
  latestKnownEpisode,
};
