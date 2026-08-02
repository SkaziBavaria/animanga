'use strict';

// Legacy mkissa crypto helpers are kept for reference/tests, but manga runtime no longer uses them.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const {
  deriveKey,
  extractClientCrypto,
  buildAaRequest,
  resetMkissaCryptoForTests,
} = require('../../lib/mkissa-crypto');

const LEGACY_MASK = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const CURRENT_MASK = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const PAIRED_MASK = 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
const TEST_EPOCH = 42;

test.afterEach(() => resetMkissaCryptoForTests());

test('deriveKey XORs the client mask with partB', () => {
  const mask = Buffer.alloc(32, 0x0f);
  const partB = Buffer.alloc(32, 0xf0);
  assert.equal(deriveKey(mask, partB).toString('hex'), Buffer.alloc(32, 0xff).toString('hex'));
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

test('buildAaRequest builds a versioned AES-GCM blob', () => {
  const key = crypto.randomBytes(32).toString('hex');
  const token = buildAaRequest('query { chapterPages }', { key, epoch: TEST_EPOCH, buildId: '12', lane: 'k9' });
  const bytes = Buffer.from(token, 'base64');
  assert.equal(bytes[0], 1);
  assert.ok(bytes.length > 1 + 12 + 16);
});
