'use strict';

const { MAX_BODY } = require('./config');

class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.details = details;
  }
}

function sendJson(res, status, payload) {
  if (res.headersSent) return;
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

function publicErrorPayload(message, details) {
  const error = String(message || 'Internal server error');
  const detail = typeof details === 'string' ? details : '';
  const combined = `${error} ${detail}`;
  const curlInternal = /upstream curl failed|curl:\s*\(\d+\)|curl_(?:chrome|firefox)|curl-impersonate/i.test(combined);
  if (!curlInternal) return { error, details };

  const upstream = /AniDB|playable link/i.test(combined) ? 'AniDB' : 'Upstream';
  const upstreamStatus = combined.match(/(?:HTTP|error:)\s*(\d{3})/i)?.[1];
  return { error: `${upstream} unavailable${upstreamStatus ? ` (HTTP ${upstreamStatus})` : ''}` };
}

function sendError(res, status, message, details) {
  sendJson(res, status, publicErrorPayload(message, details));
}

async function readBody(req) {
  const declaredSize = Number(req.headers?.['content-length']);
  if (Number.isFinite(declaredSize) && declaredSize > MAX_BODY) {
    throw new HttpError(413, 'Request body is too large');
  }

  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, 'Request body is too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return {};

  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'Request body must contain valid JSON');
  }
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    throw new HttpError(400, 'Request body must be a JSON object');
  }
  return value;
}

module.exports = {
  sendJson,
  sendError,
  readBody,
  HttpError,
  publicErrorPayload,
};
