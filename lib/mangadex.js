'use strict';

// Maintenance reference: keiyoushi/extensions-source src/all/mangadex (Apache-2.0).

const { fetchWebText } = require('./web-fetch');
const { MANGADEX_API } = require('./config');
const { pickSafeResolverMatch } = require('./title-match');

const MANGADEX_ORIGIN = 'https://mangadex.org';
const AT_HOME_CACHE_MS = 4 * 60 * 1000;
const atHomeCache = new Map();
const atHomeRequests = new Map();

function rememberAtHomePayload(id, payload) {
  if (atHomeCache.size >= 500 && !atHomeCache.has(id)) {
    atHomeCache.delete(atHomeCache.keys().next().value);
  }
  atHomeCache.set(id, { payload, fetchedAt: Date.now() });
}

async function requestJson(path, timeoutMs = 30_000) {
  const body = await fetchWebText(`${MANGADEX_API}${path}`, {
    timeoutMs,
    retries: 2,
    headers: { Accept: 'application/json', Referer: `${MANGADEX_ORIGIN}/` },
  });
  try {
    return JSON.parse(body);
  } catch {
    throw new Error('MangaDex returned non-JSON');
  }
}

function mangaNames(attributes = {}) {
  return [...new Set([
    ...Object.values(attributes.title || {}),
    ...Object.values(attributes.altTitles || {}).flatMap((value) => (
      value && typeof value === 'object' ? Object.values(value) : []
    )),
  ].map(String).map((name) => name.trim()).filter(Boolean))];
}

function parseSearchResults(payload) {
  return (payload?.data || []).flatMap((item) => {
    const names = mangaNames(item?.attributes);
    return names.length ? [{ id: item.id, name: names[0], names }] : [];
  });
}

function parseChapterRows(payload) {
  return (payload?.data || []).flatMap((item) => {
    const number = item?.attributes?.chapter;
    if (number == null || item?.attributes?.externalUrl) return [];
    return [{ id: item.id, number: String(number), translatedLanguage: item.attributes.translatedLanguage || '' }];
  });
}

function parseAtHomePages(payload) {
  const baseUrl = String(payload?.baseUrl || '').replace(/\/$/, '');
  const hash = payload?.chapter?.hash;
  const files = payload?.chapter?.data;
  if (!baseUrl || !hash || !Array.isArray(files)) return [];
  return files.map((filename, index) => ({
    number: index + 1,
    url: `${baseUrl}/data/${encodeURIComponent(hash)}/${encodeURIComponent(filename)}`,
  }));
}

async function getAtHomePayload(chapterId) {
  const id = String(chapterId || '');
  const cached = atHomeCache.get(id);
  if (cached && Date.now() - cached.fetchedAt < AT_HOME_CACHE_MS) return cached.payload;
  if (atHomeRequests.has(id)) return atHomeRequests.get(id);
  const request = requestJson(`/at-home/server/${encodeURIComponent(id)}`).then((payload) => {
    rememberAtHomePayload(id, payload);
    return payload;
  }).finally(() => atHomeRequests.delete(id));
  atHomeRequests.set(id, request);
  return request;
}

async function getAtHomePageUrl(chapterId, imagePath) {
  const payload = await getAtHomePayload(chapterId);
  const baseUrl = String(payload?.baseUrl || '').replace(/\/$/, '');
  const chapter = payload?.chapter || {};
  const parts = String(imagePath || '').split('/');
  if (!baseUrl || !chapter.hash || parts.length !== 3 || parts[0] !== ''
    || !['data', 'data-saver'].includes(parts[1]) || !parts[2]) {
    throw new Error('MangaDex returned invalid at-home image metadata');
  }
  const base = new URL(baseUrl);
  if (base.protocol !== 'https:') throw new Error('MangaDex returned an insecure at-home URL');
  return `${baseUrl}/${parts[1]}/${encodeURIComponent(chapter.hash)}/${parts[2]}`;
}

async function resolveTitle(names) {
  const candidates = [...new Set((Array.isArray(names) ? names : [names])
    .map((name) => String(name || '').trim()).filter(Boolean))];
  const rows = [];
  for (const name of candidates.slice(0, 5)) {
    const payload = await requestJson(`/manga?title=${encodeURIComponent(name)}&limit=20`);
    rows.push(...parseSearchResults(payload));
  }
  const unique = [...new Map(rows.map((row) => [row.id, row])).values()];
  const expanded = unique.flatMap((row) => row.names.map((name) => ({ id: row.id, name, manga: row })));
  const match = pickSafeResolverMatch(candidates, expanded);
  if (!match) throw new Error(`No safe MangaDex match for "${candidates[0] || ''}"`);
  return { ...match.manga, matchedName: match.name };
}

async function findChapter(mangaId, chapter) {
  const wanted = String(chapter || '').replace(/^ch\.?\s*/i, '').trim();
  const params = new URLSearchParams({
    limit: '100',
    'translatedLanguage[]': 'en',
    'order[volume]': 'asc',
    'order[chapter]': 'asc',
  });
  for (let offset = 0; offset < 10_000; offset += 100) {
    params.set('offset', String(offset));
    const payload = await requestJson(`/manga/${encodeURIComponent(mangaId)}/feed?${params}`);
    const rows = parseChapterRows(payload);
    const match = rows.find((row) => row.number === wanted)
      || rows.find((row) => Number(row.number) === Number(wanted));
    if (match) return match;
    const batchLength = Array.isArray(payload?.data) ? payload.data.length : 0;
    if (!payload?.total || offset + batchLength >= payload.total || batchLength < 100) break;
  }
  return null;
}

async function getChapterPagesByTitle(names, chapter) {
  const title = await resolveTitle(names);
  const row = await findChapter(title.id, chapter);
  if (!row) throw new Error(`MangaDex chapter ${chapter} not found for "${title.matchedName}"`);
  const payload = await getAtHomePayload(row.id);
  const pages = parseAtHomePages(payload);
  if (!pages.length) throw new Error('MangaDex chapter had no readable pages');
  return {
    pages,
    notes: '',
    sourceName: 'MangaDex',
    uploadDate: null,
    referrer: `${MANGADEX_ORIGIN}/`,
    resolvedTitle: title.matchedName,
    verifiedTitleMatch: true,
    mangaDexTitleId: title.id,
    mangaDexChapterId: row.id,
  };
}

module.exports = {
  MANGADEX_ORIGIN,
  parseSearchResults,
  parseChapterRows,
  parseAtHomePages,
  getAtHomePageUrl,
  resolveTitle,
  getChapterPagesByTitle,
};
