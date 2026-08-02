'use strict';

const dns = require('dns/promises');
const http = require('http');
const https = require('https');
const net = require('net');
const { pipeline } = require('stream/promises');
const { ANIDB_REFERER, USER_AGENT } = require('./config');
const { sendError } = require('./http');
const { assertProxySignature, buildProxyPath } = require('./proxy-sign');
const { DEFAULT_UPSTREAM_TIMEOUT_MS, UpstreamTimeoutError } = require('./upstream');

const MAX_REDIRECTS = 5;

function isPrivateIpv4(address) {
  const [a, b, c] = address.split('.').map(Number);
  return a === 0
    || a === 10
    || a === 100 && b >= 64 && b <= 127
    || a === 127
    || a === 169 && b === 254
    || a === 172 && b >= 16 && b <= 31
    || a === 192 && b === 0 && (c === 0 || c === 2)
    || a === 192 && b === 88 && c === 99
    || a === 192 && b === 168
    || a === 198 && (b === 18 || b === 19)
    || a === 198 && b === 51 && c === 100
    || a === 203 && b === 0 && c === 113
    || a >= 224;
}

function isPrivateIp(hostname) {
  const normalized = String(hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
  const family = net.isIP(normalized);
  if (family === 4) return isPrivateIpv4(normalized);
  if (family !== 6) return false;

  const mapped = normalized.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/i)?.[1];
  if (mapped) return isPrivateIpv4(mapped);
  return normalized === '::'
    || normalized === '::1'
    || normalized.startsWith('::ffff:')
    || normalized.startsWith('fc')
    || normalized.startsWith('fd')
    || /^fe[89ab]/.test(normalized)
    || normalized.startsWith('ff')
    || normalized.startsWith('2001:db8:');
}

function parseProxyTarget(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('Invalid proxy url');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Proxy url must use http or https');
  if (parsed.username || parsed.password) throw new Error('Proxy url must not contain credentials');
  const hostname = parsed.hostname.toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || isPrivateIp(hostname)) {
    throw new Error('Proxy url points to a private host');
  }
  return parsed.href;
}

async function resolvePublicTarget(value, lookup = dns.lookup) {
  const url = new URL(parseProxyTarget(value));
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(hostname)) {
    return { url, address: hostname, family: net.isIP(hostname) };
  }

  const addresses = await lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length) throw new Error('Proxy host did not resolve');
  if (addresses.some((entry) => isPrivateIp(entry.address))) {
    throw new Error('Proxy host resolves to a private address');
  }
  const selected = addresses[0];
  return { url, address: selected.address, family: selected.family };
}

function pinnedRequestOptions(target, headers, signal) {
  const secure = target.url.protocol === 'https:';
  return {
    protocol: target.url.protocol,
    hostname: target.address,
    family: target.family,
    port: target.url.port || (secure ? 443 : 80),
    path: `${target.url.pathname}${target.url.search}`,
    method: 'GET',
    headers: { ...headers, Host: target.url.host },
    signal,
    ...(secure ? { servername: target.url.hostname } : {}),
  };
}

function pinnedRequest(target, headers, signal) {
  const transport = target.url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    let timer;
    const request = transport.request(pinnedRequestOptions(target, headers, signal), (response) => {
      clearTimeout(timer);
      resolve(response);
    });
    timer = setTimeout(() => request.destroy(new UpstreamTimeoutError(DEFAULT_UPSTREAM_TIMEOUT_MS, target.url.href)), DEFAULT_UPSTREAM_TIMEOUT_MS);
    request.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    request.end();
  });
}

async function requestPublicStream(value, headers, signal, options = {}) {
  const lookup = options.lookup || dns.lookup;
  let current = value;
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const target = await resolvePublicTarget(current, lookup);
    const response = await pinnedRequest(target, headers, signal);
    if (![301, 302, 303, 307, 308].includes(response.statusCode)) return response;
    const location = response.headers.location;
    response.resume();
    if (!location) throw new Error('Proxy redirect is missing a location');
    if (redirects === MAX_REDIRECTS) throw new Error('Proxy redirect limit exceeded');
    current = new URL(location, target.url).href;
  }
  throw new Error('Proxy redirect limit exceeded');
}

function normalizeRequestHeaders(headers = {}) {
  if (headers && typeof headers.forEach === 'function') {
    const out = {};
    headers.forEach((value, key) => {
      out[key] = value;
    });
    return out;
  }
  return { ...headers };
}

