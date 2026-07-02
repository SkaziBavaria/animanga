'use strict';

const net = require('net');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { ALLANIME_REFERER, USER_AGENT } = require('./config');
const { sendError } = require('./http');

function isPrivateIp(hostname) {
  const normalized = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const family = net.isIP(normalized);
  if (family === 4) {
    const parts = normalized.split('.').map(Number);
    return parts[0] === 0
      || parts[0] === 10
      || parts[0] === 127
      || parts[0] === 169 && parts[1] === 254
      || parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31
      || parts[0] === 192 && parts[1] === 168;
  }
  if (family === 6) {
    return normalized === '::1'
      || normalized.startsWith('fc')
      || normalized.startsWith('fd')
      || normalized.startsWith('fe80');
  }
  return false;
}

function parseProxyTarget(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('Invalid proxy url');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Proxy url must use http or https');
  const hostname = parsed.hostname.toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || isPrivateIp(hostname)) {
    throw new Error('Proxy url points to a private host');
  }
  return parsed.href;
}

async function proxyStream(req, res, url) {
  const rawTarget = url.searchParams.get('url');
  const referrer = url.searchParams.get('referrer') || ALLANIME_REFERER;
  if (!rawTarget) return sendError(res, 400, 'Missing url');

  let target;
  try {
    target = parseProxyTarget(rawTarget);
  } catch (err) {
    return sendError(res, 400, err.message);
  }

  const headers = { Referer: referrer, 'User-Agent': USER_AGENT };
  if (req.headers.range) headers.Range = req.headers.range;

  const controller = new AbortController();
  req.on('close', () => controller.abort());

  try {
    const upstream = await fetch(target, { headers, redirect: 'follow', signal: controller.signal });
    if (!upstream.ok && upstream.status !== 206) {
      return sendError(res, upstream.status, `Stream proxy failed (${upstream.status})`);
    }

    const responseHeaders = {
      'content-type': upstream.headers.get('content-type') || 'video/mp4',
      'accept-ranges': upstream.headers.get('accept-ranges') || 'bytes',
      'cache-control': 'no-store',
    };
    const contentLength = upstream.headers.get('content-length');
    const contentRange = upstream.headers.get('content-range');
    if (contentLength) responseHeaders['content-length'] = contentLength;
    if (contentRange) responseHeaders['content-range'] = contentRange;

    res.writeHead(upstream.status, responseHeaders);
    if (upstream.body) {
      await pipeline(Readable.fromWeb(upstream.body), res);
    } else {
      res.end();
    }
  } catch (err) {
    if (err.name === 'AbortError') return;
    if (!res.headersSent) {
      sendError(res, 502, 'Stream proxy failed', err.message);
    } else {
      res.destroy();
    }
  }
}

module.exports = {
  parseProxyTarget,
  proxyStream,
};
