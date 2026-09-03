'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  providerForUrl, recordProviderFailure, recordProviderSuccess, providerHealth, resetProviderHealth,
} = require('../../lib/provider-health');

test.afterEach(resetProviderHealth);

test('provider health classifies upstreams without exposing request URLs', () => {
  assert.equal(providerForUrl('https://anidb.app/anime/example?token=secret'), 'anidb');
  assert.equal(providerForUrl('https://api.comick.dev/v1.0/search'), 'comick');
  recordProviderFailure('anidb', new Error('upstream curl failed: HTTP 503 https://secret.example/path'));
  const health = providerHealth().anidb;
  assert.equal(health.status, 503);
  assert.doesNotMatch(JSON.stringify(health), /secret\.example|token/);
  recordProviderSuccess('anidb');
  assert.equal(providerHealth().anidb.ok, true);
});
