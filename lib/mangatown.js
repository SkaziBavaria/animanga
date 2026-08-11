'use strict';

// Maintenance reference: keiyoushi/extensions-source src/en/mangatown (Apache-2.0).

const { fetchWebText } = require('./anidb-fetch');
const { pickSafeResolverMatch } = require('./title-match');

const MANGATOWN_ORIGIN = 'https://www.mangatown.com';
const MAX_READER_PAGES = 500;
const PAGE_FETCH_CONCURRENCY = 4;

function decodeHtml(value) {
  return String(value || '')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>');
}

function attribute(tag, name) {
  return decodeHtml(tag.match(new RegExp(`\\b${name}=["']([^"']*)["']`, 'i'))?.[1] || '');
}

function absoluteUrl(value) {
  try {
    return new URL(value, `${MANGATOWN_ORIGIN}/`).href;
  } catch {
    return '';
  }
}

function parseSearchResults(html) {
  const rows = [];
  const seen = new Set();
  for (const match of String(html || '').matchAll(/<a\b[^>]*class=["'][^"']*\bmanga_cover\b[^"']*["'][^>]*>/gi)) {
    const tag = match[0];
    const path = attribute(tag, 'href');
    const name = attribute(tag, 'title');
    const slug = path.match(/^\/manga\/([^/]+)\/?$/i)?.[1];
    if (!slug || !name || seen.has(slug)) continue;
    seen.add(slug);
    rows.push({ id: slug, name: name.trim(), path: `/manga/${slug}/` });
  }
  return rows;
}

function parseChapterRows(html) {
  const section = String(html || '').match(/<ul\b[^>]*class=["'][^"']*\bchapter_list\b[^"']*["'][^>]*>([\s\S]*?)<\/ul>/i)?.[1] || '';
  const rows = [];
  const seen = new Set();
  for (const match of section.matchAll(/<a\b[^>]*>/gi)) {
    const path = attribute(match[0], 'href');
    const number = path.match(/\/c(-?\d+(?:\.\d+)?)\/?(?:["?#]|$)/i)?.[1];
    if (!number || seen.has(path)) continue;
    seen.add(path);
    rows.push({ path, number: String(Number(number)) });
  }
  return rows;
}

function parseReaderPagePaths(html) {
  const paths = [];
  const seen = new Set();
  for (const match of String(html || '').matchAll(/<option\b[^>]*value=["']([^"']+)["'][^>]*>/gi)) {
    const path = decodeHtml(match[1]);
    if (!/\/manga\/[^/]+\/c-?\d+(?:\.\d+)?\/\d+\.html(?:[?#].*)?$/i.test(path) || seen.has(path)) continue;
    seen.add(path);
    paths.push(path);
    if (paths.length >= MAX_READER_PAGES) break;
  }
  return paths;
}

function parseViewerImage(html) {
  const viewer = String(html || '').match(/<div\b[^>]*id=["']viewer["'][^>]*>([\s\S]*?)<\/div>/i)?.[1] || '';
  const tag = viewer.match(/<img\b[^>]*>/i)?.[0] || '';
  return absoluteUrl(attribute(tag, 'src') || attribute(tag, 'data-src'));
}

async function request(path, timeoutMs = 30_000) {
  const url = absoluteUrl(path);
  if (!url) throw new Error('MangaTown returned an invalid URL');
  return fetchWebText(url, {
    timeoutMs,
    retries: 2,
    headers: { Accept: 'text/html', Referer: `${MANGATOWN_ORIGIN}/` },
  });
}

async function mapBounded(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function run() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
  return results;
}

async function resolveTitle(names) {
  const candidates = [...new Set((Array.isArray(names) ? names : [names])
    .map((name) => String(name || '').trim()).filter(Boolean))];
  const rows = [];
  for (const name of candidates.slice(0, 5)) {
    rows.push(...parseSearchResults(await request(`/search?name=${encodeURIComponent(name)}`)));
  }
  const unique = [...new Map(rows.map((row) => [row.id, row])).values()];
  const match = pickSafeResolverMatch(candidates, unique);
  if (!match) throw new Error(`No safe MangaTown match for "${candidates[0] || ''}"`);
  return match;
}

async function getChapterPagesByTitle(names, chapter) {
  const title = await resolveTitle(names);
  const rows = parseChapterRows(await request(title.path));
  const wanted = String(chapter || '').replace(/^ch\.?\s*/i, '').trim();
  const row = rows.find((item) => item.number === wanted)
    || rows.find((item) => Number(item.number) === Number(wanted));
  if (!row) throw new Error(`MangaTown chapter ${chapter} not found for "${title.name}"`);

  const chapterHtml = await request(row.path, 45_000);
  const pagePaths = parseReaderPagePaths(chapterHtml);
  let urls;
  if (pagePaths.length) {
    const firstImage = parseViewerImage(chapterHtml);
    const remaining = firstImage
      ? pagePaths.filter((path) => !/\/1\.html(?:[?#].*)?$/i.test(path))
      : pagePaths;
    const fetched = await mapBounded(remaining, PAGE_FETCH_CONCURRENCY, async (path) => {
      const image = parseViewerImage(await request(path));
      if (!image) throw new Error(`MangaTown reader page had no image (${path})`);
      return image;
    });
    urls = firstImage ? [firstImage, ...fetched] : fetched;
  } else {
    urls = [parseViewerImage(chapterHtml)].filter(Boolean);
  }
  const pages = urls.map((url, index) => ({ number: index + 1, url }));
  if (!pages.length) throw new Error('MangaTown chapter had no readable pages');
  return {
    pages,
    notes: '',
    sourceName: 'MangaTown',
    uploadDate: null,
    referrer: `${MANGATOWN_ORIGIN}/`,
    resolvedTitle: title.name,
    verifiedTitleMatch: true,
    mangaTownTitleId: title.id,
  };
}

module.exports = {
  MANGATOWN_ORIGIN,
  parseSearchResults,
  parseChapterRows,
  parseReaderPagePaths,
  parseViewerImage,
  resolveTitle,
  getChapterPagesByTitle,
};
