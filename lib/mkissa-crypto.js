'use strict';

const crypto = require('crypto');
const { fetchWithTimeout } = require('./upstream');

const MKISSA_ORIGIN = 'https://mkissa.to';
const ALLMANGA_API = 'https://api.allanime.day/api';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:150.0) Gecko/20100101 Firefox/150.0';
const MAX_MASK_CHUNKS = 40;
const CRYPTO_MATERIAL_TTL_MS = 6 * 60 * 60 * 1000;
const STREAM_QUERY_HASH = 'd405d0edd690624b66baba3068e0edc3ac90f1597d898a1ec8db4e5c43c00fec';
// Known persisted-query / stream hashes that must never be treated as client masks.
const KNOWN_NON_MASK_HEX = new Set([
  STREAM_QUERY_HASH,
  '49a2b4f2aed8c739a9ad13bdd02654d23aa79e416e24e0c1dfb5484746b648f8',
  '3bf06f51474dc99d2696a44c95867f441b50934cabaee30153319e3c7ffffb0f',
  '1f9445f5677aefe9073038d870a533e17475926fb3abd7e911f19ea5127ebe17',
]);
const AA_CRYPTO_REGEX = /window\.__aaCrypto\s*=\s*(\{[^{}]*\})/;
const APP_ENTRY_REGEX = /import\("([^"]*\/entry\/app\.[^"]*\.js)"\)/;
const CHUNK_REF_REGEX = /\.\.\/chunks\/([A-Za-z0-9_.-]+\.js)/g;
// Older bundle: "mask",kr=fn(n)!=="string"?"63":""
const LEGACY_CLIENT_CRYPTO_REGEX = /["']([0-9a-fA-F]{64})["']\s*,\s*[A-Za-z_$][\w$]*=\w+\(\d+\)!==["']string["']\?["'](\d+)["']:["']["']/g;
// Current bundle: Ba=fn(n)!=="string"?"mask":"",ln="64"
const MASK_TERNARY_WITH_BUILD_REGEX = /!==["']string["']\?["']([0-9a-fA-F]{64})["']:["']["']\s*,\s*[A-Za-z_$][\w$]*=["'](\d+)["']/g;
const VALIDATION_SEARCH_QUERY = 'query($search:SearchInput $limit:Int $page:Int $translationType:VaildTranslationTypeMangaEnumType $countryOrigin:VaildCountryOriginEnumType){mangas(search:$search limit:$limit page:$page translationType:$translationType countryOrigin:$countryOrigin){edges{_id name englishName}}}';
const CHAPTER_PAGES_QUERY = 'query($mangaId:String!,$translationType:VaildTranslationTypeMangaEnumType!,$chapterString:String!,$page:Int,$limit:Int!,$offset:Int){chapterPages(mangaId:$mangaId translationType:$translationType chapterString:$chapterString page:$page limit:$limit offset:$offset){edges{streamerId sourceName chapterString pictureUrls pictureUrlsProcessed pictureUrlHead notes uploadDate sourceUrl priority versionFix} pageInfo{total} manga{_id name thumbnail availableChaptersDetail availableChapters}}}';

let fetchImpl = defaultFetchText;
let cachedComplete = null;
let lastVerifiedComplete = null;
const inflightLive = new Map();

async function defaultFetchText(url) {
  const response = await fetchWithTimeout(fetch, url, {
    headers: {
      'user-agent': USER_AGENT,
      referer: `${MKISSA_ORIGIN}/`,
      origin: MKISSA_ORIGIN,
    },
  });
  if (!response.ok) throw new Error(`mkissa crypto fetch failed (${response.status}) for ${url}`);
  return response.text();
}

function setFetchTextForTests(fetcher) {
  fetchImpl = fetcher || defaultFetchText;
}

function resetMkissaCryptoForTests() {
  cachedComplete = null;
  lastVerifiedComplete = null;
  inflightLive.clear();
  fetchImpl = defaultFetchText;
}

function candidateKey(maskHex, buildId) {
  return `${String(maskHex).toLowerCase()}|${String(buildId)}`;
}

function isExcludedHex(hex) {
  return KNOWN_NON_MASK_HEX.has(String(hex).toLowerCase());
}

function deriveKey(mask, partB) {
  const maskBytes = Buffer.isBuffer(mask) ? mask : Buffer.from(mask, 'hex');
  const partBytes = Buffer.isBuffer(partB) ? partB : Buffer.from(partB, 'base64');
  if (maskBytes.length !== 32) throw new Error('mkissa client mask must be 32 bytes');
  if (partBytes.length !== 32) throw new Error('mkissa partB must decode to exactly 32 bytes');
  const key = Buffer.alloc(32);
  for (let i = 0; i < 32; i += 1) key[i] = partBytes[i] ^ maskBytes[i % maskBytes.length];
  return key;
}

function parseBootstrapJson(bootstrapJson) {
  if (!bootstrapJson) throw new Error('Unable to obtain mkissa crypto bootstrap');
  let bootstrap;
  try {
    bootstrap = JSON.parse(bootstrapJson);
  } catch {
    throw new Error('mkissa crypto bootstrap JSON is invalid');
  }
  const epoch = Number(bootstrap.epoch);
  if (!Number.isInteger(epoch) || epoch <= 0) throw new Error('mkissa crypto bootstrap is missing epoch');
  if (typeof bootstrap.partB !== 'string' || !bootstrap.partB) throw new Error('mkissa crypto bootstrap is missing partB');
  let partBytes;
  try {
    partBytes = Buffer.from(bootstrap.partB, 'base64');
  } catch {
    throw new Error('mkissa crypto bootstrap partB is invalid');
  }
  if (partBytes.length !== 32) throw new Error('mkissa crypto bootstrap partB must contain exactly 32 bytes');
  return {
    epoch,
    partB: bootstrap.partB,
  };
}

function buildAaRequestFromHash(qh, config, now = Date.now()) {
  if (!/^[0-9a-f]{64}$/i.test(String(qh))) throw new Error('aaReq query hash must be 32-byte hex');
  const ts = Math.floor(now / 300_000) * 300_000;
  const iv = crypto.createHash('sha256')
    .update(`${config.epoch}:${config.buildId}:${qh}:${ts}`)
    .digest()
    .subarray(0, 12);
  const payload = JSON.stringify({
    v: 1,
    ts,
    epoch: Number(config.epoch),
    buildId: String(config.buildId),
    qh,
  });
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(config.key, 'hex'), iv);
  return Buffer.concat([
    Buffer.from([1]),
    iv,
    cipher.update(payload),
    cipher.final(),
    cipher.getAuthTag(),
  ]).toString('base64');
}

function buildAaRequest(query, config, now = Date.now()) {
  const qh = crypto.createHash('sha256').update(query).digest('hex');
  return buildAaRequestFromHash(qh, config, now);
}

function decryptAaResponse(value, config) {
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length < 1 + 12 + 16 || bytes[0] !== 1) {
    throw new Error('AllManga encrypted response has an invalid envelope');
  }
  const iv = bytes.subarray(1, 13);
  const ciphertext = bytes.subarray(13, -16);
  const tag = bytes.subarray(-16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(config.key, 'hex'), iv);
  decipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8'));
}

