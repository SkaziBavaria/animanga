'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { assertSameOriginMutation } = require('../../lib/csrf');
const { HttpError } = require('../../lib/http');

function req(headers = {}, method = 'POST') {
  return { method, headers, socket: { encrypted: false } };
}

test('allows safe methods without origin checks', () => {
  assert.doesNotThrow(() => assertSameOriginMutation(req({ 'sec-fetch-site': 'cross-site' }, 'GET')));
  assert.doesNotThrow(() => assertSameOriginMutation(req({}, 'HEAD')));
});

test('allows same-origin and non-browser mutations', () => {
  assert.doesNotThrow(() => assertSameOriginMutation(req({ 'sec-fetch-site': 'same-origin' })));
  assert.doesNotThrow(() => assertSameOriginMutation(req({ 'sec-fetch-site': 'none' })));
  assert.doesNotThrow(() => assertSameOriginMutation(req({})));
});

test('rejects cross-site mutations', () => {
  assert.throws(
    () => assertSameOriginMutation(req({ 'sec-fetch-site': 'cross-site' })),
    (error) => error instanceof HttpError && error.status === 403,
  );
});

test('rejects mismatched Origin headers', () => {
  assert.throws(
    () => assertSameOriginMutation(req({
      origin: 'https://evil.example',
      host: '127.0.0.1:7831',
    })),
    (error) => error instanceof HttpError && error.status === 403,
  );
});

test('accepts Origin that matches the request host', () => {
  assert.doesNotThrow(() => assertSameOriginMutation(req({
    origin: 'http://127.0.0.1:7831',
    host: '127.0.0.1:7831',
  })));
});
