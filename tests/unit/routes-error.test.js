'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { publicRouteError } = require('../../lib/routes');

const curl503 = new Error(
  'upstream curl failed with /usr/local/bin/curl_chrome136 (exit 22: curl: (22) The requested URL returned error: 503)',
);

test('retains media provider identity when hiding curl internals', () => {
  assert.deepEqual(publicRouteError('/api/library', curl503), {
    status: 503,
    message: 'AniDB unavailable (HTTP 503)',
  });
  assert.deepEqual(publicRouteError('/api/manga/search', curl503), {
    status: 503,
    message: 'Manga provider unavailable (HTTP 503)',
  });
});