function buildAtomicConfig({ epoch, partB, maskHex, buildId, appEntryUrl, source }) {
  const normalizedMask = String(maskHex).toLowerCase();
  const normalizedBuildId = String(buildId);
  if (!/^[0-9a-f]{64}$/.test(normalizedMask) || isExcludedHex(normalizedMask)) {
    throw new Error('mkissa client mask is not usable');
  }
  if (!/^\d+$/.test(normalizedBuildId)) throw new Error('mkissa buildId is not usable');
  return {
    key: deriveKey(normalizedMask, partB).toString('hex'),
    epoch: String(epoch),
    buildId: normalizedBuildId,
    maskHex: normalizedMask,
    origin: MKISSA_ORIGIN,
    appEntryUrl: appEntryUrl || null,
    source: source || 'mkissa',
    candidateKey: candidateKey(normalizedMask, normalizedBuildId),
    fetchedAt: Date.now(),
    expiresAt: Date.now() + CRYPTO_MATERIAL_TTL_MS,
  };
}

function extractClientCryptoCandidates(source, { excludeKeys = new Set() } = {}) {
  if (!source || !source.includes('aaReq')) return [];
  const found = [];
  const seen = new Set();

  const push = (maskHex, buildId, format) => {
    const normalizedMask = String(maskHex).toLowerCase();
    const normalizedBuildId = String(buildId);
    if (isExcludedHex(normalizedMask) || !/^\d+$/.test(normalizedBuildId)) return;
    const key = candidateKey(normalizedMask, normalizedBuildId);
    if (seen.has(key) || excludeKeys.has(key)) return;
    seen.add(key);
    found.push({ maskHex: normalizedMask, buildId: normalizedBuildId, format });
  };

  // Priority 1: strict legacy paired format.
  for (const match of source.matchAll(LEGACY_CLIENT_CRYPTO_REGEX)) {
    push(match[1], match[2], 'legacy');
  }
  // Priority 2: strict current ternary + buildId assignment.
  for (const match of source.matchAll(MASK_TERNARY_WITH_BUILD_REGEX)) {
    push(match[1], match[2], 'ternary');
  }

  return found;
}

