'use strict';

const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { ALLANIME_REFERER, USER_AGENT } = require('./config');
const { sendError } = require('./http');

async function proxyStream(req, res, url) {
  const target = url.searchParams.get('url');
  const referrer = url.searchParams.get('referrer') || ALLANIME_REFERER;
  if (!target) return sendError(res, 400, 'Missing url');

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
  proxyStream,
};
