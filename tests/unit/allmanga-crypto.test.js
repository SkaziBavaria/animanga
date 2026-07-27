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

const LEGACY_MASK = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const CURRENT_MASK = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const PAIRED_MASK = 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
const TEST_EPOCH = 42;

test.afterEach(() => resetMangaCryptoForTests());

test('deriveMangaKey XORs the client mask with partB', () => {
  const mask = Buffer.alloc(32, 0x0f);
  const partB = Buffer.alloc(32, 0xf0);
  assert.equal(deriveMangaKey(mask, partB).toString('hex'), Buffer.alloc(32, 0xff).toString('hex'));
});

test('extractClientCrypto reads mask and buildId from the mkissa crypto chunk shape', () => {
  const legacy = [
    'noise aaReq',
    `const qd="${LEGACY_MASK}",kr=yt(183)!=="string"?"11":"";`,
  ].join('\n');
  assert.equal(extractClientCrypto(legacy).maskHex, LEGACY_MASK);
  assert.equal(extractClientCrypto(legacy).buildId, '11');

  const current = [
    'noise aaReq',
    `const Ba=ht(383)!=="string"?"${CURRENT_MASK}":"",ln="12";`,
  ].join('\n');
  assert.equal(extractClientCrypto(current).maskHex, CURRENT_MASK);
  assert.equal(extractClientCrypto(current).buildId, '12');

  const paired = [
    'noise aaReq',
    `const qa=_t(230)!=="string"?"${PAIRED_MASK}":"",gr=_t(230)!=="string"?"65":"";`,
  ].join('\n');
  assert.equal(extractClientCrypto(paired).maskHex, PAIRED_MASK);
  assert.equal(extractClientCrypto(paired).buildId, '65');
  assert.equal(extractClientCrypto(paired).format, 'paired-ternary');
});

test('aaRequest builds a versioned AES-GCM blob', () => {
  const key = crypto.randomBytes(32).toString('hex');
  const token = aaRequest('query { chapterPages }', { key, epoch: TEST_EPOCH, buildId: '12', lane: 'k9' });
  const bytes = Buffer.from(token, 'base64');
  assert.equal(bytes[0], 1);
  assert.ok(bytes.length > 1 + 12 + 16);
});

test('encryptedGraphql heals with a new candidate after response decryption fails', async () => {
  const partB = Buffer.alloc(32, 7).toString('base64');
  const maskA = LEGACY_MASK;
  const maskB = CURRENT_MASK;
  setFetchTextForTests(async (url) => {
    if (url === 'https://mkissa.to/') {
      return 'import("https://cdn.example/_app/immutable/entry/app.x.js")';
    }
    if (url.endsWith('app.x.js')) return 'deps["../chunks/crypto.js"]';
    if (url.includes('/chunks/crypto.js')) {
      return [
        'aaReq',
        `const A=fn(1)!=="string"?"${maskA}":"",ln="10";`,
        `const B=fn(2)!=="string"?"${maskB}":"",ln="11";`,
      ].join('\n');
    }
    if (String(url).includes('/client-crypto/v1/bootstrap')) {
      return JSON.stringify({ epoch: TEST_EPOCH, partB, k: 'k9' });
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
