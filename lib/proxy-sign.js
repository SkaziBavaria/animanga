'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { ACCESS_TOKEN, DATA_DIR } = require('./config');
const { ANIDB_REFERER } = require('./config');
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

function buildProxyPath(targetUrl, referrer = ANIDB_REFERER, { ttlSeconds = PROXY_TTL_MEDIA_SECONDS } = {}) {
  const url = String(targetUrl || '').trim();
  if (!url) throw new Error('Missing proxy target url');
  const exp = String(Math.floor(Date.now() / 1000) + Math.max(60, Number(ttlSeconds) || PROXY_TTL_MEDIA_SECONDS));
  const ref = String(referrer || '');
  const sig = signPayload(url, ref, exp);
  const params = new URLSearchParams({ url, exp, sig });
  if (ref) params.set('referrer', ref);
  return `/api/proxy?${params.toString()}`;
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
  assertProxySignature,
  proxiedThumbnail,
  proxyRemotePages,
};
