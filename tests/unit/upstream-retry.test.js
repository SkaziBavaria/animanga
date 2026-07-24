'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isRateLimitError,
  retryDelay,
  withUpstreamRetry,
} = require('../../lib/upstream-retry');

test('isRateLimitError recognizes common upstream messages', () => {
  assert.equal(isRateLimitError('please try again in 3 seconds'), true);
  assert.equal(isRateLimitError('AllManga API rate limit (429)'), true);
  assert.equal(isRateLimitError('too many requests'), true);
  assert.equal(isRateLimitError('Manga not found'), false);
});

test('retryDelay uses the upstream wait hint when present', () => {
  assert.equal(retryDelay(new Error('try again in 2 seconds'), 0), 2150);
  assert.ok(retryDelay(new Error('rate limit'), 0) >= 500);
});

test('withUpstreamRetry waits and retries rate-limit failures', async () => {
  let attempts = 0;
  const result = await withUpstreamRetry(async () => {
    attempts += 1;
    if (attempts < 3) throw new Error('try again in 0 seconds');
    return 'ok';
  }, { attempts: 4 });
  assert.equal(result, 'ok');
  assert.equal(attempts, 3);
});
