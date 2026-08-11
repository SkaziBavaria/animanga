'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  looksLikeCloudflareChallenge,
  setAnidbTextFetcherForTests,
  fetchAnidbText,
  resetCurlBinaryForTests,
  isPlainCurlBinary,
  CURL_CANDIDATES,
  setCurlRunnerForTests,
  setNativeFetcherForTests,
  safeCurlDetail,
  canUseNativeFallback,
} = require('../../lib/anidb-fetch');

test.afterEach(() => {
  setAnidbTextFetcherForTests(null);
  resetCurlBinaryForTests();
  setCurlRunnerForTests(null);
  setNativeFetcherForTests(null);
});

test('redacts sensitive curl diagnostics', () => {
  const detail = safeCurlDetail('Authorization: Bearer secret\nCookie: sid=secret\nhttps://user:pass@example.test');
  assert.doesNotMatch(detail, /Bearer secret|sid=secret|user:pass/);
});

test('plain curl exit 35 retries with HTTP/1.1 then uses Node fallback', async () => {
  const calls = [];
  setCurlRunnerForTests(async (binary, args) => {
    calls.push({ binary, args });
    const error = new Error('TLS failed');
    error.exitCode = 35;
    throw error;
  });
  setNativeFetcherForTests(async () => '<html>fallback ok</html>');
  const { fetchWebText } = require('../../lib/anidb-fetch');
  assert.equal(await fetchWebText('https://example.test/'), '<html>fallback ok</html>');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].args.includes('--http1.1'), true);
});

test('challenge detection also applies to Node fallback responses', async () => {
  setCurlRunnerForTests(async () => {
    const error = new Error('TLS failed');
    error.exitCode = 35;
    throw error;
  });
  setNativeFetcherForTests(async () => '<title>Just a moment...</title><p>Enable JavaScript and cookies to continue</p>');
  const { fetchWebText } = require('../../lib/anidb-fetch');
  await assert.rejects(fetchWebText('https://example.test/'), /Blocked by upstream protection/);
});

test('detects Cloudflare challenge pages', () => {
  assert.equal(looksLikeCloudflareChallenge('<title>Just a moment...</title>'), true);
  assert.equal(looksLikeCloudflareChallenge('<html>ok</html>'), false);
  assert.equal(
    looksLikeCloudflareChallenge('<script src="/cdn-cgi/challenge-platform/x.js"></script><title>Browse Anime</title>'),
    false,
  );
});

test('prefers impersonation binaries and falls back to plain curl', () => {
  assert.equal(CURL_CANDIDATES.at(-1), 'curl');
  assert.equal(isPlainCurlBinary('/data/data/com.termux/files/usr/bin/curl'), true);
  assert.equal(isPlainCurlBinary('C:\\Windows\\System32\\curl.exe'), true);
  assert.equal(isPlainCurlBinary('/usr/local/bin/curl_chrome136'), false);
});

test('never falls back when curl was explicitly configured', () => {
  assert.equal(canUseNativeFallback('/usr/bin/curl', '/custom/curl'), false);
  assert.equal(canUseNativeFallback('/usr/bin/curl', ''), true);
  assert.equal(canUseNativeFallback('/usr/bin/curl_chrome136', ''), false);
});

test('test fetcher bypasses curl binary lookup', async () => {
  setAnidbTextFetcherForTests(async () => '<html>ok</html>');
  assert.equal(await fetchAnidbText('/browse?q=x'), '<html>ok</html>');
});

test('generic fetcher forwards POST form and retry options', async () => {
  let received;
  setAnidbTextFetcherForTests(async (url, options) => {
    received = { url, options };
    return '<html>ok</html>';
  });
  const { fetchWebText } = require('../../lib/anidb-fetch');
  await fetchWebText('https://example.test/search', {
    method: 'POST', form: { text: 'Naruto' }, ipv4: true, retries: 3,
  });
  assert.equal(received.url, 'https://example.test/search');
  assert.equal(received.options.method, 'POST');
  assert.deepEqual(received.options.form, { text: 'Naruto' });
  assert.equal(received.options.ipv4, true);
  assert.equal(received.options.retries, 3);
});