function extractClientCrypto(source, { skipMaskHex = '', excludeKeys = new Set() } = {}) {
  const exclude = new Set(excludeKeys);
  const candidates = extractClientCryptoCandidates(source, { excludeKeys: exclude });
  if (!skipMaskHex) return candidates[0] || null;
  const skip = String(skipMaskHex).toLowerCase();
  return candidates.find((candidate) => candidate.maskHex !== skip) || null;
}

async function collectBundleCandidates(appEntryUrl, { excludeKeys = new Set() } = {}) {
  if (!appEntryUrl) throw new Error('mkissa app entry is missing; refusing incomplete crypto material');
  const appJs = await fetchImpl(appEntryUrl);
  const chunkBase = `${appEntryUrl.replace(/\/entry\/[^/]+$/, '')}/chunks/`;
  const chunkNames = [...appJs.matchAll(CHUNK_REF_REGEX)].map((match) => match[1]);
  const candidates = [];
  const seen = new Set();

  for (const name of chunkNames.slice(0, MAX_MASK_CHUNKS)) {
    const body = await fetchImpl(chunkBase + name).catch(() => '');
    for (const candidate of extractClientCryptoCandidates(body, { excludeKeys })) {
      if (seen.has(candidateKey(candidate.maskHex, candidate.buildId))) continue;
      seen.add(candidateKey(candidate.maskHex, candidate.buildId));
      candidates.push(candidate);
    }
  }

  if (!candidates.length) {
    throw new Error('mkissa crypto chunk has no high-confidence mask/buildId pair');
  }
  return candidates;
}

function getCachedCompleteConfig() {
  if (cachedComplete && Date.now() < cachedComplete.expiresAt) return { ...cachedComplete };
  return null;
}

function getLastVerifiedCompleteConfig() {
  return lastVerifiedComplete ? { ...lastVerifiedComplete } : null;
}

function rememberCompleteConfig(config, { verified = false } = {}) {
  cachedComplete = { ...config, expiresAt: Date.now() + CRYPTO_MATERIAL_TTL_MS };
  if (verified) lastVerifiedComplete = { ...cachedComplete };
}

function discardCompleteConfig(config) {
  if (config && cachedComplete && cachedComplete.candidateKey === config.candidateKey) {
    cachedComplete = null;
  }
}

function markConfigVerified(config) {
  rememberCompleteConfig(config, { verified: true });
}

async function fetchLiveCryptoConfig({ excludeKeys = new Set() } = {}) {
  const inflightKey = [...excludeKeys].sort().join(',');
  if (inflightLive.has(inflightKey)) return inflightLive.get(inflightKey);

  const request = (async () => {
    const html = await fetchImpl(`${MKISSA_ORIGIN}/`);
    const bootstrap = parseBootstrapJson(html.match(AA_CRYPTO_REGEX)?.[1]);
    const appEntryUrl = html.match(APP_ENTRY_REGEX)?.[1];
    if (!appEntryUrl) throw new Error('mkissa app entry is missing; refusing incomplete crypto material');

    const candidates = await collectBundleCandidates(appEntryUrl, { excludeKeys });
    const chosen = candidates[0];
    const config = buildAtomicConfig({
      epoch: bootstrap.epoch,
      partB: bootstrap.partB,
      maskHex: chosen.maskHex,
      buildId: chosen.buildId,
      appEntryUrl,
      source: 'mkissa',
    });
    rememberCompleteConfig(config, { verified: false });
    return config;
  })();
  inflightLive.set(inflightKey, request);

  try {
    return await request;
  } finally {
    inflightLive.delete(inflightKey);
  }
}

async function postGraphql(fetcher, query, variables, config = null) {
  const headers = {
    'content-type': 'application/json',
    'user-agent': USER_AGENT,
    referer: `${MKISSA_ORIGIN}/`,
    origin: MKISSA_ORIGIN,
  };
  const extensions = config ? { aaReq: buildAaRequest(query, config) } : undefined;
  if (config) headers['x-build-id'] = config.buildId;
  const response = await fetchWithTimeout(fetcher, ALLMANGA_API, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query, variables, ...(extensions ? { extensions } : {}) }),
  });
  if (!response.ok) throw new Error(`AllManga crypto validation returned HTTP ${response.status}`);
  return response.json();
}

/**
 * Validate a complete generation against the gated chapterPages resolver
 * before it is trusted by the runtime adapters.
 */