async function readIncomingMessage(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function isM3u8Response(contentType, targetUrl) {
  const type = String(contentType || '').toLowerCase().split(';')[0].trim();
  if (type === 'application/vnd.apple.mpegurl' || type === 'application/x-mpegurl') return true;
  try {
    return new URL(String(targetUrl || '')).pathname.toLowerCase().endsWith('.m3u8');
  } catch {
    return /\.m3u8(?:$|[?#])/i.test(String(targetUrl || ''));
  }
}

function resolvePlaylistUri(uri, baseUrl) {
  try {
    return new URL(String(uri || '').trim(), baseUrl).href;
  } catch {
    return String(uri || '').trim();
  }
}

function rewriteTagUriLine(line, baseUrl, referrer, buildProxyPathFn) {
  return line.replace(/URI=(["'])([^"']*)\1/gi, (_match, quote, uri) => {
    const absolute = resolvePlaylistUri(uri, baseUrl);
    return `URI=${quote}${buildProxyPathFn(absolute, referrer)}${quote}`;
  });
}

/** Rewrite HLS playlist segment and tag URIs through the signed proxy. */
function rewriteM3u8(playlistText, playlistUrl, referrer, buildProxyPathFn = buildProxyPath) {
  const baseUrl = String(playlistUrl || '');
  const lines = String(playlistText).replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  return lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed) return line;
    if (trimmed.startsWith('#')) {
      if (/URI\s*=/i.test(trimmed)) return rewriteTagUriLine(line, baseUrl, referrer, buildProxyPathFn);
      return line;
    }
    const absolute = resolvePlaylistUri(trimmed, baseUrl);
    return buildProxyPathFn(absolute, referrer);
  }).join('\n');
}

/** DNS-pinned fetch for untrusted public media/source URLs. */
async function fetchPublic(url, options = {}, timeoutMs = DEFAULT_UPSTREAM_TIMEOUT_MS) {
  const headers = normalizeRequestHeaders(options.headers);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const parent = options.signal;
  const onAbort = () => controller.abort();
  if (parent) {
    if (parent.aborted) controller.abort();
    else parent.addEventListener('abort', onAbort, { once: true });
  }
  try {
    const upstream = await requestPublicStream(url, headers, controller.signal);
    const status = upstream.statusCode || 502;
    const body = await readIncomingMessage(upstream);
    const responseHeaders = new Headers();
    for (const [key, value] of Object.entries(upstream.headers || {})) {
      if (value == null) continue;
      responseHeaders.set(key, Array.isArray(value) ? value.join(', ') : String(value));
    }
    return new Response(body, { status, statusText: upstream.statusMessage || '', headers: responseHeaders });
  } catch (error) {
    if (controller.signal.aborted) throw new UpstreamTimeoutError(timeoutMs, String(url));
    throw error;
  } finally {
    clearTimeout(timer);
    if (parent) parent.removeEventListener('abort', onAbort);
  }
}

async function proxyStream(req, res, url) {
  const rawTarget = url.searchParams.get('url');
  const referrer = url.searchParams.get('referrer') || ANIDB_REFERER;
  if (!rawTarget) return sendError(res, 400, 'Missing url');

  try {
    assertProxySignature(url.searchParams);
  } catch (error) {
    return sendError(res, Number(error.status) || 403, error.message || 'Proxy signature required');
  }

  const headers = { Referer: referrer, 'User-Agent': USER_AGENT };
  if (req.headers.range) headers.Range = req.headers.range;

  const controller = new AbortController();
  req.on('close', () => controller.abort());

  try {
    const upstream = await requestPublicStream(rawTarget, headers, controller.signal);
    const status = upstream.statusCode || 502;
    if (status < 200 || status >= 300) {
      upstream.resume();
      return sendError(res, status, `Stream proxy failed (${status})`);
    }

    const upstreamContentType = upstream.headers['content-type'] || '';
    if (isM3u8Response(upstreamContentType, rawTarget)) {
      const body = await readIncomingMessage(upstream);
      const rewritten = rewriteM3u8(body.toString('utf8'), rawTarget, referrer);
      res.writeHead(status, {
        'content-type': 'application/vnd.apple.mpegurl',
        'cache-control': 'no-store',
      });
      res.end(rewritten);
      return;
    }

    const responseHeaders = {
      'content-type': upstreamContentType || 'video/mp4',
      'accept-ranges': upstream.headers['accept-ranges'] || 'bytes',
      'cache-control': 'no-store',
    };
    if (upstream.headers['content-length']) responseHeaders['content-length'] = upstream.headers['content-length'];
    if (upstream.headers['content-range']) responseHeaders['content-range'] = upstream.headers['content-range'];

    res.writeHead(status, responseHeaders);
    await pipeline(upstream, res);
  } catch (err) {
    if (err.name === 'AbortError') return;
    if (!res.headersSent) sendError(res, Number(err.status) || 502, 'Stream proxy failed', err.message);
    else res.destroy();
  }
}

module.exports = {
  isPrivateIp,
  parseProxyTarget,
  resolvePublicTarget,
  pinnedRequestOptions,
  requestPublicStream,
  fetchPublic,
  proxyStream,
  isM3u8Response,
  rewriteM3u8,
};
