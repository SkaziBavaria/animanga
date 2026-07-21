'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DATA_DIR, USER_AGENT } = require('./config');

const CACHE_DIR = path.join(DATA_DIR, 'manga-cache');

function safePart(value) {
  const text = String(value || 'unknown');
  const slug = text.replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'item';
  return `${slug}-${crypto.createHash('sha256').update(text).digest('hex').slice(0, 10)}`;
}

function chapterDir(id, language, chapter) {
  return path.join(CACHE_DIR, safePart(id), safePart(language || 'sub'), safePart(chapter));
}

function manifestPath(id, language, chapter) {
  return path.join(chapterDir(id, language, chapter), 'manifest.json');
}

function readManifest(id, language, chapter) {
  try { return JSON.parse(fs.readFileSync(manifestPath(id, language, chapter), 'utf8')); } catch { return null; }
}

function writeManifest(id, language, chapter, manifest) {
  const dir = chapterDir(id, language, chapter);
  fs.mkdirSync(dir, { recursive: true });
  const target = manifestPath(id, language, chapter);
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(manifest, null, 2));
  fs.renameSync(temporary, target);
  return manifest;
}

function cacheChapter(id, language, chapter, result) {
  const existing = readManifest(id, language, chapter);
  if (existing?.downloaded && existing.pages?.length) return existing;
  return writeManifest(id, language, chapter, {
    id, language, chapter: String(chapter), downloaded: false,
    pages: result.pages || [], notes: result.notes || '', sourceName: result.sourceName || '',
    uploadDate: result.uploadDate || null,
    updatedAt: new Date().toISOString(),
  });
}

function extensionFor(url, contentType) {
  const type = String(contentType || '').split(';')[0];
  const known = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif', 'image/avif': '.avif' };
  if (known[type]) return known[type];
  const ext = path.extname(new URL(url).pathname).toLowerCase();
  return /^\.(jpg|jpeg|png|webp|gif|avif)$/.test(ext) ? ext : '.img';
}

async function downloadChapter(id, language, chapter, result) {
  const dir = chapterDir(id, language, chapter);
  fs.mkdirSync(dir, { recursive: true });
  const pages = [];
  for (const [index, page] of (result.pages || []).entries()) {
    const response = await fetch(page.url, { headers: { 'user-agent': USER_AGENT, referer: 'https://allmanga.to/' } });
    if (!response.ok) throw new Error(`Page ${page.number || index + 1} returned ${response.status}`);
    const extension = extensionFor(page.url, response.headers.get('content-type'));
    const filename = `${String(index + 1).padStart(4, '0')}${extension}`;
    const target = path.join(dir, filename);
    const temporary = `${target}.part`;
    fs.writeFileSync(temporary, Buffer.from(await response.arrayBuffer()));
    fs.renameSync(temporary, target);
    pages.push({ number: page.number || index + 1, filename, contentType: response.headers.get('content-type') || 'application/octet-stream' });
  }
  return writeManifest(id, language, chapter, {
    id, language, chapter: String(chapter), downloaded: true, pages,
    notes: result.notes || '', sourceName: result.sourceName || '', updatedAt: new Date().toISOString(),
    uploadDate: result.uploadDate || null,
  });
}

function presentPages(id, language, chapter, manifest) {
  if (!manifest?.downloaded) return manifest;
  return {
    ...manifest,
    pages: manifest.pages.map((page) => ({
      number: page.number,
      url: `/api/manga/${encodeURIComponent(id)}/chapters/${encodeURIComponent(chapter)}/pages/${encodeURIComponent(page.number)}`,
      local: true,
    })),
  };
}

function listDownloads(id, language = 'sub') {
  const languageDir = path.join(CACHE_DIR, safePart(id), safePart(language));
  try {
    return fs.readdirSync(languageDir, { withFileTypes: true }).filter((entry) => entry.isDirectory())
      .map((entry) => {
        try { return JSON.parse(fs.readFileSync(path.join(languageDir, entry.name, 'manifest.json'), 'utf8')); } catch { return null; }
      })
      .filter((item) => item?.downloaded)
      .map((item) => ({ chapter: item.chapter, pages: item.pages.length, updatedAt: item.updatedAt }));
  } catch { return []; }
}

function cachedChapterDates(id, language = 'sub') {
  const languageDir = path.join(CACHE_DIR, safePart(id), safePart(language));
  try {
    return Object.fromEntries(fs.readdirSync(languageDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).flatMap((entry) => {
      try {
        const manifest = JSON.parse(fs.readFileSync(path.join(languageDir, entry.name, 'manifest.json'), 'utf8'));
        return manifest.uploadDate ? [[String(manifest.chapter), manifest.uploadDate]] : [];
      } catch { return []; }
    }));
  } catch { return {}; }
}

function localPage(id, language, chapter, number) {
  const manifest = readManifest(id, language, chapter);
  const page = manifest?.downloaded && manifest.pages.find((item) => String(item.number) === String(number));
  if (!page) return null;
  const file = path.join(chapterDir(id, language, chapter), page.filename);
  return fs.existsSync(file) ? { file, contentType: page.contentType } : null;
}

function deleteDownload(id, language, chapter) {
  const dir = chapterDir(id, language, chapter);
  const manifest = readManifest(id, language, chapter);
  if (!manifest?.downloaded) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

module.exports = { cacheChapter, readManifest, presentPages, downloadChapter, listDownloads, cachedChapterDates, localPage, deleteDownload };