async function validateCryptoConfigCandidate(config, { fetcher = fetch } = {}) {
  const search = await postGraphql(fetcher, VALIDATION_SEARCH_QUERY, {
    search: {
      allowAdult: false,
      allowUnknown: false,
      sortBy: 'Latest_Update',
      sortDirection: 'DSC',
      isManga: true,
      query: 'One Piece',
    },
    limit: 5,
    page: 1,
    translationType: 'sub',
    countryOrigin: 'ALL',
  });
  if (search.errors?.length) {
    throw new Error(`AllManga crypto validation search failed: ${search.errors.map((item) => item.message).join('; ')}`);
  }
  const matches = search.data?.mangas?.edges || [];
  const manga = matches.find((item) => /one piece/i.test(item?.englishName || item?.name || '')) || matches[0];
  if (!manga?._id) throw new Error('AllManga crypto validation could not resolve a manga id');

  const result = await postGraphql(fetcher, CHAPTER_PAGES_QUERY, {
    mangaId: manga._id,
    translationType: 'sub',
    chapterString: '1',
    page: 1,
    limit: 20,
    offset: 0,
  }, config);
  if (result.errors?.length) {
    const first = result.errors[0];
    throw new Error(formatCryptoFailure({
      message: result.errors.map((item) => item.message).join('; '),
      code: first?.extensions?.code,
      epoch: config.epoch,
      buildId: config.buildId,
    }));
  }

  let data;
  try {
    data = result.data?.tobeparsed ? decryptAaResponse(result.data.tobeparsed, config) : result.data;
  } catch (error) {
    throw new Error(formatCryptoFailure({
      message: `AllManga crypto validation could not decrypt the response: ${error.message}`,
      epoch: config.epoch,
      buildId: config.buildId,
    }));
  }
  if (!Array.isArray(data?.chapterPages?.edges)) {
    throw new Error(formatCryptoFailure({
      message: 'AllManga crypto validation returned no chapter page data',
      epoch: config.epoch,
      buildId: config.buildId,
    }));
  }
  markConfigVerified(config);
  return { ok: true, mangaId: manga._id, sourceCount: data.chapterPages.edges.length };
}

async function validateCryptoConfig(config, options = {}) {
  try {
    return await validateCryptoConfigCandidate(config, options);
  } catch (error) {
    discardCompleteConfig(config);
    throw error;
  }
}

/**
 * Resolve a complete crypto generation.
 * Never mixes a fresh bootstrap with a mask/buildId from another generation.
 */
async function resolveCompleteCryptoConfig({
  forceRefresh = false,
  excludeKeys = new Set(),
  allowLastVerifiedFallback = true,
} = {}) {
  if (!forceRefresh) {
    const cached = getCachedCompleteConfig();
    if (cached && !excludeKeys.has(cached.candidateKey)) return cached;
  }

  try {
    return await fetchLiveCryptoConfig({ excludeKeys });
  } catch (error) {
    if (allowLastVerifiedFallback) {
      const verified = getLastVerifiedCompleteConfig();
      if (verified && !excludeKeys.has(verified.candidateKey)) {
        return { ...verified, source: 'last-verified' };
      }
    }
    throw error;
  }
}

function formatCryptoFailure({ code, epoch, buildId, message }) {
  const parts = [
    message || 'AllManga chapter crypto failed',
    code ? `code=${code}` : null,
    epoch != null ? `epoch=${epoch}` : null,
    buildId != null ? `buildId=${buildId}` : null,
  ].filter(Boolean);
  return parts.join(' ');
}

module.exports = {
  MKISSA_ORIGIN,
  STREAM_QUERY_HASH,
  KNOWN_NON_MASK_HEX,
  CRYPTO_MATERIAL_TTL_MS,
  AA_CRYPTO_REGEX,
  APP_ENTRY_REGEX,
  CHUNK_REF_REGEX,
  CHAPTER_PAGES_QUERY,
  deriveKey,
  buildAaRequest,
  buildAaRequestFromHash,
  decryptAaResponse,
  candidateKey,
  parseBootstrapJson,
  buildAtomicConfig,
  extractClientCryptoCandidates,
  extractClientCrypto,
  collectBundleCandidates,
  fetchLiveCryptoConfig,
  validateCryptoConfig,
  resolveCompleteCryptoConfig,
  getCachedCompleteConfig,
  getLastVerifiedCompleteConfig,
  rememberCompleteConfig,
  discardCompleteConfig,
  markConfigVerified,
  formatCryptoFailure,
  setFetchTextForTests,
  resetMkissaCryptoForTests,
};
