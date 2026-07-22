'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { configureStart, usage } = require('../../bin/animanga');

const KEYS = [
  'ANIMANGA_HOST',
  'ANIMANGA_PORT',
  'ANIMANGA_DATA_DIR',
  'ANIMANGA_ANIME_RESOLVER',
  'ANIMANGA_ANI_CLI_FALLBACK',
];

test.afterEach(() => {
  for (const key of KEYS) delete process.env[key];
});

test('global CLI exposes the expected commands', () => {
  assert.match(usage(), /animanga \[start\]/);
  assert.match(usage(), /animanga doctor/);
});

test('start options configure the server before it is loaded', () => {
  assert.equal(configureStart([
    '--host', '0.0.0.0',
    '--port', '9000',
    '--data-dir', './tmp-data',
    '--resolver', 'node',
    '--no-ani-cli-fallback',
  ]), true);
  assert.equal(process.env.ANIMANGA_HOST, '0.0.0.0');
  assert.equal(process.env.ANIMANGA_PORT, '9000');
  assert.match(process.env.ANIMANGA_DATA_DIR, /tmp-data$/);
  assert.equal(process.env.ANIMANGA_ANIME_RESOLVER, 'node');
  assert.equal(process.env.ANIMANGA_ANI_CLI_FALLBACK, '0');
});

test('start options reject invalid resolvers and unknown flags', () => {
  assert.throws(() => configureStart(['--resolver', 'magic']), /node or ani-cli/);
  assert.throws(() => configureStart(['--wat']), /Unknown option/);
});
