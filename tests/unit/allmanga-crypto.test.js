'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const {
  deriveMangaKey,
  extractClientCrypto,
  aaRequest,
  encryptedGraphql,
  resetMangaCryptoForTests,
} = require('../../lib/allmanga');
const { setFetchTextForTests } = require('../../lib/mkissa-crypto');

test.afterEach(() => resetMangaCryptoForTests());

test('deriveMangaKey XORs the client mask with partB', () => {
  const mask = Buffer.alloc(32, 0x0f);
  const partB = Buffer.alloc(32, 0xf0);
  assert.equal(deriveMangaKey(mask, partB).toString('hex'), Buffer.alloc(32, 0xff).toString('hex'));
});

test('extractClientCrypto reads mask and buildId from the mkissa crypto chunk shape', () => {
  const legacy = [
    'noise aaReq',
    'const qd="a39b86dbbcf57f884f3e9074969e7fe26656c74012e4545605896621ffa441c1",kr=yt(183)!=="string"?"63":"";',
  ].join('\n');
  assert.equal(extractClientCrypto(legacy).maskHex, 'a39b86dbbcf57f884f3e9074969e7fe26656c74012e4545605896621ffa441c1');
  assert.equal(extractClientCrypto(legacy).buildId, '63');

  const current = [
    'noise aaReq',
    'const Ba=ht(383)!=="string"?"70bb5e6260e19a806b3609dc0b6eb718899b09edbd0c23703a5de00e544de128":"",ln="64";',
  ].join('\n');
  assert.equal(extractClientCrypto(current).maskHex, '70bb5e6260e19a806b3609dc0b6eb718899b09edbd0c23703a5de00e544de128');
  assert.equal(extractClientCrypto(current).buildId, '64');
});

test('aaRequest builds a versioned AES-GCM blob', () => {
  const key = crypto.randomBytes(32).toString('hex');
  const token = aaRequest('query { chapterPages }', { key, epoch: 6885, buildId: '64' });
  const bytes = Buffer.from(token, 'base64');
  assert.equal(bytes[0], 1);
  assert.ok(bytes.length > 1 + 12 + 16);
});

test('encryptedGraphql heals with a new candidate after response decryption fails', async () => {
  const partB = Buffer.alloc(32, 7).toString('base64');
  const maskA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const maskB = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  setFetchTextForTests(async (url) => {
    if (url === 'https://mkissa.to/') {
      return [
        `<script>window.__aaCrypto={"epoch":6885,"partB":"${partB}"};</script>`,
        'import("https://cdn.example/_app/immutable/entry/app.x.js")',
      ].join('\n');
    }
    if (url.endsWith('app.x.js')) return 'deps["../chunks/crypto.js"]';
    if (url.includes('/chunks/crypto.js')) {
      return [
        'aaReq',
        `const A=fn(1)!=="string"?"${maskA}":"",buildA="10";`,
        `const B=fn(2)!=="string"?"${maskB}":"",buildB="11";`,
      ].join('\n');
    }
    throw new Error(`unexpected crypto URL: ${url}`);
  });

  const originalFetch = global.fetch;
  let apiCalls = 0;
  global.fetch = async () => {
    apiCalls += 1;
    if (apiCalls === 1) {
      return { ok: true, json: async () => ({ data: { tobeparsed: 'invalid-envelope' } }) };
    }
    return { ok: true, json: async () => ({ data: { chapterPages: { edges: [] } } }) };
  };

  try {
    const data = await encryptedGraphql('query { chapterPages }', {});
    assert.deepEqual(data, { chapterPages: { edges: [] } });
    assert.equal(apiCalls, 2);
  } finally {
    global.fetch = originalFetch;
  }
});
