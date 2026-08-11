'use strict';

const { fetchWebText } = require('./anidb-fetch');
const { pickSafeResolverMatch } = require('./title-match');

const MANGAPILL_ORIGIN = 'https://mangapill.com';

function decodeHtml(value) {
  return String(value || '')
    .replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>');
}

function plainText(value) {
  return decodeHtml(String(value || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
}

function parseSearchResults(html) {
  const rows = [];
  const seen = new Set();
  const pattern = /<a\b[^>]*href=["'](?:https?:\/\/(?:www\.)?mangapill\.com)?(\/manga\/([^/"']+)\/([^"']+))["'][^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of String(html || '').matchAll(pattern)) {
    const body = match[4];
    const alt = body.match(/<img\b[^>]*alt=["']([^"']+)["']/i)?.[1];
    const name = plainText(alt || body).replace(/\s+cover$/i, '').trim();
    if (!name || seen.has(match[1])) continue;
    seen.add(match[1]);
    rows.push({ id: match[2], slug: match[3], name, path: match[1] });
  }
  return rows;
}

function parseChapterRows(html) {
  const rows = [];
  const seen = new Set();
  const pattern = /<a\b[^>]*href=["'](?:https?:\/\/(?:www\.)?mangapill\.com)?(\/chapters\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of String(html || '').matchAll(pattern)) {
    const text = plainText(match[2]);
    const number = text.match(/(?:chapter|ch\.?|episode)\s*([0-9]+(?:\.[0-9]+)?)/i)?.[1]
      || match[1].match(/(?:chapter|ch)-([0-9]+(?:\.[0-9]+)?)(?:-|$)/i)?.[1];
    if (!number || seen.has(match[1])) continue;
    seen.add(match[1]);
    rows.push({ path: match[1], number });
  }
  return rows;
}

function parseChapterImages(html) {
  const pages = [];
  const seen = new Set();
  const pattern = /<img\b[^>]*(?:data-src|src)=["'](https?:\/\/[^"']+)["'][^>]*>/gi;
  for (const match of String(html || '').matchAll(pattern)) {
    const tag = match[0];
    const url = decodeHtml(match[1]);
    if (!/page\s*\d+/i.test(tag) && !/(read|manga|chapter|cdn)/i.test(url)) continue;
    if (seen.has(url) || /logo|icon|avatar|cover/i.test(url)) continue;
    seen.add(url);
    pages.push({ number: pages.length + 1, url });
  }
  return pages;
}

async function request(path, timeoutMs = 30_000) {
  return fetchWebText(`${MANGAPILL_ORIGIN}${path}`, {
    timeoutMs,
    headers: { Accept: 'text/html', Referer: `${MANGAPILL_ORIGIN}/` },
    retries: 2,
  });
}

async function resolveTitle(names) {
  const candidates = [...new Set((names || []).map(String).map((name) => name.trim()).filter(Boolean))];
  const rows = [];
  for (const name of candidates.slice(0, 5)) {
    rows.push(...parseSearchResults(await request(`/search?q=${encodeURIComponent(name)}`)));
  }
  const unique = [...new Map(rows.map((row) => [row.path, row])).values()];
  const match = pickSafeResolverMatch(candidates, unique);
  if (!match) throw new Error(`No safe MangaPill match for "${candidates[0] || ''}"`);
  return match;
}

async function getChapterPagesByTitle(names, chapter) {
  const title = await resolveTitle(Array.isArray(names) ? names : [names]);
  const rows = parseChapterRows(await request(title.path));
  const wanted = String(chapter || '').replace(/^ch\.?\s*/i, '').trim();
  const row = rows.find((item) => item.number === wanted)
    || rows.find((item) => Number(item.number) === Number(wanted));
  if (!row) throw new Error(`MangaPill chapter ${chapter} not found for "${title.name}"`);
  const pages = parseChapterImages(await request(row.path));
  if (!pages.length) throw new Error('MangaPill chapter had no readable pages');
  return {
    pages, notes: '', sourceName: 'MangaPill', uploadDate: null,
    referrer: `${MANGAPILL_ORIGIN}/`, resolvedTitle: title.name, verifiedTitleMatch: true,
    mangaPillTitleId: title.id,
  };
}

module.exports = {
  MANGAPILL_ORIGIN, parseSearchResults, parseChapterRows, parseChapterImages,
  resolveTitle, getChapterPagesByTitle,
};
