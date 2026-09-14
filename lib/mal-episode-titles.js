'use strict';

const { cacheGet, cacheSet, trimCache } = require('./state');
const { fetchWithTimeout } = require('./upstream');
const { pickSafeResolverMatch, resolvedTitleMatchesAny } = require('./title-match');
const { normalizeEpisode } = require('./episodes');

const JIKAN_BASE = 'https://api.jikan.moe/v4';
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_PAGES = 8;

let rawFetcher = (url, options) => fetch(url, options);

function setRawFetcher(fn) {
  rawFetcher = fn || ((url, options) => fetch(url, options));
}

function usableEpisodeTitle(value) {
  const title = String(value || '').replace(/\s+/g, ' ').trim();
  if (!title || /^episode\s*\d+(?:\.\d+)?$/i.test(title)) return '';
  return title;
}

function showNames(details) {
  return [details.sourceName, details.englishName, details.nativeName, details.name, details.title]
    .map((value) => String(value || '').trim())
    .filter(Boolean);
}

function malAliases(anime) {
  return [
    anime?.title,
    anime?.title_english,
    anime?.title_japanese,
    ...((anime?.titles || []).map((entry) => entry?.title)),
  ].map((value) => String(value || '').trim()).filter(Boolean);
}

async function fetchJson(url) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const res = await fetchWithTimeout(rawFetcher, url, { headers: { accept: 'application/json' } }, 12_000);
      if (res.status === 429 || res.status === 503 || res.status === 504) {
        lastError = new Error(`Episode title lookup failed with ${res.status}`);
        await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
        continue;
      }
      if (!res.ok) throw new Error(`Episode title lookup failed with ${res.status}`);
      return res.json();
    } catch (error) {
      lastError = error;
      if (attempt === 3) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
    }
  }
  throw lastError;
}

function parseEpisodeRows(payload) {
  return (payload?.data || []).map((row) => ({
    number: normalizeEpisode(row?.mal_id),
    title: usableEpisodeTitle(row?.title) || usableEpisodeTitle(row?.title_romanji),
  })).filter((row) => row.number && row.title);
}

async function fetchMalEpisodeTitles(malId) {
  const titles = {};
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const payload = await fetchJson(`${JIKAN_BASE}/anime/${encodeURIComponent(malId)}/episodes?page=${page}`);
    for (const row of parseEpisodeRows(payload)) titles[row.number] = row.title;
    if (!payload?.pagination?.has_next_page) break;
  }
  return titles;
}

async function assertMalIdentity(malId, names) {
  const payload = await fetchJson(`${JIKAN_BASE}/anime/${encodeURIComponent(malId)}`);
  const aliases = malAliases(payload?.data);
  if (!aliases.some((alias) => resolvedTitleMatchesAny(alias, names))) {
    throw new Error('Episode title source returned a different work');
  }
  return Number(malId);
}

async function resolveMalIdFromNames(names) {
  const query = names[0];
  if (!query) return null;
  const payload = await fetchJson(`${JIKAN_BASE}/anime?q=${encodeURIComponent(query)}&limit=5`);
  const rows = (payload?.data || []).map((item) => ({
    id: item.mal_id,
    name: item.title_english || item.title,
    aliases: malAliases(item),
  })).filter((row) => row.id && row.name);
  const match = pickSafeResolverMatch(names, rows);
  if (!match || !match.aliases.some((alias) => resolvedTitleMatchesAny(alias, names))) return null;
  return Number(match.id);
}

async function enrichEpisodeTitles(state, details) {
  const episodes = Array.isArray(details?.episodes) ? details.episodes.map(String) : [];
  const existing = { ...(details?.episodeTitles || {}) };
  const missing = episodes.filter((episode) => !usableEpisodeTitle(existing[episode]));
  if (!missing.length) return details;

  const names = showNames(details);
  const storedMalId = Number(details.malId);
  const cacheKey = Number.isFinite(storedMalId) && storedMalId > 0 ? `id:${storedMalId}` : `title:${names[0] || ''}`;
  let cached = cacheGet(state, 'malEpisodeTitles', cacheKey, CACHE_TTL_MS);

  if (!cached?.titles) {
    try {
      const malId = Number.isFinite(storedMalId) && storedMalId > 0
        ? await assertMalIdentity(storedMalId, names)
        : await resolveMalIdFromNames(names);
      if (!malId) return details;
      cached = { malId, titles: await fetchMalEpisodeTitles(malId) };
      cacheSet(state, 'malEpisodeTitles', cacheKey, cached);
      trimCache(state, 'malEpisodeTitles', 80);
    } catch {
      return details;
    }
  }

  const episodeTitles = { ...existing };
  for (const episode of missing) {
    const title = usableEpisodeTitle(cached.titles[episode]);
    if (title) episodeTitles[episode] = title;
  }
  return {
    ...details,
    episodeTitles,
    ...(cached.malId && !details.malId ? { malId: cached.malId } : {}),
  };
}

module.exports = {
  usableEpisodeTitle,
  enrichEpisodeTitles,
  setRawFetcher,
};
