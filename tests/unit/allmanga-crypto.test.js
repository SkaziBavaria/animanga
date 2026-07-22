'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const {
  deriveMangaKey,
  extractClientCrypto,
  aaRequest,
  resetMangaCryptoForTests,
} = require('../../lib/allmanga');

test.afterEach(() => resetMangaCryptoForTests());

test('deriveMangaKey XORs the client mask with partB', () => {
  const mask = Buffer.alloc(32, 0x0f);
  const partB = Buffer.alloc(32, 0xf0);
  assert.equal(deriveMangaKey(mask, partB).toString('hex'), Buffer.alloc(32, 0xff).toString('hex'));
});

test('extractClientCrypto reads mask and buildId from the mkissa crypto chunk shape', () => {
  const legacy = [
    'noise',
    'const qd="a39b86dbbcf57f884f3e9074969e7fe26656c74012e4545605896621ffa441c1",kr=yt(183)!=="string"?"63":"";',
    'function sign(){ return aaReq; }',
  ].join('\n');
  assert.deepEqual(extractClientCrypto(legacy), {
    maskHex: 'a39b86dbbcf57f884f3e9074969e7fe26656c74012e4545605896621ffa441c1',
    buildId: '63',
  });

  const current = [
    'noise aaReq',
    'const Ba=ht(383)!=="string"?"70bb5e6260e19a806b3609dc0b6eb718899b09edbd0c23703a5de00e544de128":"",ln="64";',
  ].join('\n');
  assert.deepEqual(extractClientCrypto(current), {
    maskHex: '70bb5e6260e19a806b3609dc0b6eb718899b09edbd0c23703a5de00e544de128',
    buildId: '64',
  });
});

test('aaRequest builds a versioned AES-GCM blob', () => {
  const key = crypto.randomBytes(32).toString('hex');
  const token = aaRequest('query { chapterPages }', { key, epoch: 6885, buildId: '63' });
  const bytes = Buffer.from(token, 'base64');
  assert.equal(bytes[0], 1);
  assert.ok(bytes.length > 1 + 12 + 16);
});
