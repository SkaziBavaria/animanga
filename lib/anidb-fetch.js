'use strict';

const { spawn } = require('child_process');
const { ANIDB_ORIGIN, CURL_IMPERSONATE } = require('./config');

const CURL_CANDIDATES = [
  'curl_chrome136',
  'curl_firefox135',
  'curl_chrome146',
  'curl_chrome124',
  'curl_chrome116',
  'curl_ff117',
  'curl-impersonate-chrome',
  'curl-impersonate-ff',
  'curl_chrome',
];

let resolvedBinary = undefined;
let textFetcher = null;

function looksLikeCloudflareChallenge(body) {
  const text = String(body || '');
  // Real anidb pages can mention challenge-platform assets; require the interstitial signals.
  return /<title[^>]*>\s*Just a moment\.\.\.\s*<\/title>/i.test(text)
    || (/just a moment/i.test(text) && /Enable JavaScript and cookies to continue/i.test(text))
    || (/cf-browser-verification/i.test(text) && /cdn-cgi\/challenge-platform/i.test(text));
}

function whichSync(binary) {
  const { execFileSync } = require('child_process');
  const checker = process.platform === 'win32' ? 'where' : 'which';
  try {
    const output = execFileSync(checker, [binary], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    const first = String(output || '').split(/\r?\n/).map((line) => line.trim()).find(Boolean);
    return first || null;
  } catch {
    return null;
  }
}

function resolveCurlImpersonateBinary() {
  if (resolvedBinary !== undefined) return resolvedBinary;
  if (CURL_IMPERSONATE) {
    resolvedBinary = CURL_IMPERSONATE;
    return resolvedBinary;
  }
  for (const candidate of CURL_CANDIDATES) {
    const found = whichSync(candidate);
    if (found) {
      resolvedBinary = found;
      return resolvedBinary;
    }
  }
  resolvedBinary = null;
  return null;
}

function resetCurlBinaryForTests() {
  resolvedBinary = undefined;
}

function setAnidbTextFetcherForTests(fetcher) {
  textFetcher = typeof fetcher === 'function' ? fetcher : null;
}

function runCurl(binary, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error(`upstream fetch timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const body = Buffer.concat(stdout).toString('utf8');
      if (code !== 0) {
        const detail = Buffer.concat(stderr).toString('utf8').trim() || `exit ${code}`;
        reject(new Error(`upstream curl failed (${detail})`));
        return;
      }
      resolve(body);
    });
  });
}

async function fetchWebText(url, {
  timeoutMs = 15_000,
  headers = {},
  method = 'GET',
  form = null,
  ipv4 = false,
  retries = 0,
  retryDelaySeconds = 1,
} = {}) {
  if (textFetcher) return textFetcher(url, { timeoutMs, headers, method, form, ipv4, retries });

  const absolute = /^https?:\/\//i.test(url) ? url : `${ANIDB_ORIGIN}${url.startsWith('/') ? '' : '/'}${url}`;
  const binary = resolveCurlImpersonateBinary();
  if (!binary) {
    throw new Error(
      'Blocked by upstream protection: install curl-impersonate and set ANIMANGA_CURL_IMPERSONATE, '
      + 'or put curl_chrome136/curl_firefox135 on PATH'
    );
  }

  // Do not override UA/ciphers/HTTP2 — curl_chrome* wrappers already set a full browser fingerprint.
  const args = [
    '-sL',
    '--max-time', String(Math.max(1, Math.ceil(timeoutMs / 1000))),
  ];
  if (ipv4) args.push('-4');
  if (retries > 0) {
    args.push('--retry', String(retries), '--retry-all-errors', '--retry-delay', String(retryDelaySeconds));
  }
  if (String(method).toUpperCase() !== 'GET') args.push('-X', String(method).toUpperCase());
  for (const [key, value] of Object.entries(headers)) {
    if (value == null || value === '') continue;
    args.push('-H', `${key}: ${value}`);
  }
  if (form) {
    for (const [key, value] of Object.entries(form)) {
      if (value == null) continue;
      args.push('--data-urlencode', `${key}=${value}`);
    }
  }
  args.push(absolute);

  const body = await runCurl(binary, args, timeoutMs);
  if (looksLikeCloudflareChallenge(body)) {
    const name = String(binary).toLowerCase();
    const hint = name.includes('curl') && !name.includes('impersonate') && !/chrome|firefox|ff\d|safari/i.test(name)
      ? ' Try installing curl-impersonate (plain curl cannot pass the challenge).'
      : '';
    throw new Error(`Blocked by upstream protection when fetching ${absolute}.${hint}`);
  }
  return body;
}

const fetchAnidbText = fetchWebText;

module.exports = {
  ANIDB_ORIGIN,
  fetchAnidbText,
  fetchWebText,
  looksLikeCloudflareChallenge,
  resolveCurlImpersonateBinary,
  resetCurlBinaryForTests,
  setAnidbTextFetcherForTests,
  CURL_CANDIDATES,
};
