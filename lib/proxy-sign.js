'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { ACCESS_TOKEN, DATA_DIR, DEFAULT_MEDIA_REFERER } = require('./config');
const { privateDirectory, privateFile } = require('./state');

const PROXY_TTL_MEDIA_SECONDS = 6 * 60 * 60;
const PROXY_TTL_COVER_SECONDS = 24 * 60 * 60;
const MANGA_REFERRER = 'https://weebcentral.com/';

let cachedSecret;

function proxySigningSecret() {
  if (cachedSecret) return cachedSecret;
  const fromEnv = String(process.env.ANIMANGA_PROXY_SECRET || '').trim();
  if (fromEnv) {
    cachedSecret = fromEnv;
    return cachedSecret;
  }
  if (ACCESS_TOKEN) {
    cachedSecret = ACCESS_TOKEN;
    return cachedSecret;
  }
  const file = path.join(DATA_DIR, '.proxy-secret');
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing) {
      privateDirectory(DATA_DIR);
      privateFile(file);
      cachedSecret = existing;
      return cachedSecret;
    }
  } catch {}
  privateDirectory(DATA_DIR);
  const secret = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(file, `${secret}\n`, { encoding: 'utf8', mode: 0o600 });
  privateFile(file);
  cachedSecret = secret;
  return cachedSecret;
}

function resetProxySecretForTests() {
  cachedSecret = undefined;
}

function signPayload(url, referrer, exp) {
  return crypto
    .createHmac('sha256', proxySigningSecret())
    .update(`${exp}\n${url}\n${referrer || ''}`)
    .digest('base64url');
}

function buildProxyPath(targetUrl, referrer = DEFAULT_MEDIA_REFERER, { ttlSeconds = PROXY_TTL_MEDIA_SECONDS } = {}) {
  const url = String(targetUrl || '').trim();
  if (!url) throw new Error('Missing proxy target url');
  const exp = String(Math.floor(Date.now() / 1000) + Math.max(60, Number(ttlSeconds) || PROXY_TTL_MEDIA_SECONDS));
  const ref = String(referrer || '');
  const sig = signPayload(url, ref, exp);
  const params = new URLSearchParams({ url, exp, sig });
  if (ref) params.set('referrer', ref);
  return `/api/proxy?${params.toString()}`;
}

function mangaDexPagePayload(chapterId, imagePath) {
  return `mangadex-page\n${chapterId}\n${imagePath}`;
}

function validateMangaDexPage(chapterId, imagePath) {
  if (!/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(String(chapterId || ''))) {
    const error = new Error('Invalid MangaDex chapter id');
    error.status = 400;
    throw error;
  }
  const path = String(imagePath || '');
  let decoded;
  try { decoded = decodeURIComponent(path); } catch {
    const error = new Error('Invalid MangaDex image path');
    error.status = 400;
    throw error;
  }
  const parts = decoded.split('/');
  if (!path.startsWith('/') || path.includes('?') || path.includes('#')
    || !['data', 'data-saver'].includes(parts[1]) || parts.length !== 3
    || parts.some((part, index) => index > 0 && (!part || part === '.' || part === '..' || /[\\\u0000-\u001f]/.test(part)))) {
    const error = new Error('Invalid MangaDex image path');
    error.status = 400;
    throw error;
  }
  return path;
}

function buildMangaDexProxyPath(chapterId, imagePath, { ttlSeconds = PROXY_TTL_MEDIA_SECONDS } = {}) {
  const path = validateMangaDexPage(chapterId, imagePath);
  const chapter = String(chapterId);
  const exp = String(Math.floor(Date.now() / 1000) + Math.max(60, Number(ttlSeconds) || PROXY_TTL_MEDIA_SECONDS));
  const sig = signPayload(mangaDexPagePayload(chapter, path), '', exp);
  const params = new URLSearchParams({ chapter, path, exp, sig });
  return `/api/mangadex-proxy?${params.toString()}`;
}

function assertProxySignature(searchParams) {
  const url = String(searchParams.get('url') || '');
  const exp = String(searchParams.get('exp') || '');
  const sig = String(searchParams.get('sig') || '');
  const referrer = String(searchParams.get('referrer') || '');
  if (!url || !exp || !sig) {
    const error = new Error('Proxy signature required');
    error.status = 403;
    throw error;
  }
  const expiresAt = Number(exp);
  if (!Number.isFinite(expiresAt) || expiresAt < Math.floor(Date.now() / 1000)) {
    const error = new Error('Proxy signature expired');
    error.status = 403;
    throw error;
  }
  const expected = signPayload(url, referrer, exp);
  const left = Buffer.from(sig);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) {
    const error = new Error('Invalid proxy signature');
    error.status = 403;
    throw error;
  }
}

function assertMangaDexProxySignature(searchParams) {
  const chapter = String(searchParams.get('chapter') || '');
  const imagePath = String(searchParams.get('path') || '');
  const exp = String(searchParams.get('exp') || '');
  const sig = String(searchParams.get('sig') || '');
  if (!exp || !sig) {
    const error = new Error('Proxy signature required');
    error.status = 403;
    throw error;
  }
  validateMangaDexPage(chapter, imagePath);
  const expiresAt = Number(exp);
  if (!Number.isFinite(expiresAt) || expiresAt < Math.floor(Date.now() / 1000)) {
    const error = new Error('Proxy signature expired');
    error.status = 403;
    throw error;
  }
  const expected = signPayload(mangaDexPagePayload(chapter, imagePath), '', exp);
  const left = Buffer.from(sig);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) {
    const error = new Error('Invalid proxy signature');
    error.status = 403;
    throw error;
  }
}

function proxiedThumbnail(url, referrer = MANGA_REFERRER) {
  const value = String(url || '').trim();
  if (!value) return '';
  if (value.startsWith('/')) return value;
  return buildProxyPath(value, referrer, { ttlSeconds: PROXY_TTL_COVER_SECONDS });
}

function proxyRemotePages(result, referrer = MANGA_REFERRER) {
  const pageReferrer = result.referrer || referrer;
  return {
    ...result,
    pages: (result.pages || []).map((page) => {
      const pageUrl = String(page.url || '');
      if (page.local || pageUrl.startsWith('/')) return page;
      const mangaDexChapterId = page.mangaDexChapterId
        || (result.sourceName === 'MangaDex' ? result.mangaDexChapterId : '');
      let mangaDexPath = page.mangaDexPath || '';
      if (!mangaDexPath && mangaDexChapterId) {
        try {
          const parts = new URL(pageUrl).pathname.split('/');
          if (parts.length === 4 && ['data', 'data-saver'].includes(parts[1])) {
            mangaDexPath = `/${parts[1]}/${parts[3]}`;
          }
        } catch {}
      }
      if (mangaDexChapterId && mangaDexPath) {
        const publicPage = { ...page };
        delete publicPage.mangaDexChapterId;
        delete publicPage.mangaDexPath;
        return {
          ...publicPage,
          url: buildMangaDexProxyPath(mangaDexChapterId, mangaDexPath),
        };
      }
      return {
        ...page,
        url: buildProxyPath(pageUrl, pageReferrer, { ttlSeconds: PROXY_TTL_MEDIA_SECONDS }),
      };
    }),
  };
}

module.exports = {
  PROXY_TTL_MEDIA_SECONDS,
  PROXY_TTL_COVER_SECONDS,
  MANGA_REFERRER,
  proxySigningSecret,
  resetProxySecretForTests,
  buildProxyPath,
  buildMangaDexProxyPath,
  assertProxySignature,
  assertMangaDexProxySignature,
  proxiedThumbnail,
  proxyRemotePages,
};
