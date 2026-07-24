'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { assertSecureBind, isOpenBind } = require('../../lib/bind-security');

test('detects open bind addresses', () => {
  assert.equal(isOpenBind('0.0.0.0'), true);
  assert.equal(isOpenBind('::'), true);
  assert.equal(isOpenBind('127.0.0.1'), false);
});

test('refuses open bind without authentication outside Docker', () => {
  assert.throws(
    () => assertSecureBind({ host: '0.0.0.0', accessToken: '', inDocker: false, allowInsecure: false }),
    /Refusing to listen on 0\.0\.0\.0 without authentication/,
  );
});

test('allows open bind without authentication in Docker or with explicit opt-in', () => {
  assert.doesNotThrow(() => assertSecureBind({ host: '0.0.0.0', accessToken: '', inDocker: true }));
  assert.doesNotThrow(() => assertSecureBind({ host: '::', accessToken: '', allowInsecure: true }));
  assert.doesNotThrow(() => assertSecureBind({ host: '0.0.0.0', accessToken: 'secret' }));
  assert.doesNotThrow(() => assertSecureBind({ host: '127.0.0.1', accessToken: '' }));
});
