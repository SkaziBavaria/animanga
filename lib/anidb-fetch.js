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
  'curl',
];

const FALLBACK_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
  + 'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

let resolvedBinary = undefined;
let textFetcher = null;
let curlRunner = runCurl;
let nativeFetcher = nativeFetchWebText;

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

function resolveCurlBinary() {
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

// Existing integrations may still use the old name.
const resolveCurlImpersonateBinary = resolveCurlBinary;

function isPlainCurlBinary(binary) {
  const name = String(binary || '').replace(/\\/g, '/').split('/').pop().replace(/\.exe$/i, '').toLowerCase();
  return name === 'curl';
}

function resetCurlBinaryForTests() {
  resolvedBinary = undefined;
}

function setAnidbTextFetcherForTests(fetcher) {
  textFetcher = typeof fetcher === 'function' ? fetcher : null;
}

function canUseNativeFallback(binary, explicitBinary = CURL_IMPERSONATE) {
  return !explicitBinary && isPlainCurlBinary(binary);
}

function curlVersion(binary = resolveCurlBinary()) {
  if (!binary) return '';
  const { execFileSync } = require('child_process');
  try {
    return String(execFileSync(binary, ['--version'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: 5000,
    }) || '').split(/\r?\n/).find(Boolean)?.trim() || '';
  } catch {
    return '';
  }
}

function setCurlRunnerForTests(runner) {
  curlRunner = typeof runner === 'function' ? runner : runCurl;
}

function setNativeFetcherForTests(fetcher) {
  nativeFetcher = typeof fetcher === 'function' ? fetcher : nativeFetchWebText;
}

function safeCurlDetail(value) {
  return String(value || '')
    .replace(/(authorization|cookie|token):[^\r\n]*/gi, '$1: [redacted]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[redacted]@')
    .trim()
    .slice(0, 1000);
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
        const detail = safeCurlDetail(Buffer.concat(stderr).toString('utf8')) || `exit ${code}`;
        const error = new Error(`upstream curl failed with ${binary} (exit ${code}: ${detail})`);
        error.code = 'CURL_FAILED';
        error.exitCode = code;
        error.binary = binary;
        error.detail = detail;
        reject(error);
        return;
      }
      resolve(body);
    });
  });
}

async function nativeFetchWebText(url, { timeoutMs, headers, method, form }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method,
      headers: { 'User-Agent': FALLBACK_USER_AGENT, ...headers },
      body: form ? new URLSearchParams(Object.entries(form).filter(([, value]) => value != null)) : undefined,
      redirect: 'follow',
      signal: controller.signal,
    });
    return await response.text();
  } catch (error) {
    throw new Error(`Node HTTP fallback failed: ${error.cause?.message || error.message}`, { cause: error });
  } finally {
    clearTimeout(timer);
  }
}

function termuxTlsHint(error) {
  if (process.platform !== 'android' && !String(process.env.PREFIX || '').includes('com.termux')) return '';
  if (error?.exitCode !== 35) return '';
  return ' Termux TLS failed; update curl, openssl and ca-certificates, then try another network.';
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
  const binary = resolveCurlBinary();
  if (!binary) {
    throw new Error(
      'No curl client found: install curl, or install curl-impersonate and set ANIMANGA_CURL_IMPERSONATE'
    );
  }

  // Impersonation wrappers set their own fingerprint; plain curl gets a browser user agent fallback.
  const args = [
    '-sSL',
    '--max-time', String(Math.max(1, Math.ceil(timeoutMs / 1000))),
  ];
  if (isPlainCurlBinary(binary)) args.push('-A', FALLBACK_USER_AGENT);
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

  let body;
  try {
    body = await curlRunner(binary, args, timeoutMs);
  } catch (firstError) {
    if (firstError?.exitCode !== 35 || !canUseNativeFallback(binary)) {
      firstError.message += termuxTlsHint(firstError);
      throw firstError;
    }
    try {
      const retryArgs = args.includes('--http1.1') ? args : ['--http1.1', ...args];
      body = await curlRunner(binary, retryArgs, timeoutMs);
    } catch (retryError) {
      try {
        body = await nativeFetcher(absolute, { timeoutMs, headers, method, form });
      } catch (nativeError) {
        retryError.message += `${termuxTlsHint(retryError)} ${nativeError.message}`;
        throw retryError;
      }
    }
  }
  if (looksLikeCloudflareChallenge(body)) {
    const hint = isPlainCurlBinary(binary)
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
  resolveCurlBinary,
  resolveCurlImpersonateBinary,
  isPlainCurlBinary,
  canUseNativeFallback,
  curlVersion,
  resetCurlBinaryForTests,
  setAnidbTextFetcherForTests,
  setCurlRunnerForTests,
  setNativeFetcherForTests,
  safeCurlDetail,
  CURL_CANDIDATES,
};
