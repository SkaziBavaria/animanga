'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  STREAM_QUERY_HASH,
  deriveKey,
  extractClientCrypto,
  extractClientCryptoCandidates,
  parseBootstrapJson,
  buildAtomicConfig,
  fetchLiveCryptoConfig,
  resolveCompleteCryptoConfig,
  markConfigVerified,
  discardCompleteConfig,
  getLastVerifiedCompleteConfig,
  setFetchTextForTests,
  resetMkissaCryptoForTests,
  candidateKey,
  formatCryptoFailure,
} = require('../../lib/mkissa-crypto');

const LEGACY_CHUNK = [
  'noise aaReq',
  'const qd="a39b86dbbcf57f884f3e9074969e7fe26656c74012e4545605896621ffa441c1",kr=yt(183)!=="string"?"63":"";',
].join('\n');

const CURRENT_CHUNK = [
  'noise aaReq',
  'const Ba=ht(383)!=="string"?"70bb5e6260e19a806b3609dc0b6eb718899b09edbd0c23703a5de00e544de128":"",ln="64";',
].join('\n');

const PART_B = Buffer.alloc(32, 7).toString('base64');

test.afterEach(() => resetMkissaCryptoForTests());

test('extractClientCrypto supports legacy and current bundle shapes', () => {
  assert.deepEqual(extractClientCrypto(LEGACY_CHUNK), {
    maskHex: 'a39b86dbbcf57f884f3e9074969e7fe26656c74012e4545605896621ffa441c1',
    buildId: '63',
    format: 'legacy',
  });
  assert.deepEqual(extractClientCrypto(CURRENT_CHUNK), {
    maskHex: '70bb5e6260e19a806b3609dc0b6eb718899b09edbd0c23703a5de00e544de128',
    buildId: '64',
    format: 'ternary',
  });
});

test('rejects query hashes and unpaired 64-hex values as masks', () => {
  const noisy = [
    'aaReq',
    `"${STREAM_QUERY_HASH}"`,
    '"ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"',
  ].join('\n');
  assert.equal(extractClientCrypto(noisy), null);
  assert.deepEqual(extractClientCryptoCandidates(noisy), []);
});

test('parseBootstrapJson fails closed on missing or invalid partB', () => {
  assert.throws(() => parseBootstrapJson(null), /bootstrap/);
  assert.throws(() => parseBootstrapJson('{"epoch":1}'), /partB/);
  assert.throws(() => parseBootstrapJson('{"epoch":1,"partB":"@@@"}'), /partB|incomplete|invalid/);
});

test('buildAtomicConfig derives a complete generation without exposing partB', () => {
  const maskHex = 'a39b86dbbcf57f884f3e9074969e7fe26656c74012e4545605896621ffa441c1';
  const config = buildAtomicConfig({
    epoch: 6885,
    partB: PART_B,
    maskHex,
    buildId: '64',
    appEntryUrl: 'https://cdn.example/entry/app.js',
  });
  assert.equal(config.epoch, '6885');
  assert.equal(config.buildId, '64');
  assert.equal(config.maskHex, maskHex);
  assert.equal(config.key, deriveKey(maskHex, PART_B).toString('hex'));
  assert.equal(config.partB, undefined);
  assert.match(formatCryptoFailure({ code: 'AA_CRYPTO_STALE', epoch: 6885, buildId: '64' }), /AA_CRYPTO_STALE/);
  assert.doesNotMatch(
    formatCryptoFailure({ code: 'AA_CRYPTO_STALE', epoch: 6885, buildId: '64', message: 'failed' }),
    new RegExp(`partB|${config.key}`),
  );
});

test('live refresh fails clearly without app-entry or high-confidence candidates', async () => {
  setFetchTextForTests(async (url) => {
    if (url.includes('mkissa.to') && !url.includes('.js')) {
      return '<script>window.__aaCrypto={"epoch":6885,"partB":"' + PART_B + '"};</script>';
    }
    throw new Error(`unexpected ${url}`);
  });
  await assert.rejects(() => fetchLiveCryptoConfig(), /app entry/);

  setFetchTextForTests(async (url) => {
    if (url.includes('mkissa.to') && !url.includes('.js')) {
      return [
        '<script>window.__aaCrypto={"epoch":6885,"partB":"' + PART_B + '"};</script>',
        'import("https://cdn.example/_app/immutable/entry/app.x.js")',
      ].join('\n');
    }
    if (url.endsWith('app.x.js')) return '["../chunks/crypto.js"]';
    if (url.includes('/chunks/crypto.js')) return 'aaReq only, no mask pair';
    throw new Error(`unexpected ${url}`);
  });
  await assert.rejects(() => fetchLiveCryptoConfig(), /high-confidence|mask\/buildId/);
});

test('never mixes a fresh bootstrap with another generation mask', async () => {
  const verified = buildAtomicConfig({
    epoch: 1,
    partB: Buffer.alloc(32, 1).toString('base64'),
    maskHex: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    buildId: '1',
    appEntryUrl: 'old',
  });
  markConfigVerified(verified);

  setFetchTextForTests(async (url) => {
    if (url.includes('mkissa.to') && !url.includes('.js')) {
      return '<script>window.__aaCrypto={"epoch":6885,"partB":"' + PART_B + '"};</script>';
    }
    throw new Error(`unexpected ${url}`);
  });

  await assert.rejects(() => fetchLiveCryptoConfig(), /app entry/);
  const fallback = await resolveCompleteCryptoConfig({ forceRefresh: true, allowLastVerifiedFallback: true });
  assert.equal(fallback.source, 'last-verified');
  assert.equal(fallback.epoch, '1');
  assert.equal(fallback.maskHex, verified.maskHex);
});

test('healing excludes already tried candidates', async () => {
  const maskA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const maskB = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  setFetchTextForTests(async (url) => {
    if (url.includes('mkissa.to') && !url.includes('.js')) {
      return [
        '<script>window.__aaCrypto={"epoch":6885,"partB":"' + PART_B + '"};</script>',
        'import("https://cdn.example/_app/immutable/entry/app.x.js")',
      ].join('\n');
    }
    if (url.endsWith('app.x.js')) return 'deps["../chunks/crypto.js"]';
    if (url.includes('/chunks/crypto.js')) {
      return [
        'aaReq',
        `const A=fn(1)!=="string"?"${maskA}":"",ln="10";`,
        `const B=fn(2)!=="string"?"${maskB}":"",ln="11";`,
      ].join('\n');
    }
    throw new Error(`unexpected ${url}`);
  });

  const first = await fetchLiveCryptoConfig();
  assert.equal(first.maskHex, maskA);
  discardCompleteConfig(first);
  const second = await fetchLiveCryptoConfig({ excludeKeys: new Set([first.candidateKey]) });
  assert.equal(second.maskHex, maskB);
  assert.notEqual(second.candidateKey, first.candidateKey);
  assert.equal(candidateKey(maskA, '10'), first.candidateKey);
});

test('getLastVerifiedCompleteConfig stays intact after discard of a different attempt', () => {
  const verified = buildAtomicConfig({
    epoch: 5,
    partB: PART_B,
    maskHex: 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
    buildId: '5',
  });
  markConfigVerified(verified);
  discardCompleteConfig({ candidateKey: 'other|9' });
  assert.equal(getLastVerifiedCompleteConfig().buildId, '5');
});
