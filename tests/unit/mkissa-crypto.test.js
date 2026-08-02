'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  STREAM_QUERY_HASH,
  CRYPTO_LANE_MANGA,
  CRYPTO_LANE_ANIME,
  MKISSA_API_ORIGIN,
  deriveKey,
  deriveMaskFromJu,
  bootstrapEpochBucket,
  buildBootstrapHeader,
  extractClientCrypto,
  extractClientCryptoCandidates,
  extractJuCandidate,
  parseBootstrapJson,
  buildAtomicConfig,
  buildAaRequest,
  decryptAaResponse,
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
const PAIRED_MASK = 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
const LEGACY_CHUNK = [
  'noise aaReq',
  `const qd="${LEGACY_MASK}",kr=yt(183)!=="string"?"11":"";`,
].join('\n');
const CURRENT_CHUNK = [
  'noise aaReq',
  `const Ba=ht(383)!=="string"?"${CURRENT_MASK}":"",ln="12";`,
].join('\n');
const PAIRED_CHUNK = [
  'noise aaReq',
  `const qa=_t(230)!=="string"?"${PAIRED_MASK}":"",gr=_t(230)!=="string"?"65":"";`,
].join('\n');
const PART_B = Buffer.alloc(32, 7).toString('base64');
const TEST_EPOCH = 42;
const LIVE_CHUNK = path.join(__dirname, '..', 'fixtures', 'mkissa-crypto-chunk.txt');

test.afterEach(() => resetMkissaCryptoForTests());

test('deriveMaskFromJu expands four base64 chunks into a 32-byte mask', () => {
  const chunks = Array.from({ length: 4 }, () => Buffer.alloc(8, 1).toString('base64'));
  const mask = deriveMaskFromJu(chunks, '72');
  assert.equal(mask.length, 32);
  assert.equal(mask.toString('hex').length, 64);
});

