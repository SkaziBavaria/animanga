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
  for (const module of ['../../lib/origin', '../../lib/config', '../../lib/routes/sync']) {
    delete require.cache[require.resolve(module)];
  }
  return require('../../lib/origin');
}

function loadConfig(environment = {}) {
  Object.assign(process.env, {
    ANIMANGA_HOST: '127.0.0.1',
    ANIMANGA_PORT: '7831',
    ANIMANGA_PUBLIC_URL: '',
    ANIMANGA_TRUST_PROXY: '0',
    ...environment,
  });
  for (const module of ['../../lib/config', '../../lib/origin']) {
    delete require.cache[require.resolve(module)];
  }
  return require('../../lib/config');
}

test('ignores untrusted host and forwarded headers by default', () => {
  const { requestOrigin, requestHostOrigin } = loadOrigin();
  const req = {
    headers: {
      host: 'attacker.example',
      'x-forwarded-host': 'attacker.example',
      'x-forwarded-proto': 'https',
    },
  };
  assert.equal(requestOrigin(req), 'http://127.0.0.1:9999');
  assert.equal(requestHostOrigin(req), 'http://attacker.example');
});

test('uses a fixed public origin when configured', () => {
  const { requestOrigin, allowedOrigins, requestHostOrigin } = loadOrigin({ ANIMANGA_PUBLIC_URL: 'https://anime.example' });
  assert.equal(requestOrigin({ headers: { host: 'attacker.example' } }), 'https://anime.example');
  assert.equal(requestHostOrigin({
    headers: {
      host: '127.0.0.1:9999',
      'x-forwarded-host': 'evil.example',
      'x-forwarded-proto': 'https',
    },
  }), 'https://anime.example');
  const allowed = allowedOrigins({ headers: { host: '127.0.0.1:9999', 'x-forwarded-host': 'evil.example' }, socket: {} });
  assert.equal(allowed.has('https://anime.example'), true);
  assert.equal(allowed.has('https://evil.example'), false);
});

test('rejects public URLs with paths or credentials', () => {
  const { publicOrigin } = require('../../lib/config');
  assert.throws(() => publicOrigin('https://anime.example/subpath'), /only an origin/);
  assert.throws(() => publicOrigin('https://owner:secret@anime.example'), /without credentials/);
});

test('accepts forwarded origin only when proxy trust and public URL are set', () => {
  const { requestOrigin, requestHostOrigin } = loadOrigin({
    ANIMANGA_TRUST_PROXY: '1',
    ANIMANGA_PUBLIC_URL: 'https://anime.example',
  });
  const req = { headers: { 'x-forwarded-host': 'other.example', 'x-forwarded-proto': 'https' } };
  assert.equal(requestOrigin(req), 'https://anime.example');
  assert.equal(requestHostOrigin(req), 'https://anime.example');
});

test('requires PUBLIC_URL when TRUST_PROXY is enabled', () => {
  assert.throws(
    () => loadConfig({ ANIMANGA_TRUST_PROXY: '1', ANIMANGA_PUBLIC_URL: '' }),
    /ANIMANGA_PUBLIC_URL is required/,
  );
});
