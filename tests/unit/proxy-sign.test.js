'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

function loadProxySign(environment = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'animanga-proxy-'));
  Object.assign(process.env, {
    ANIMANGA_DATA_DIR: dataDir,
    ANIMANGA_ACCESS_TOKEN: '',
    ANIMANGA_PROXY_SECRET: 'test-proxy-secret',
    ANIMANGA_TRUST_PROXY: '0',
    ANIMANGA_PUBLIC_URL: '',
    ...environment,
  });
  for (const module of ['../../lib/proxy-sign', '../../lib/config', '../../lib/proxy']) {
    delete require.cache[require.resolve(module)];
  }
  const proxySign = require('../../lib/proxy-sign');
  proxySign.resetProxySecretForTests();
  return proxySign;
}

test('buildProxyPath signs url referrer and expiry', () => {
  const { buildProxyPath, assertProxySignature } = loadProxySign();
  const pathValue = buildProxyPath('https://cdn.example/video.mp4', 'https://referrer.example/', { ttlSeconds: 3600 });
  assert.match(pathValue, /^\/api\/proxy\?/);
  const params = new URL(pathValue, 'http://local.invalid').searchParams;
  assert.equal(params.get('url'), 'https://cdn.example/video.mp4');
  assert.equal(params.get('referrer'), 'https://referrer.example/');
  assert.ok(params.get('exp'));
  assert.ok(params.get('sig'));
  assert.doesNotThrow(() => assertProxySignature(params));
});

test('assertProxySignature rejects missing expired and forged signatures', () => {
  const { buildProxyPath, assertProxySignature } = loadProxySign();
  assert.throws(() => assertProxySignature(new URLSearchParams({ url: 'https://cdn.example/a.mp4' })), /required/);

  const params = new URL(buildProxyPath('https://cdn.example/a.mp4', '', { ttlSeconds: 3600 }), 'http://local.invalid').searchParams;
  params.set('exp', String(Math.floor(Date.now() / 1000) - 10));
  assert.throws(() => assertProxySignature(params), /expired/);

  const forged = new URL(buildProxyPath('https://cdn.example/a.mp4', '', { ttlSeconds: 3600 }), 'http://local.invalid').searchParams;
  forged.set('sig', 'not-a-real-signature-value-pad');
  assert.throws(() => assertProxySignature(forged), /Invalid proxy signature/);
});

test('proxiedThumbnail leaves local paths alone', () => {
  const { proxiedThumbnail } = loadProxySign();
  assert.equal(proxiedThumbnail('/api/manga/x/pages/1'), '/api/manga/x/pages/1');
  assert.match(proxiedThumbnail('https://cdn.example/cover.jpg'), /^\/api\/proxy\?/);
});
