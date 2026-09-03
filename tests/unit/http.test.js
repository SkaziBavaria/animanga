'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('stream');

const { MAX_BODY } = require('../../lib/config');
const { HttpError, readBody, publicErrorPayload } = require('../../lib/http');

test('curl internals are never included in public API errors', () => {
  const payload = publicErrorPayload(
    'AniManga could not fetch a playable link',
    'upstream curl failed with /usr/local/bin/curl_chrome136 (exit 22: curl: (22) The requested URL returned error: 503)',
  );
  assert.deepEqual(payload, { error: 'AniDB unavailable (HTTP 503)' });
  assert.doesNotMatch(JSON.stringify(payload), /curl|usr\/local|exit 22/i);
});

function request(value, headers = {}) {
  const req = Readable.from(value === undefined ? [] : [Buffer.from(value)]);
  req.headers = headers;
  return req;
}

test('readBody parses only JSON objects', async () => {
  assert.deepEqual(await readBody(request('{"ok":true}')), { ok: true });
  await assert.rejects(readBody(request('[1,2]')), (error) => error instanceof HttpError && error.status === 400);
  await assert.rejects(readBody(request('{broken')), (error) => error instanceof HttpError && error.status === 400);
});

test('readBody rejects oversized declared and streamed bodies', async () => {
  await assert.rejects(
    readBody(request('', { 'content-length': String(MAX_BODY + 1) })),
    (error) => error instanceof HttpError && error.status === 413
  );
  await assert.rejects(
    readBody(request('x'.repeat(MAX_BODY + 1))),
    (error) => error instanceof HttpError && error.status === 413
  );
});
