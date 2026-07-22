'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

function loadOrigin(environment = {}) {
  Object.assign(process.env, {
    ANIMANGA_HOST: '0.0.0.0',
    ANIMANGA_PORT: '9999',
    ANIMANGA_PUBLIC_URL: '',
    ANIMANGA_TRUST_PROXY: '0',
    ...environment,
  });
  for (const module of ['../../lib/routes/sync', '../../lib/config']) {
    delete require.cache[require.resolve(module)];
  }
  return require('../../lib/routes/sync').requestOrigin;
}

test('ignores untrusted host and forwarded headers by default', () => {
  const requestOrigin = loadOrigin();
  const origin = requestOrigin({
    headers: {
      host: 'attacker.example',
      'x-forwarded-host': 'attacker.example',
      'x-forwarded-proto': 'https',
    },
  });
  assert.equal(origin, 'http://127.0.0.1:9999');
});

test('uses a fixed public origin when configured', () => {
  const requestOrigin = loadOrigin({ ANIMANGA_PUBLIC_URL: 'https://anime.example' });
  assert.equal(requestOrigin({ headers: { host: 'attacker.example' } }), 'https://anime.example');
});

test('rejects public URLs with paths or credentials', () => {
  const { publicOrigin } = require('../../lib/config');
  assert.throws(() => publicOrigin('https://anime.example/subpath'), /only an origin/);
  assert.throws(() => publicOrigin('https://owner:secret@anime.example'), /without credentials/);
});

test('accepts forwarded origin only when proxy trust is explicit', () => {
  const requestOrigin = loadOrigin({ ANIMANGA_TRUST_PROXY: '1' });
  const origin = requestOrigin({
    headers: { 'x-forwarded-host': 'anime.example', 'x-forwarded-proto': 'https' },
  });
  assert.equal(origin, 'https://anime.example');
});
