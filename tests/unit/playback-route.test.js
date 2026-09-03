'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { publicPlaybackError } = require('../../lib/routes/playback');

test('presents AniDB HTTP failures without internal curl details', () => {
  const failure = publicPlaybackError(new Error(
    'upstream curl failed with /usr/local/bin/curl_chrome136 (exit 22: curl: (22) The requested URL returned error: 503)',
  ));
  assert.deepEqual(failure, { status: 503, message: 'AniDB unavailable (HTTP 503)' });
});

test('uses a short generic message when an upstream status is unavailable', () => {
  assert.deepEqual(
    publicPlaybackError(new Error('socket closed unexpectedly')),
    { status: 502, message: 'Playback unavailable' },
  );
});
