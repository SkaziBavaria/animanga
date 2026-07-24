'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  STREAM_QUERY_HASH,
  deriveKey,
  extractClientCrypto,
  extractClientCryptoCandidates,
  parseBootstrapJson,
  buildAtomicConfig,
  buildAaRequest,
  fetchLiveCryptoConfig,
  validateCryptoConfig,
  resolveCompleteCryptoConfig,
  markConfigVerified,
  rememberCompleteConfig,
  discardCompleteConfig,
  getCachedCompleteConfig,
  getLastVerifiedCompleteConfig,
  setFetchTextForTests,
  resetMkissaCryptoForTests,
  candidateKey,
  formatCryptoFailure,
} = require('../../lib/mkissa-crypto');

const LEGACY_MASK = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const CURRENT_MASK = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const LEGACY_CHUNK = [
  'noise aaReq',
  `const qd="${LEGACY_MASK}",kr=yt(183)!=="string"?"11":"";`,
].join('\n');

const CURRENT_CHUNK = [
  'noise aaReq',
  `const Ba=ht(383)!=="string"?"${CURRENT_MASK}":"",ln="12";`,
].join('\n');

const PART_B = Buffer.alloc(32, 7).toString('base64');
const TEST_EPOCH = 42;

test.afterEach(() => resetMkissaCryptoForTests());

test('extractClientCrypto supports legacy and current bundle shapes', () => {
  assert.deepEqual(extractClientCrypto(LEGACY_CHUNK), {
    maskHex: LEGACY_MASK,
    buildId: '11',
    format: 'legacy',
  });
  assert.deepEqual(extractClientCrypto(CURRENT_CHUNK), {
    maskHex: CURRENT_MASK,
    buildId: '12',
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
  assert.throws(
    () => parseBootstrapJson(JSON.stringify({ epoch: 1, partB: Buffer.alloc(33).toString('base64') })),
    /exactly 32 bytes/,
  );
});

test('validates a complete generation against a gated encrypted response', async () => {
  const config = buildAtomicConfig({
    epoch: TEST_EPOCH,
    partB: PART_B,
    maskHex: 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
    buildId: '12',
  });
  let calls = 0;
  const fetcher = async (_url, options) => {
    calls += 1;
    const request = JSON.parse(options.body);
    if (calls === 1) {
      assert.equal(request.extensions, undefined);
      return {
        ok: true,
        json: async () => ({ data: { mangas: { edges: [{ _id: 'sample-manga', name: 'Sample Manga' }] } } }),
      };
    }
    assert.ok(request.extensions?.aaReq);
    assert.doesNotThrow(() => Buffer.from(request.extensions.aaReq, 'base64'));
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(config.key, 'hex'), iv);
    const payload = JSON.stringify({ chapterPages: { edges: [{ pictureUrls: [] }] } });
    const encrypted = Buffer.concat([
      Buffer.from([1]),
      iv,
      cipher.update(payload),
      cipher.final(),
      cipher.getAuthTag(),
    ]).toString('base64');
    return { ok: true, json: async () => ({ data: { tobeparsed: encrypted } }) };
  };
  const result = await validateCryptoConfig(config, { fetcher });
  assert.deepEqual(result, { ok: true, mangaId: 'sample-manga', sourceCount: 1 });
  assert.equal(calls, 2);
  assert.ok(buildAaRequest('query { chapterPages }', config));
});

test('failed validation discards the unverified cached generation', async () => {
  const config = buildAtomicConfig({
    epoch: TEST_EPOCH,
    partB: PART_B,
    maskHex: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
    buildId: '12',
  });
  rememberCompleteConfig(config);
  const fetcher = async () => ({
    ok: true,
    json: async () => ({ errors: [{ message: 'provider unavailable' }] }),
  });
  await assert.rejects(() => validateCryptoConfig(config, { fetcher }), /validation search failed/);
  assert.equal(getCachedCompleteConfig(), null);
});

test('buildAtomicConfig derives a complete generation without exposing partB', () => {
  const maskHex = LEGACY_MASK;
  const config = buildAtomicConfig({
    epoch: TEST_EPOCH,
    partB: PART_B,
    maskHex,
    buildId: '12',
    appEntryUrl: 'https://cdn.example/entry/app.js',
  });
  assert.equal(config.epoch, String(TEST_EPOCH));
  assert.equal(config.buildId, '12');
  assert.equal(config.maskHex, maskHex);
  assert.equal(config.key, deriveKey(maskHex, PART_B).toString('hex'));
  assert.equal(config.partB, undefined);
  assert.match(formatCryptoFailure({ code: 'AA_CRYPTO_STALE', epoch: TEST_EPOCH, buildId: '12' }), /AA_CRYPTO_STALE/);
  assert.doesNotMatch(
    formatCryptoFailure({ code: 'AA_CRYPTO_STALE', epoch: TEST_EPOCH, buildId: '12', message: 'failed' }),
    new RegExp(`partB|${config.key}`),
  );
});

test('live refresh fails clearly without app-entry or high-confidence candidates', async () => {
  setFetchTextForTests(async (url) => {
    if (url.includes('mkissa.to') && !url.includes('.js')) {
      return `<script>window.__aaCrypto={"epoch":${TEST_EPOCH},"partB":"${PART_B}"};</script>`;
    }
    throw new Error(`unexpected ${url}`);
  });
  await assert.rejects(() => fetchLiveCryptoConfig(), /app entry/);

  setFetchTextForTests(async (url) => {
    if (url.includes('mkissa.to') && !url.includes('.js')) {
      return [
        `<script>window.__aaCrypto={"epoch":${TEST_EPOCH},"partB":"${PART_B}"};</script>`,
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
    maskHex: LEGACY_MASK,
    buildId: '1',
    appEntryUrl: 'old',
  });
  markConfigVerified(verified);

  setFetchTextForTests(async (url) => {
    if (url.includes('mkissa.to') && !url.includes('.js')) {
      return `<script>window.__aaCrypto={"epoch":${TEST_EPOCH},"partB":"${PART_B}"};</script>`;
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
  const maskA = LEGACY_MASK;
  const maskB = CURRENT_MASK;
  setFetchTextForTests(async (url) => {
    if (url.includes('mkissa.to') && !url.includes('.js')) {
      return [
        `<script>window.__aaCrypto={"epoch":${TEST_EPOCH},"partB":"${PART_B}"};</script>`,
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
