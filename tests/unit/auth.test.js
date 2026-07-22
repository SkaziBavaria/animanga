'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

function loadAuth({ token = '', username = 'animanga' } = {}) {
  process.env.ANIMANGA_ACCESS_TOKEN = token;
  process.env.ANIMANGA_ACCESS_USERNAME = username;
  for (const module of ['../../lib/auth', '../../lib/config']) delete require.cache[require.resolve(module)];
  return require('../../lib/auth');
}

function request(header = '') {
  return { headers: { authorization: header } };
}

function basic(username, password) {
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

test.afterEach(() => {
  delete process.env.ANIMANGA_ACCESS_TOKEN;
  delete process.env.ANIMANGA_ACCESS_USERNAME;
  for (const module of ['../../lib/auth', '../../lib/config']) delete require.cache[require.resolve(module)];
});

test('allows requests when optional authentication is disabled', () => {
  const { requestAuthorized } = loadAuth();
  assert.equal(requestAuthorized(request()), true);
});

test('accepts only the configured Basic-auth credentials', () => {
  const { requestAuthorized } = loadAuth({ token: 'correct horse battery staple', username: 'owner' });
  assert.equal(requestAuthorized(request(basic('owner', 'correct horse battery staple'))), true);
  assert.equal(requestAuthorized(request(basic('owner', 'wrong'))), false);
  assert.equal(requestAuthorized(request(basic('animanga', 'correct horse battery staple'))), false);
  assert.equal(requestAuthorized(request('Bearer nope')), false);
});

test('parses passwords containing colons without truncating them', () => {
  const { basicCredentials } = loadAuth({ token: 'one:two' });
  assert.deepEqual(basicCredentials(basic('animanga', 'one:two')), {
    username: 'animanga',
    password: 'one:two',
  });
});

test('rejects oversized and ambiguously separated authorization headers', () => {
  const { basicCredentials } = loadAuth();
  assert.equal(basicCredentials(`Basic ${'A'.repeat(9 * 1024)}`), null);
  assert.equal(basicCredentials(`Basic  ${Buffer.from('animanga:secret').toString('base64')}`), null);
});