test('extractClientCrypto supports legacy, mid, and paired-ternary bundle shapes', () => {
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
  assert.deepEqual(extractClientCrypto(PAIRED_CHUNK), {
    maskHex: PAIRED_MASK,
    buildId: '65',
    format: 'paired-ternary',
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

test('buildAaRequest is lane-aware in IV material and payload', () => {
  const config = buildAtomicConfig({
    epoch: TEST_EPOCH,
    partB: PART_B,
    maskHex: 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
    buildId: '12',
    lane: CRYPTO_LANE_MANGA,
  });
  const now = 1_700_000_000_000;
  const token = buildAaRequest('query { chapterPages }', config, now);
  const bytes = Buffer.from(token, 'base64');
  const iv = bytes.subarray(1, 13);
  const ciphertext = bytes.subarray(13, -16);
  const tag = bytes.subarray(-16);
  const qh = crypto.createHash('sha256').update('query { chapterPages }').digest('hex');
  const ts = Math.floor(now / 300_000) * 300_000;
  const expectedIv = crypto.createHash('sha256')
    .update(`${TEST_EPOCH}:12:${qh}:${ts}:${CRYPTO_LANE_MANGA}`)
    .digest()
    .subarray(0, 12);
  assert.deepEqual(iv, expectedIv);
  const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(config.key, 'hex'), iv);
  decipher.setAuthTag(tag);
  const payload = JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8'));
  assert.equal(payload.k, CRYPTO_LANE_MANGA);
  assert.equal(payload.qh, qh);
});

test('bootstrapEpochBucket uses the grace window', () => {
  const epochMs = 1000;
  const graceMs = 100;
  assert.equal(bootstrapEpochBucket(2500, epochMs, graceMs), 2);
  assert.equal(bootstrapEpochBucket(2050, epochMs, graceMs), 1);
});

test('buildBootstrapHeader is deterministic', () => {
  const mask = Buffer.alloc(32, 9);
  const a = buildBootstrapHeader(mask, '72', 6886, 'k9');
  const b = buildBootstrapHeader(mask, '72', 6886, 'k9');
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.notEqual(a, buildBootstrapHeader(mask, '72', 6886, 'k7'));
});

test('validates a complete generation against a gated encrypted response', async () => {
  const config = buildAtomicConfig({
    epoch: TEST_EPOCH,
    partB: PART_B,
    maskHex: 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
    buildId: '12',
    lane: CRYPTO_LANE_MANGA,
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
    assert.equal(request.extensions.k, CRYPTO_LANE_MANGA);
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
});

test('failed validation discards the unverified cached generation', async () => {
  const config = buildAtomicConfig({
    epoch: TEST_EPOCH,
    partB: PART_B,
    maskHex: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
    buildId: '12',
    lane: CRYPTO_LANE_MANGA,
  });
  rememberCompleteConfig(config);
  const fetcher = async () => ({
    ok: true,
    json: async () => ({ errors: [{ message: 'provider unavailable' }] }),
  });
  await assert.rejects(() => validateCryptoConfig(config, { fetcher }), /validation search failed/);
  assert.equal(getCachedCompleteConfig(CRYPTO_LANE_MANGA), null);
});

test('buildAtomicConfig derives a complete generation without exposing partB', () => {
  const maskHex = LEGACY_MASK;
  const config = buildAtomicConfig({
    epoch: TEST_EPOCH,
    partB: PART_B,
    maskHex,
    buildId: '12',
    lane: CRYPTO_LANE_ANIME,
    appEntryUrl: 'https://cdn.example/entry/app.js',
  });
  assert.equal(config.epoch, String(TEST_EPOCH));
  assert.equal(config.buildId, '12');
  assert.equal(config.lane, CRYPTO_LANE_ANIME);
  assert.equal(config.maskHex, maskHex);
  assert.equal(config.key, deriveKey(maskHex, PART_B).toString('hex'));
  assert.equal(config.partB, undefined);
  assert.equal(config.candidateKey, candidateKey(maskHex, '12', CRYPTO_LANE_ANIME));
  assert.match(formatCryptoFailure({ code: 'AA_CRYPTO_STALE', epoch: TEST_EPOCH, buildId: '12' }), /AA_CRYPTO_STALE/);
});

test('live refresh uses signed bootstrap API and hex chunk fallback', async () => {
  setFetchTextForTests(async (url) => {
    if (url.includes('mkissa.to') && !url.includes('.js') && !url.includes('bootstrap')) {
      return 'import("https://cdn.example/_app/immutable/entry/app.x.js")';
    }
    if (url.endsWith('app.x.js')) return 'deps["../chunks/crypto.js"]';
    if (url.includes('/chunks/crypto.js')) return PAIRED_CHUNK;
    if (url.startsWith(`${MKISSA_API_ORIGIN}/client-crypto/v1/bootstrap`)) {
      assert.match(url, /buildId=65/);
      assert.match(url, /k=k9/);
      return JSON.stringify({ epoch: TEST_EPOCH, partB: PART_B, k: 'k9' });
    }
    throw new Error(`unexpected ${url}`);
  });

  const config = await fetchLiveCryptoConfig({ lane: CRYPTO_LANE_MANGA });
  assert.equal(config.maskHex, PAIRED_MASK);
  assert.equal(config.buildId, '65');
  assert.equal(config.epoch, String(TEST_EPOCH));
  assert.equal(config.lane, CRYPTO_LANE_MANGA);
});

test('live refresh fails clearly without app-entry or high-confidence candidates', async () => {
  setFetchTextForTests(async () => '<html>no entry</html>');
  await assert.rejects(() => fetchLiveCryptoConfig(), /app entry/);

  setFetchTextForTests(async (url) => {
    if (url.includes('mkissa.to') && !url.includes('.js')) {
      return 'import("https://cdn.example/_app/immutable/entry/app.x.js")';
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
    lane: CRYPTO_LANE_MANGA,
    appEntryUrl: 'old',
  });
  markConfigVerified(verified);

  setFetchTextForTests(async () => '<html>no entry</html>');
  await assert.rejects(() => fetchLiveCryptoConfig({ lane: CRYPTO_LANE_MANGA }), /app entry/);
  const fallback = await resolveCompleteCryptoConfig({
    forceRefresh: true,
    allowLastVerifiedFallback: true,
    lane: CRYPTO_LANE_MANGA,
  });
  assert.equal(fallback.source, 'last-verified');
  assert.equal(fallback.epoch, '1');
  assert.equal(fallback.maskHex, verified.maskHex);
});

test('healing excludes already tried candidates', async () => {
  const maskA = LEGACY_MASK;
  const maskB = CURRENT_MASK;
  setFetchTextForTests(async (url) => {
    if (url.includes('mkissa.to') && !url.includes('.js') && !url.includes('bootstrap')) {
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
    if (url.startsWith(`${MKISSA_API_ORIGIN}/client-crypto/v1/bootstrap`)) {
      return JSON.stringify({ epoch: TEST_EPOCH, partB: PART_B, k: 'k9' });
    }
    throw new Error(`unexpected ${url}`);
  });

  const first = await fetchLiveCryptoConfig({ lane: CRYPTO_LANE_MANGA });
  assert.equal(first.maskHex, maskA);
  discardCompleteConfig(first);
  const second = await fetchLiveCryptoConfig({
    lane: CRYPTO_LANE_MANGA,
    excludeKeys: new Set([first.candidateKey]),
  });
  assert.equal(second.maskHex, maskB);
  assert.notEqual(second.candidateKey, first.candidateKey);
});

test('getLastVerifiedCompleteConfig stays intact after discard of a different attempt', () => {
  const verified = buildAtomicConfig({
    epoch: 5,
    partB: PART_B,
    maskHex: 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
    buildId: '5',
    lane: CRYPTO_LANE_MANGA,
  });
  markConfigVerified(verified);
  discardCompleteConfig({ candidateKey: 'other|9|k9', lane: CRYPTO_LANE_MANGA });
  assert.equal(getLastVerifiedCompleteConfig(CRYPTO_LANE_MANGA).buildId, '5');
});

test('extractJuCandidate reads the live crypto chunk when present', {
  skip: fs.existsSync(LIVE_CHUNK) ? false : 'live chunk dump not present',
}, () => {
  const source = fs.readFileSync(LIVE_CHUNK, 'utf8');
  const candidate = extractJuCandidate(source);
  assert.ok(candidate);
  assert.match(candidate.format, /^(ju|nd)-base64$/);
  assert.match(candidate.buildId, /^\d+$/);
  assert.match(candidate.maskHex, /^[0-9a-f]{64}$/);
  assert.equal(candidate.juChunks.length, 4);
  assert.equal(deriveMaskFromJu(candidate.juChunks, candidate.buildId).toString('hex'), candidate.maskHex);
});

test('decryptAaResponse round-trips lane configs', () => {
  const config = buildAtomicConfig({
    epoch: TEST_EPOCH,
    partB: PART_B,
    maskHex: LEGACY_MASK,
    buildId: '9',
    lane: CRYPTO_LANE_ANIME,
  });
  const now = Date.now();
  const token = buildAaRequest('query { episode }', config, now);
  // encrypt a response with same key
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(config.key, 'hex'), iv);
  const encrypted = Buffer.concat([
    Buffer.from([1]),
    iv,
    cipher.update(JSON.stringify({ ok: true })),
    cipher.final(),
    cipher.getAuthTag(),
  ]).toString('base64');
  assert.deepEqual(decryptAaResponse(encrypted, config), { ok: true });
  assert.ok(token);
});
