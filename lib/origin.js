'use strict';

const { HOST, PORT, PUBLIC_URL, TRUST_PROXY } = require('./config');

function formatHost(host) {
  const value = String(host || '').trim();
  if (!value) return '';
  return value.includes(':') && !value.startsWith('[') && !value.includes(']')
    ? `[${value}]`
    : value;
}

function forwardedPart(value) {
  return String(value || '').split(',')[0].trim();
}

function listenOrigin() {
  const listenHost = ['0.0.0.0', '::', '[::]'].includes(HOST) ? '127.0.0.1' : HOST;
  return `http://${formatHost(listenHost)}:${PORT}`;
}

/** Origin the browser used to reach AniManga for this request (CSRF checks). */
function requestHostOrigin(req) {
  // When PUBLIC_URL is fixed, never widen the CSRF allowlist via forwarded headers.
  if (PUBLIC_URL) return PUBLIC_URL;

  if (TRUST_PROXY) {
    const protocol = forwardedPart(req.headers['x-forwarded-proto']) || 'http';
    const host = forwardedPart(req.headers['x-forwarded-host'] || req.headers.host);
    if (host) return `${protocol}://${host}`;
  }

  const host = String(req.headers.host || '').trim();
  if (host) {
    const encrypted = Boolean(req.socket?.encrypted);
    return `${encrypted ? 'https' : 'http'}://${host}`;
  }

  return listenOrigin();
}

/**
 * Stable external origin for OAuth callbacks.
 * Prefer PUBLIC_URL; never trust unauthenticated Host headers when proxy trust is off.
 */
function requestOrigin(req) {
  if (PUBLIC_URL) return PUBLIC_URL;
  if (TRUST_PROXY) {
    const protocol = forwardedPart(req.headers['x-forwarded-proto']) || 'http';
    const host = forwardedPart(req.headers['x-forwarded-host'] || req.headers.host);
    if (host) return `${protocol}://${host}`;
  }
  return listenOrigin();
}

function allowedOrigins(req) {
  const origins = new Set();
  if (PUBLIC_URL) {
    origins.add(PUBLIC_URL);
    return origins;
  }
  const hostOrigin = requestHostOrigin(req);
  if (hostOrigin) origins.add(hostOrigin);
  return origins;
}

module.exports = {
  requestHostOrigin,
  requestOrigin,
  allowedOrigins,
};
