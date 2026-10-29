'use strict';

// Maintenance reference: keiyoushi/extensions-source src/en/weebcentral (Apache-2.0).

const { fetchWebText } = require('./web-fetch');
const { normalizeResolverTitle, pickSafeResolverMatch } = require('./title-match');

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
  return normalizeResolverTitle(decodeHtml(value));
}

function normalizeSearchQuery(value) {
  return String(value || '').replace(/[!#:(),-]/g, ' ').replace(/\s+/g, ' ').trim();
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
  const pattern = /<a\b[^>]*href=["'](?:https:\/\/weebcentral\.com)?\/chapters\/([A-Z0-9]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of String(html || '').matchAll(pattern)) {
    const text = decodeHtml(match[2].replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
    // Season-local numbering cannot be mapped to catalog chapters by list position.
    if (/\b(?:Season|S)\s*\d+/i.test(text)) continue;
    const number = text.match(/^(?:Chapter|Episode)\s+(\d+(?:\.\d+)?)(?=\s|$)/i)?.[1];
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
  const found = [];
  for (const name of candidates) {
    const key = normalizeTitle(name);
    const existing = cached(titleCache, key);
    if (existing) return existing;
    const html = await request(`${WEEBCENTRAL_ORIGIN}/search/simple?location=main`, {
      method: 'POST', form: { text: normalizeSearchQuery(name) },
    });
    const rows = parseSearchResults(html);
    const exact = rows.find((row) => candidates.some((candidate) => normalizeTitle(candidate) === normalizeTitle(row.name)));
    if (exact) {
      for (const candidate of candidates) remember(titleCache, normalizeTitle(candidate), exact);
      return exact;
    }
    found.push(...rows);
  }
  const unique = [...new Map(found.map((row) => [row.id, row])).values()];
  const match = pickSafeResolverMatch(candidates, unique);
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
  if (!/^\d+(?:\.\d+)?$/.test(wanted)) throw new Error('Invalid Weeb Central chapter number');
  const matches = rows.filter((item) => Number(item.number) === Number(wanted));
  if (matches.length > 1) throw new Error(`Ambiguous Weeb Central chapter ${chapter}`);
  const row = matches[0];
  if (!row) throw new Error(`Weeb Central chapter ${chapter} not found for "${candidates[0]}"`);
  const imagesHtml = await request(`${WEEBCENTRAL_ORIGIN}/chapters/${row.chapterId}/images?is_prev=False&current_page=1&reading_style=long_strip`);
  const pages = parseChapterImages(imagesHtml);
  if (!pages.length) throw new Error('Weeb Central chapter had no readable pages');
  return {
    pages, notes: '', sourceName: 'Weeb Central', uploadDate: null,
    referrer: `${WEEBCENTRAL_ORIGIN}/`, resolvedTitle: title.name, verifiedTitleMatch: true,
    weebCentralTitleId: title.id, weebCentralChapterId: row.chapterId,
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
