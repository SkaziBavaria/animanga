'use strict';

// Qi Scans exposes its reader data through the Qi Manga JSON API.
const { fetchWebText } = require('./web-fetch');
const { pickSafeResolverMatch } = require('./title-match');

const QISCANS_API = 'https://api.qimanga.com/api/v1';
const QISCANS_ORIGIN = 'https://qimanga.com';
const QISCANS_HEADERS = {
  Accept: 'application/json, text/plain, */*',
  Origin: QISCANS_ORIGIN,
  Referer: `${QISCANS_ORIGIN}/`,
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-site',
};

async function request(path) {
  const body = await fetchWebText(`${QISCANS_API}${path}`, {
    timeoutMs: 30_000,
    headers: QISCANS_HEADERS,
    retries: 2,
  });
  try {
    return JSON.parse(body);
  } catch {
    throw new Error('Qi Scans returned non-JSON data');
  }
}

function parseSeriesSearch(payload) {
  return (Array.isArray(payload?.data) ? payload.data : [])
    .filter((item) => item?.slug && item?.title)
    .map((item) => ({ id: String(item.slug), slug: String(item.slug), name: String(item.title) }));
}

async function resolveTitle(names) {
  const candidates = [...new Set((Array.isArray(names) ? names : [names])
    .map((name) => String(name || '').trim()).filter(Boolean))];
  const found = [];
  for (const name of candidates.slice(0, 5)) {
    const params = new URLSearchParams({ page: '1', perPage: '20', q: name });
    const rows = parseSeriesSearch(await request(`/series/search?${params}`));
    found.push(...rows);
  }
  const unique = [...new Map(found.map((row) => [row.slug, row])).values()];
  const match = pickSafeResolverMatch(candidates, unique);
  if (!match) throw new Error(`No safe Qi Scans match for "${candidates[0] || ''}"`);
  return match;
}

function normalizeChapterNumber(value) {
  const text = String(value ?? '').replace(/^ch\.?\s*/i, '').trim();
  if (!/^\d+(?:\.\d+)?$/.test(text)) return null;
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}

async function getChapterPagesByTitle(names, chapter) {
  const candidates = Array.isArray(names) ? names : [names];
  const title = await resolveTitle(candidates);
  const wanted = normalizeChapterNumber(chapter);
  if (wanted == null) throw new Error('Invalid Qi Scans chapter number');
  const chapterBase = `/series/${encodeURIComponent(title.slug)}/chapters`;
  let list = await request(`${chapterBase}?page=1&perPage=100&sort=desc`);
  let matches = [];
  let currentPage = 1;
  const lastPage = Math.max(1, Math.min(100, Number(list?.totalPages) || 1));
  while (true) {
    matches.push(...(Array.isArray(list?.data) ? list.data : [])
      .filter((item) => normalizeChapterNumber(item?.number) === wanted));
    if (matches.length || currentPage >= lastPage) break;
    currentPage += 1;
    list = await request(`${chapterBase}?page=${currentPage}&perPage=100&sort=desc`);
  }
  if (matches.length > 1) throw new Error(`Ambiguous Qi Scans chapter ${chapter}`);
  const row = matches[0];
  if (!row?.slug) throw new Error(`Qi Scans chapter ${chapter} not found for "${title.name}"`);

  const data = await request(`/series/${encodeURIComponent(title.slug)}/chapters/${encodeURIComponent(row.slug)}`);
  if (data?.requiresPurchase === true || data?.isFree === false) {
    throw new Error(`Qi Scans chapter ${chapter} requires purchase`);
  }
  const images = Array.isArray(data?.images) ? data.images : [];
  const pages = images
    .filter((image) => typeof image?.url === 'string' && /^https:\/\//i.test(image.url))
    .sort((a, b) => Number(a.order || 0) - Number(b.order || 0))
    .map((image, index) => ({ number: index + 1, url: image.url }));
  if (!pages.length) throw new Error(`Qi Scans chapter ${chapter} has no readable pages`);

  return {
    pages,
    notes: '',
    sourceName: 'Qi Scans',
    uploadDate: row.createdAt || null,
    referrer: `${QISCANS_ORIGIN}/`,
    resolvedTitle: title.name,
    verifiedTitleMatch: true,
    qiScansTitleSlug: title.slug,
    qiScansChapterSlug: row.slug,
  };
}

module.exports = {
  QISCANS_API,
  QISCANS_ORIGIN,
  parseSeriesSearch,
  resolveTitle,
  getChapterPagesByTitle,
};
