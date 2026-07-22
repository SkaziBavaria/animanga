'use strict';

const { cacheGet, cacheSet, trimCache } = require('./state');
const { cleanTitle } = require('./episodes');
const { fetchWithTimeout } = require('./upstream');

const JIKAN_BASE = 'https://api.jikan.moe/v4';
const KITSU_BASE = 'https://kitsu.io/api/edge';
const ANISKIP_BASE = 'https://api.aniskip.com/v2';
const MALID_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SKIP_CACHE_TTL_MS = 12 * 60 * 60 * 1000;

let rawFetcher = (url, options) => fetch(url, options);

function setRawFetcher(fn) {
  rawFetcher = fn || ((url, options) => fetch(url, options));
}

function normalizeTitleKey(title) {
  return cleanTitle(title || '').trim().toLowerCase();
}

async function fetchJson(url, headers = {}) {
  const res = await fetchWithTimeout(rawFetcher, url, { headers: { accept: 'application/json', ...headers } }, 12_000);
  if (!res.ok) throw new Error(`Request to ${url} failed with ${res.status}`);
  return res.json();
}

function pickBestMatch(candidates, title) {
  const target = normalizeTitleKey(title);
  if (!target) return candidates[0] || null;
  const exact = candidates.find((candidate) => {
    const names = [
      candidate.title,
      candidate.title_english,
      candidate.title_japanese,
      ...(candidate.titles || []).map((entry) => entry.title),
    ];
    return names.some((name) => name && normalizeTitleKey(name) === target);
  });
  return exact || candidates[0] || null;
}

async function resolveMalIdFromKitsu(title) {
  const data = await fetchJson(
    `${KITSU_BASE}/anime?filter[text]=${encodeURIComponent(title)}&include=mappings&page[limit]=5`,
    { accept: 'application/vnd.api+json' }
  );
  const mappings = new Map(
    (data?.included || [])
      .filter((item) => item?.type === 'mappings' && item.attributes?.externalSite === 'myanimelist/anime')
      .map((item) => [String(item.id), Number(item.attributes.externalId)])
  );
  const candidates = (data?.data || []).map((item) => {
    const attributes = item.attributes || {};
    const mappingRefs = item.relationships?.mappings?.data || [];
    const malId = mappingRefs.map((ref) => mappings.get(String(ref.id))).find(Number.isFinite) || null;
    return {
      mal_id: malId,
      title: attributes.canonicalTitle,
      title_english: attributes.titles?.en,
      title_japanese: attributes.titles?.ja_jp,
      titles: [attributes.titles?.en_jp, ...(attributes.abbreviatedTitles || [])]
        .filter(Boolean)
        .map((value) => ({ title: value })),
    };
  }).filter((item) => item.mal_id);
  return pickBestMatch(candidates, title)?.mal_id || null;
}

async function resolveMalId(state, title) {
  const key = normalizeTitleKey(title);
  if (!key) return null;
  const cached = cacheGet(state, 'malIds', key, MALID_CACHE_TTL_MS);
  if (cached?.malId) return cached.malId;

  let malId = null;
  try {
    const data = await fetchJson(`${JIKAN_BASE}/anime?q=${encodeURIComponent(title)}&limit=5`);
    const candidates = Array.isArray(data?.data) ? data.data : [];
    const best = pickBestMatch(candidates, title);
    malId = best?.mal_id || null;
  } catch {
    malId = null;
  }

  if (!malId) {
    try {
      malId = await resolveMalIdFromKitsu(title);
    } catch {
      malId = null;
    }
  }

  if (malId) {
    cacheSet(state, 'malIds', key, { malId });
    trimCache(state, 'malIds', 500);
  }
  return malId;
}

function extractSkipTimes(data) {
  const result = { op: null, ed: null };
  if (!data?.found) return result;
  for (const item of data.results || []) {
    const interval = item.interval || {};
    const entry = {
      start: Number(interval.startTime) || 0,
      end: Number(interval.endTime) || 0,
    };
    if (item.skipType === 'op') result.op = entry;
    else if (item.skipType === 'ed') result.ed = entry;
  }
  return result;
}

async function fetchSkipTimes(state, malId, episode, episodeLength) {
  if (!malId || !episode) return { op: null, ed: null };
  const key = `${malId}:${episode}:${Math.round(episodeLength || 0)}`;
  const cached = cacheGet(state, 'skipTimes', key, SKIP_CACHE_TTL_MS);
  if (cached?.op || cached?.ed) return cached;

  const params = new URLSearchParams();
  params.append('types', 'op');
  params.append('types', 'ed');
  if (episodeLength) params.set('episodeLength', String(Math.round(episodeLength)));

  let result = { op: null, ed: null };
  try {
    const data = await fetchJson(
      `${ANISKIP_BASE}/skip-times/${encodeURIComponent(malId)}/${encodeURIComponent(episode)}?${params.toString()}`
    );
    result = extractSkipTimes(data);
  } catch {
    result = { op: null, ed: null };
  }

  if (result.op || result.ed) {
    cacheSet(state, 'skipTimes', key, result);
    trimCache(state, 'skipTimes', 400);
  }
  return result;
}

async function getSkipTimesForTitle(state, title, episode, episodeLength) {
  const malId = await resolveMalId(state, title);
  if (!malId) return { op: null, ed: null, malId: null };
  const times = await fetchSkipTimes(state, malId, episode, episodeLength);
  return { ...times, malId };
}

module.exports = {
  resolveMalId,
  fetchSkipTimes,
  getSkipTimesForTitle,
  resolveMalIdFromKitsu,
  setRawFetcher,
};
