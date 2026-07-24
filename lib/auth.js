'use strict';

const crypto = require('crypto');
const { ACCESS_TOKEN, ACCESS_USERNAME, TRUST_PROXY } = require('./config');

const MAX_AUTH_HEADER_BYTES = 8 * 1024;
const MAX_CREDENTIAL_BYTES = 1024;
const AUTH_RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;
const AUTH_RATE_LIMIT_MAX_FAILURES = 20;
const GOOGLE_CALLBACK_PATH = '/api/sync/google/callback';

const failedAttempts = new Map();

function timingSafeStringEqual(actual, expected) {
  const actualBuffer = Buffer.from(String(actual), 'utf8');
  const expectedBuffer = Buffer.from(String(expected), 'utf8');
  if (actualBuffer.length > MAX_CREDENTIAL_BYTES || expectedBuffer.length > MAX_CREDENTIAL_BYTES) return false;
  const actualPadded = Buffer.alloc(MAX_CREDENTIAL_BYTES);
  const expectedPadded = Buffer.alloc(MAX_CREDENTIAL_BYTES);
  actualBuffer.copy(actualPadded);
  expectedBuffer.copy(expectedPadded);
  return crypto.timingSafeEqual(actualPadded, expectedPadded)
    && actualBuffer.length === expectedBuffer.length;
}

function basicCredentials(header) {
  if (typeof header !== 'string' || header.length > MAX_AUTH_HEADER_BYTES) return null;
  if (header.length <= 6 || header.slice(0, 6).toLowerCase() !== 'basic ') return null;
  if (header.charCodeAt(6) <= 32) return null;
  try {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const separator = decoded.indexOf(':');
    if (separator < 0) return null;
    return { username: decoded.slice(0, separator), password: decoded.slice(separator + 1) };
  } catch {
    return null;
  }
}

function clientIp(req) {
  if (TRUST_PROXY) {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded) {
      const first = forwarded.split(',')[0].trim();
      if (first) return first;
    }
  }
  return req.socket?.remoteAddress || 'unknown';
}

function pruneAttempts(timestamps, now) {
  const cutoff = now - AUTH_RATE_LIMIT_WINDOW_MS;
  while (timestamps.length && timestamps[0] <= cutoff) timestamps.shift();
}

function authRateLimitStatus(ip, now = Date.now()) {
  const timestamps = failedAttempts.get(ip);
  if (!timestamps) return { limited: false, retryAfter: 0 };
  pruneAttempts(timestamps, now);
  if (timestamps.length < AUTH_RATE_LIMIT_MAX_FAILURES) return { limited: false, retryAfter: 0 };
  const retryAfter = Math.ceil((timestamps[0] + AUTH_RATE_LIMIT_WINDOW_MS - now) / 1000);
  return { limited: true, retryAfter: Math.max(1, retryAfter) };
}

function recordFailedAttempt(ip, now = Date.now()) {
  let timestamps = failedAttempts.get(ip);
  if (!timestamps) {
    timestamps = [];
    failedAttempts.set(ip, timestamps);
  }
  pruneAttempts(timestamps, now);
  timestamps.push(now);
}

function isAuthExempt(pathname, method) {
  return String(method || 'GET').toUpperCase() === 'GET' && pathname === GOOGLE_CALLBACK_PATH;
}

function requestAuthorized(req) {
  if (!ACCESS_TOKEN) return true;
  const credentials = basicCredentials(req.headers.authorization);
  if (!credentials) return false;
  const usernameMatches = timingSafeStringEqual(credentials.username, ACCESS_USERNAME);
  const passwordMatches = timingSafeStringEqual(credentials.password, ACCESS_TOKEN);
  return usernameMatches && passwordMatches;
}

function requireAuthentication(req, res, pathname = '') {
  if (isAuthExempt(pathname, req.method)) return true;
  if (requestAuthorized(req)) return true;

  if (ACCESS_TOKEN) {
    const ip = clientIp(req);
    const { limited, retryAfter } = authRateLimitStatus(ip);
    if (limited) {
      res.writeHead(429, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'retry-after': String(retryAfter),
      });
      res.end(JSON.stringify({ error: 'Too many failed authentication attempts' }));
      return false;
    }
    // Only count presented-but-wrong credentials. Missing Authorization is the normal
    // browser challenge and must not burn the rate-limit budget.
    if (req.headers.authorization) recordFailedAttempt(ip);
  }

  const api = pathname.startsWith('/api/');
  const body = api ? JSON.stringify({ error: 'Authentication required' }) : 'Authentication required';
  res.writeHead(401, {
    'www-authenticate': 'Basic realm="AniManga", charset="UTF-8"',
    'content-type': api ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
  return false;
}

function resetAuthRateLimitForTests() {
  failedAttempts.clear();
}

module.exports = {
  GOOGLE_CALLBACK_PATH,
  basicCredentials,
  clientIp,
  isAuthExempt,
  requestAuthorized,
  requireAuthentication,
  resetAuthRateLimitForTests,
};
