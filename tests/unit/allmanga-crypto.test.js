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
  const source = [
    'noise',
    'const qd="a39b86dbbcf57f884f3e9074969e7fe26656c74012e4545605896621ffa441c1",kr=yt(183)!=="string"?"63":"";',
    'function sign(){ return aaReq; }',
  ].join('\n');
  assert.deepEqual(extractClientCrypto(source), {
    maskHex: 'a39b86dbbcf57f884f3e9074969e7fe26656c74012e4545605896621ffa441c1',
    buildId: '63',
  });
});

test('aaRequest builds a versioned AES-GCM blob', () => {
  const key = crypto.randomBytes(32).toString('hex');
  const token = aaRequest('query { chapterPages }', { key, epoch: 6885, buildId: '63' });
  const bytes = Buffer.from(token, 'base64');
  assert.equal(bytes[0], 1);
  assert.ok(bytes.length > 1 + 12 + 16);
});
