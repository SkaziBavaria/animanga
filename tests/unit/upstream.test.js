'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { fetchWithTimeout, UpstreamTimeoutError } = require('../../lib/upstream');

test('adds a timeout signal to upstream requests', async () => {
  let receivedSignal;
  const response = await fetchWithTimeout(async (_url, options) => {
    receivedSignal = options.signal;
    return { ok: true };
  }, 'https://example.test', {}, 100);
  assert.equal(response.ok, true);
  assert.equal(receivedSignal instanceof AbortSignal, true);
});

test('turns an elapsed upstream timeout into a typed 504 error', async () => {
  const hangingFetcher = (_url, options) => new Promise((_resolve, reject) => {
    // AbortSignal.timeout() uses an unref'ed timer on Node 22. Keep this
    // synthetic request alive just like a real network socket would be.
    const keepAlive = setTimeout(() => reject(new Error('timeout signal did not fire')), 1_000);
    options.signal.addEventListener('abort', () => {
      clearTimeout(keepAlive);
      reject(options.signal.reason);
    }, { once: true });
  });
  await assert.rejects(
    fetchWithTimeout(hangingFetcher, 'https://slow.example', {}, 5),
    (error) => error instanceof UpstreamTimeoutError && error.status === 504 && error.code === 'UPSTREAM_TIMEOUT'
  );
});
