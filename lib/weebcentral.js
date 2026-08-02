'use strict';

const { fetchWebText } = require('./anidb-fetch');

const WEEBCENTRAL_ORIGIN = 'https://weebcentral.com';
const titleCache = new Map();
const chapterCache = new Map();
const CACHE_TTL_MS = 30 * 60 * 1000;
const CACHE_LIMIT = 500;

function cached(map, key) {
  const entry = map.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    map.delete(key);
    return null;
  }
  return entry.value;
}

function remember(map, key, value) {
  if (map.size >= CACHE_LIMIT) map.delete(map.keys().next().value);
  map.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}

function decodeHtml(value) {
  const named = { amp: '&', quot: '"', lt: '<', gt: '>', apos: "'" };
  return String(value || '').replace(/&(?:#(\d+)|#x([0-9a-f]+)|(amp|quot|lt|gt|apos));/gi, (entity, decimal, hex, name) => {
    if (decimal) return String.fromCodePoint(Number(decimal));
    if (hex) return String.fromCodePoint(Number.parseInt(hex, 16));
    return named[String(name).toLowerCase()] || entity;
  });
}

function normalizeTitle(value) {
  return decodeHtml(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function request(url, { method = 'GET', form = null, timeoutMs = 45_000 } = {}) {
  return fetchWebText(url, {
    method,
    form,
    timeoutMs,
    ipv4: true,
    retries: 5,
    headers: {
      Accept: 'text/html',
      Referer: `${WEEBCENTRAL_ORIGIN}/`,
      ...(method === 'POST' ? { 'HX-Request': 'true' } : {}),
    },
  });
}

function parseSearchResults(html) {
  const rows = [];
  const seen = new Set();
  const pattern = /href="https?:\/\/weebcentral\.com\/series\/([A-Z0-9]+)\/([^"?]+)"[\s\S]{0,800}?<img[^>]+alt="([^"]+) cover"/gi;
  for (const match of String(html || '').matchAll(pattern)) {
    if (seen.has(match[1])) continue;
    seen.add(match[1]);
    rows.push({ id: match[1], slug: match[2], name: decodeHtml(match[3]).trim() });
  }
  return rows;
}

function parseChapterRows(html) {
  const rows = [];
  const seen = new Set();
  const pattern = /href="\/chapters\/([A-Z0-9]+)"[\s\S]{0,700}?<span[^>]*>\s*(?:Chapter|Episode)\s+([^<]+)<\/span>/gi;
  for (const match of String(html || '').matchAll(pattern)) {
    const number = match[2].trim();
    if (!number || seen.has(match[1])) continue;
    seen.add(match[1]);
    rows.push({ chapterId: match[1], number });
  }
  return rows;
}

function parseChapterImages(html) {
  const urls = [];
  const seen = new Set();
  for (const match of String(html || '').matchAll(/(?:src|data-src)="(https?:\/\/[^"]+\.(?:jpg|jpeg|png|webp)(?:\?[^"]*)?)"/gi)) {
    const url = decodeHtml(match[1]);
    if (seen.has(url) || /cover|brand|icon|logo/i.test(url)) continue;
    seen.add(url);
    urls.push(url);
  }
  return urls.map((url, index) => ({ number: index + 1, url }));
}

async function resolveTitle(names) {
  const candidates = [...new Set((Array.isArray(names) ? names : [names]).map((name) => String(name || '').trim()).filter(Boolean))];
  const loose = [];
  for (const name of candidates) {
    const key = normalizeTitle(name);
    const existing = cached(titleCache, key);
    if (existing) return existing;
    const html = await request(`${WEEBCENTRAL_ORIGIN}/search/simple?location=main`, {
      method: 'POST', form: { text: name },
    });
    const rows = parseSearchResults(html);
    const exact = rows.find((row) => normalizeTitle(row.name) === key);
    if (exact) {
      for (const candidate of candidates) remember(titleCache, normalizeTitle(candidate), exact);
      return exact;
    }
    const partial = rows.find((row) => normalizeTitle(row.name).includes(key) || key.includes(normalizeTitle(row.name)));
    if (partial) loose.push(partial);
  }
  const match = loose[0];
  if (!match) throw new Error(`No Weeb Central match for "${candidates[0] || ''}"`);
  for (const candidate of candidates) remember(titleCache, normalizeTitle(candidate), match);
  return match;
}

async function getChapterPagesByTitle(names, chapter) {
  const candidates = Array.isArray(names) ? names : [names];
  const title = await resolveTitle(candidates);
  let rows = cached(chapterCache, title.id);
  if (!rows) {
    const listHtml = await request(`${WEEBCENTRAL_ORIGIN}/series/${title.id}/full-chapter-list`);
    rows = parseChapterRows(listHtml);
    remember(chapterCache, title.id, rows);
  }
  const wanted = String(chapter || '').replace(/^ch\.?\s*/i, '').trim();
  const row = rows.find((item) => item.number === wanted)
    || rows.find((item) => Number(item.number) === Number(wanted));
  if (!row) throw new Error(`Weeb Central chapter ${chapter} not found for "${candidates[0]}"`);
  const imagesHtml = await request(`${WEEBCENTRAL_ORIGIN}/chapters/${row.chapterId}/images?is_prev=False&current_page=1&reading_style=long_strip`);
  const pages = parseChapterImages(imagesHtml);
  if (!pages.length) throw new Error('Weeb Central chapter had no readable pages');
  return {
    pages, notes: '', sourceName: 'Weeb Central', uploadDate: null,
    referrer: `${WEEBCENTRAL_ORIGIN}/`, weebCentralTitleId: title.id, weebCentralChapterId: row.chapterId,
  };
}

function resetForTests() {
  titleCache.clear();
  chapterCache.clear();
}

module.exports = {
  WEEBCENTRAL_ORIGIN, parseSearchResults, parseChapterRows, parseChapterImages,
  resolveTitle, getChapterPagesByTitle, resetForTests,
};
