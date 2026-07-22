'use strict';

const dns = require('dns/promises');
const http = require('http');
const https = require('https');
const net = require('net');
const { pipeline } = require('stream/promises');
const { ALLANIME_REFERER, USER_AGENT } = require('./config');
const { sendError } = require('./http');
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

function pinnedRequest(target, headers, signal) {
  const transport = target.url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    let timer;
    const request = transport.request(target.url, {
      method: 'GET',
      headers,
      signal,
      lookup: (_hostname, _options, callback) => callback(null, target.address, target.family),
    }, (response) => {
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

async function proxyStream(req, res, url) {
  const rawTarget = url.searchParams.get('url');
  const referrer = url.searchParams.get('referrer') || ALLANIME_REFERER;
  if (!rawTarget) return sendError(res, 400, 'Missing url');

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

    const responseHeaders = {
      'content-type': upstream.headers['content-type'] || 'video/mp4',
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
  requestPublicStream,
  proxyStream,
};
