'use strict';

const crypto = require('crypto');
const { ACCESS_TOKEN, ACCESS_USERNAME } = require('./config');

function credentialDigest(username, password) {
  return crypto.createHash('sha256').update(`${username}\0${password}`).digest();
}

function basicCredentials(header) {
  const match = String(header || '').match(/^Basic\s+(.+)$/i);
  if (!match) return null;
  try {
    const decoded = Buffer.from(match[1], 'base64').toString('utf8');
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
  return crypto.timingSafeEqual(
    credentialDigest(credentials.username, credentials.password),
    credentialDigest(ACCESS_USERNAME, ACCESS_TOKEN)
  );
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
