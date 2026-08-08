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
} = require('../../lib/anidb-fetch');

test.afterEach(() => {
  setAnidbTextFetcherForTests(null);
  resetCurlBinaryForTests();
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
