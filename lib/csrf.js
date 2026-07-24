'use strict';

const { HttpError } = require('./http');
const { allowedOrigins } = require('./origin');

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function normalizeOrigin(value) {
  try {
    return new URL(String(value)).origin;
  } catch {
    return '';
  }
}

/**
 * Block browser cross-site mutations (CSRF) against Basic-auth / open LAN installs.
 * Non-browser clients (curl, scripts) without Sec-Fetch-Site/Origin stay allowed.
 */
function assertSameOriginMutation(req) {
  const method = String(req.method || 'GET').toUpperCase();
  if (SAFE_METHODS.has(method)) return;

  const site = String(req.headers['sec-fetch-site'] || '').toLowerCase();
  if (site === 'cross-site') {
    throw new HttpError(403, 'Cross-site requests are not allowed');
  }
  if (site === 'same-origin' || site === 'none') return;

  const originHeader = req.headers.origin;
  if (originHeader) {
    const actual = normalizeOrigin(originHeader);
    const allowed = allowedOrigins(req);
    if (!actual || !allowed.has(actual)) {
      throw new HttpError(403, 'Request origin is not allowed');
    }
    return;
  }

  // No browser site/origin signals: allow automation and older non-fetch clients.
  if (!site) return;

  // same-site without a verifiable Origin is ambiguous — reject.
  throw new HttpError(403, 'Cross-site requests are not allowed');
}

module.exports = {
  assertSameOriginMutation,
  SAFE_METHODS,
};
