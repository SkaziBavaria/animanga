'use strict';

const crypto = require('crypto');
const { ACCESS_TOKEN, ACCESS_USERNAME } = require('./config');

const MAX_AUTH_HEADER_BYTES = 8 * 1024;
const MAX_CREDENTIAL_BYTES = 1024;

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

function requestAuthorized(req) {
  if (!ACCESS_TOKEN) return true;
  const credentials = basicCredentials(req.headers.authorization);
  if (!credentials) return false;
  const usernameMatches = timingSafeStringEqual(credentials.username, ACCESS_USERNAME);
  const passwordMatches = timingSafeStringEqual(credentials.password, ACCESS_TOKEN);
  return usernameMatches && passwordMatches;
}

function requireAuthentication(req, res, pathname = '') {
  if (requestAuthorized(req)) return true;
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

module.exports = {
  basicCredentials,
  requestAuthorized,
  requireAuthentication,
};
