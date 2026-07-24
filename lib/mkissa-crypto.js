'use strict';

const crypto = require('crypto');
const { fetchWithTimeout } = require('./upstream');

const MKISSA_ORIGIN = 'https://mkissa.to';
const MKISSA_API_ORIGIN = 'https://api.mkissa.net';
const ALLMANGA_API = 'https://api.allanime.day/api';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:150.0) Gecko/20100101 Firefox/150.0';
const MAX_MASK_CHUNKS = 40;
const CRYPTO_MATERIAL_TTL_MS = 6 * 60 * 60 * 1000;
const BOOTSTRAP_EPOCH_MS = 259_200_000;
const BOOTSTRAP_GRACE_MS = 86_400_000;
const STREAM_QUERY_HASH = 'd405d0edd690624b66baba3068e0edc3ac90f1597d898a1ec8db4e5c43c00fec';
const CRYPTO_LANE_ANIME = 'k7';
const CRYPTO_LANE_MANGA = 'k9';
const CRYPTO_LANE_MUSIC = 'k2';
const KNOWN_NON_MASK_HEX = new Set([
  STREAM_QUERY_HASH,
  '49a2b4f2aed8c739a9ad13bdd02654d23aa79e416e24e0c1dfb5484746b648f8',
  '3bf06f51474dc99d2696a44c95867f441b50934cabaee30153319e3c7ffffb0f',
  '1f9445f5677aefe9073038d870a533e17475926fb3abd7e911f19ea5127ebe17',
]);
const APP_ENTRY_REGEX = /import\("([^"]*\/entry\/app\.[^"]*\.js)"\)/;
const CHUNK_REF_REGEX = /\.\.\/chunks\/([A-Za-z0-9_.-]+\.js)/g;
const LEGACY_CLIENT_CRYPTO_REGEX = /["']([0-9a-fA-F]{64})["']\s*,\s*[A-Za-z_$][\w$]*=\w+\(\d+\)!==["']string["']\?["'](\d+)["']:["']["']/g;
const MASK_TERNARY_WITH_BUILD_REGEX = /!==["']string["']\?["']([0-9a-fA-F]{64})["']:["']["']\s*,\s*[A-Za-z_$][\w$]*=["'](\d+)["']/g;
const PAIRED_TERNARY_CRYPTO_REGEX = /!==["']string["']\?["']([0-9a-fA-F]{64})["']:["']["']\s*,\s*[A-Za-z_$][\w$]*=\w+\(\d+\)!==["']string["']\?["'](\d+)["']:["']["']/g;
const VALIDATION_SEARCH_QUERY = 'query($search:SearchInput $limit:Int $page:Int $translationType:VaildTranslationTypeMangaEnumType $countryOrigin:VaildCountryOriginEnumType){mangas(search:$search limit:$limit page:$page translationType:$translationType countryOrigin:$countryOrigin){edges{_id name englishName}}}';
const CHAPTER_PAGES_QUERY = 'query($mangaId:String!,$translationType:VaildTranslationTypeMangaEnumType!,$chapterString:String!,$page:Int,$limit:Int!,$offset:Int){chapterPages(mangaId:$mangaId translationType:$translationType chapterString:$chapterString page:$page limit:$limit offset:$offset){edges{streamerId sourceName chapterString pictureUrls pictureUrlsProcessed pictureUrlHead notes uploadDate sourceUrl priority versionFix} pageInfo{total} manga{_id name thumbnail availableChaptersDetail availableChapters}}}';

let fetchImpl = defaultFetchText;
const cachedCompleteByLane = new Map();
const lastVerifiedByLane = new Map();
const inflightLive = new Map();

async function defaultFetchText(url, options = {}) {
  const response = await fetchWithTimeout(fetch, url, {
    headers: {
      'user-agent': USER_AGENT,
      referer: `${MKISSA_ORIGIN}/`,
      origin: MKISSA_ORIGIN,
      ...(options.headers || {}),
    },
  });
  if (!response.ok) throw new Error(`mkissa crypto fetch failed (${response.status}) for ${url}`);
  return response.text();
}

function setFetchTextForTests(fetcher) {
  fetchImpl = fetcher || defaultFetchText;
}

function resetMkissaCryptoForTests() {
  cachedCompleteByLane.clear();
  lastVerifiedByLane.clear();
  inflightLive.clear();
  fetchImpl = defaultFetchText;
}

function candidateKey(maskHex, buildId, lane = '') {
  const base = `${String(maskHex).toLowerCase()}|${String(buildId)}`;
  return lane ? `${base}|${lane}` : base;
}

function isExcludedHex(hex) {
  return KNOWN_NON_MASK_HEX.has(String(hex).toLowerCase());
}

function isExcludedCandidate(excludeKeys, maskHex, buildId) {
  const base = candidateKey(maskHex, buildId);
  for (const excluded of excludeKeys) {
    const value = String(excluded);
    if (value === base || value.startsWith(`${base}|`)) return true;
  }
  return false;
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

function bootstrapEpochBucket(now = Date.now(), epochMs = BOOTSTRAP_EPOCH_MS, graceMs = BOOTSTRAP_GRACE_MS) {
  const current = Math.floor(now / epochMs);
  return now - current * epochMs < graceMs && current > 0 ? current - 1 : current;
}

function seedFromBuildId(buildId) {
  const value = String(buildId || '');
  const seed = Buffer.alloc(32);
  for (let index = 0; index < 32; index += 1) {
    seed[index] = (value.charCodeAt(index % value.length) || 0) ^ (((index * 17) + 31) & 255);
  }
  return seed;
}

function deriveMaskFromJu(chunks, buildId) {
  if (!Array.isArray(chunks) || chunks.length !== 4) throw new Error('mkissa Ju mask chunks are incomplete');
  const seed = seedFromBuildId(buildId);
  const mask = Buffer.alloc(32);
  for (let part = 0; part < 4; part += 1) {
    const bytes = Buffer.from(String(chunks[part]), 'base64');
    if (bytes.length !== 8) throw new Error('mkissa Ju mask chunk must decode to 8 bytes');
    const offset = part * 8;
    for (let index = 0; index < 8; index += 1) {
      mask[offset + index] = (bytes[index] ^ seed[offset + index]) ^ ((part * 41 + index * 7) & 255);
    }
  }
  return mask;
}

function buildBootstrapHeader(mask, buildId, epochBucket, lane, {
  keyGroup = 'mkissa',
  refererHost = 'mkissa.to',
} = {}) {
  const maskBytes = Buffer.isBuffer(mask) ? mask : Buffer.from(mask, 'hex');
  const inner = crypto.createHmac('sha256', maskBytes).update(`aa-boot:${buildId}`).digest();
  const material = `${buildId}:${keyGroup}:${refererHost}:${epochBucket}:${lane}`;
  return crypto.createHmac('sha256', inner).update(material).digest('hex');
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
    lane: bootstrap.k || null,
    epochMs: Number(bootstrap.epochMs) || BOOTSTRAP_EPOCH_MS,
    graceMs: Number(bootstrap.graceMs) || BOOTSTRAP_GRACE_MS,
  };
}

function laneForQuery(query, fallback = CRYPTO_LANE_MANGA) {
  const text = String(query || '');
  if (/\bchapterPages\s*\(/i.test(text)) return CRYPTO_LANE_MANGA;
  if (/\bmusic\s*\(/i.test(text)) return CRYPTO_LANE_MUSIC;
  if (/\bepisode\s*\(/i.test(text)) return CRYPTO_LANE_ANIME;
  return fallback;
}

function buildAaRequestFromHash(qh, config, now = Date.now()) {
  if (!/^[0-9a-f]{64}$/i.test(String(qh))) throw new Error('aaReq query hash must be 32-byte hex');
  const lane = String(config.lane || CRYPTO_LANE_MANGA);
  const ts = Math.floor(now / 300_000) * 300_000;
  const iv = crypto.createHash('sha256')
    .update(`${config.epoch}:${config.buildId}:${qh}:${ts}:${lane}`)
    .digest()
    .subarray(0, 12);
  const payload = JSON.stringify({
    v: 1,
    ts,
    epoch: Number(config.epoch),
    buildId: String(config.buildId),
    qh,
    k: lane,
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
  const withLane = config.lane ? config : { ...config, lane: laneForQuery(query) };
  return buildAaRequestFromHash(qh, withLane, now);
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

function buildAtomicConfig({
  epoch,
  partB,
  maskHex,
  buildId,
  lane = CRYPTO_LANE_MANGA,
  appEntryUrl,
  source,
}) {
  const normalizedMask = String(maskHex).toLowerCase();
  const normalizedBuildId = String(buildId);
  const normalizedLane = String(lane || CRYPTO_LANE_MANGA);
  if (!/^[0-9a-f]{64}$/.test(normalizedMask) || isExcludedHex(normalizedMask)) {
    throw new Error('mkissa client mask is not usable');
  }
  if (!/^\d+$/.test(normalizedBuildId)) throw new Error('mkissa buildId is not usable');
  return {
    key: deriveKey(normalizedMask, partB).toString('hex'),
    epoch: String(epoch),
    buildId: normalizedBuildId,
    maskHex: normalizedMask,
    lane: normalizedLane,
    origin: MKISSA_ORIGIN,
    appEntryUrl: appEntryUrl || null,
    source: source || 'mkissa',
    candidateKey: candidateKey(normalizedMask, normalizedBuildId, normalizedLane),
    fetchedAt: Date.now(),
    expiresAt: Date.now() + CRYPTO_MATERIAL_TTL_MS,
  };
}

function extractArrayLiteral(source, marker) {
  const at = source.indexOf(marker);
  if (at < 0) return null;
  const start = at + marker.length - 1;
  let depth = 0;
  for (let index = start; index < source.length; index += 1) {
    if (source[index] === '[') depth += 1;
    else if (source[index] === ']') {
      depth -= 1;
      if (!depth) return source.slice(start, index + 1);
    }
  }
  return null;
}

function extractCaOffset(source) {
  const match = source.match(/function Ca\([^)]*\)\{return e=e-\(([^)]+)\),ll\(\)\[e\]\}/)
    || source.match(/function Ca\([^)]*\)\{return e=e-([^,]+),ll\(\)\[e\]\}/);
  if (!match) throw new Error('mkissa Ca offset is missing');
  return Function(`"use strict"; return (${match[1]});`)();
}

function rotateLlTable(source, table) {
  const callAt = source.indexOf('})(ll,');
  if (callAt < 0) throw new Error('mkissa ll shuffle is missing');
  const fnAt = source.lastIndexOf('(function(e,t){function r(i,s){return Ca(s-', callAt);
  if (fnAt < 0) throw new Error('mkissa ll shuffle is missing');
  const head = source.slice(fnAt, callAt);
  const offs = head.match(/Ca\(s-(\d+)\)\}const n=e\(\);function a\(i,s\)\{return Ca\(s-(\d+)\)\}/);
  if (!offs) throw new Error('mkissa ll shuffle offsets are missing');
  const ifAt = head.indexOf('try{if(');
  const eqAt = head.lastIndexOf('===t)break;');
  if (ifAt < 0 || eqAt < 0) throw new Error('mkissa ll shuffle expression is missing');
  const expr = head.slice(ifAt + 'try{if('.length, eqAt);
  const targetStart = callAt + '})(ll,'.length;
  const targetEnd = source.indexOf(')', targetStart);
  if (targetEnd < 0) throw new Error('mkissa ll shuffle target is missing');
  const targetExpr = source.slice(targetStart, targetEnd);
  const caOffset = extractCaOffset(source);
  const target = Function(`"use strict"; return (${targetExpr});`)();
  const rOff = Number(offs[1]);
  const aOff = Number(offs[2]);
  function Ca(index) {
    return table[index - caOffset];
  }
  for (;;) {
    try {
      const r = (_i, s) => Ca(s - rOff);
      const a = (_i, s) => Ca(s - aOff);
      const value = Function('r', 'a', `"use strict"; return (${expr});`)(r, a);
      if (value === target) break;
      table.push(table.shift());
    } catch {
      table.push(table.shift());
    }
  }
  return table;
}

function extractJuCandidate(source) {
  if (!source || !source.includes('aaReq') || !source.includes('Ju=[')) return null;
  const arrayLiteral = extractArrayLiteral(source, 'function ll(){const e=[');
  if (!arrayLiteral) return null;
  const table = Function(`"use strict"; return (${arrayLiteral});`)().slice();
  rotateLlTable(source, table);

  const caOffset = extractCaOffset(source);
  const rrMatch = source.match(/function Rr\([^)]*\)\{return Ca\(e-(-?\d+)\)\}/);
  const jrMatch = source.match(/function jr\([^)]*\)\{return Ca\(t-(-?\d+)\)\}/);
  if (!rrMatch || !jrMatch) return null;
  const rrOff = Number(rrMatch[1]);
  const jrOff = Number(jrMatch[1]);
  function Ca(index) {
    return table[index - caOffset];
  }
  function Rr(value) {
    return Ca(value - rrOff);
  }
  function jr(_a, b) {
    return Ca(b - jrOff);
  }

  const juMatch = source.match(/Ju=\[([^\]]+)\]/);
  if (!juMatch) return null;
  const chunks = Function('Rr', 'jr', `"use strict"; return [${juMatch[1]}];`)(Rr, jr);
  if (!Array.isArray(chunks) || chunks.length !== 4) return null;
  for (const chunk of chunks) {
    if (Buffer.from(String(chunk), 'base64').length !== 8) return null;
  }

  const buildMatch = source.match(/!=="string"\?"(\d{1,4})":""\s*,\s*[A-Za-z_$][\w$]*=\[/);
  const buildId = buildMatch?.[1]
    || [...source.matchAll(/!=="string"\?"(\d{1,4})":""/g)].map((item) => item[1])[0];
  if (!buildId) return null;

  const maskHex = deriveMaskFromJu(chunks, buildId).toString('hex');
  return {
    maskHex,
    buildId: String(buildId),
    format: 'ju-base64',
    juChunks: chunks.map(String),
  };
}

function extractClientCryptoCandidates(source, { excludeKeys = new Set() } = {}) {
  if (!source || !source.includes('aaReq')) return [];
  const found = [];
  const seen = new Set();

  const push = (maskHex, buildId, format, extra = {}) => {
    const normalizedMask = String(maskHex).toLowerCase();
    const normalizedBuildId = String(buildId);
    if (isExcludedHex(normalizedMask) || !/^\d+$/.test(normalizedBuildId)) return;
    const key = candidateKey(normalizedMask, normalizedBuildId);
    if (seen.has(key) || isExcludedCandidate(excludeKeys, normalizedMask, normalizedBuildId)) return;
    seen.add(key);
    found.push({ maskHex: normalizedMask, buildId: normalizedBuildId, format, ...extra });
  };

  try {
    const ju = extractJuCandidate(source);
    if (ju) push(ju.maskHex, ju.buildId, ju.format, { juChunks: ju.juChunks });
  } catch {
    // Fall through to legacy hex extractors.
  }

  for (const match of source.matchAll(PAIRED_TERNARY_CRYPTO_REGEX)) {
    push(match[1], match[2], 'paired-ternary');
  }
  for (const match of source.matchAll(LEGACY_CLIENT_CRYPTO_REGEX)) {
    push(match[1], match[2], 'legacy');
  }
  for (const match of source.matchAll(MASK_TERNARY_WITH_BUILD_REGEX)) {
    push(match[1], match[2], 'ternary');
  }

  return found;
}

function extractClientCrypto(source, { skipMaskHex = '', excludeKeys = new Set() } = {}) {
  const candidates = extractClientCryptoCandidates(source, { excludeKeys });
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
      const key = candidateKey(candidate.maskHex, candidate.buildId);
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push(candidate);
    }
  }

  if (!candidates.length) {
    throw new Error('mkissa crypto chunk has no high-confidence mask/buildId pair');
  }
  return candidates;
}

function getCachedCompleteConfig(lane = CRYPTO_LANE_MANGA) {
  const cached = cachedCompleteByLane.get(String(lane));
  if (cached && Date.now() < cached.expiresAt) return { ...cached };
  return null;
}

function getLastVerifiedCompleteConfig(lane = CRYPTO_LANE_MANGA) {
  const verified = lastVerifiedByLane.get(String(lane));
  return verified ? { ...verified } : null;
}

function rememberCompleteConfig(config, { verified = false } = {}) {
  const lane = String(config.lane || CRYPTO_LANE_MANGA);
  const stored = { ...config, expiresAt: Date.now() + CRYPTO_MATERIAL_TTL_MS };
  cachedCompleteByLane.set(lane, stored);
  if (verified) lastVerifiedByLane.set(lane, { ...stored });
}

function discardCompleteConfig(config) {
  if (!config) return;
  const lane = String(config.lane || CRYPTO_LANE_MANGA);
  const cached = cachedCompleteByLane.get(lane);
  if (cached && cached.candidateKey === config.candidateKey) cachedCompleteByLane.delete(lane);
}

function markConfigVerified(config) {
  rememberCompleteConfig(config, { verified: true });
}

async function fetchSignedBootstrap({ buildId, lane, maskHex }) {
  const epochBucket = bootstrapEpochBucket();
  const header = buildBootstrapHeader(maskHex, buildId, epochBucket, lane);
  const url = `${MKISSA_API_ORIGIN}/client-crypto/v1/bootstrap?buildId=${encodeURIComponent(buildId)}&k=${encodeURIComponent(lane)}`;
  const text = await fetchImpl(url, {
    headers: {
      accept: 'application/json',
      'x-build-id': String(buildId),
      'x-aa-boot': header,
    },
  });
  return parseBootstrapJson(text);
}

async function fetchLiveCryptoConfig({
  excludeKeys = new Set(),
  lane = CRYPTO_LANE_MANGA,
} = {}) {
  const normalizedLane = String(lane || CRYPTO_LANE_MANGA);
  const inflightKey = `${normalizedLane}|${[...excludeKeys].sort().join(',')}`;
  if (inflightLive.has(inflightKey)) return inflightLive.get(inflightKey);

  const request = (async () => {
    const html = await fetchImpl(`${MKISSA_ORIGIN}/`);
    const appEntryUrl = html.match(APP_ENTRY_REGEX)?.[1];
    if (!appEntryUrl) throw new Error('mkissa app entry is missing; refusing incomplete crypto material');

    const candidates = await collectBundleCandidates(appEntryUrl, { excludeKeys });
    const chosen = candidates[0];
    const bootstrap = await fetchSignedBootstrap({
      buildId: chosen.buildId,
      lane: normalizedLane,
      maskHex: chosen.maskHex,
    });
    const config = buildAtomicConfig({
      epoch: bootstrap.epoch,
      partB: bootstrap.partB,
      maskHex: chosen.maskHex,
      buildId: chosen.buildId,
      lane: normalizedLane,
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
  const extensions = config
    ? { aaReq: buildAaRequest(query, config), k: config.lane || laneForQuery(query) }
    : undefined;
  if (config) headers['x-build-id'] = config.buildId;
  const response = await fetchWithTimeout(fetcher, ALLMANGA_API, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query, variables, ...(extensions ? { extensions } : {}) }),
  });
  if (!response.ok) throw new Error(`AllManga crypto validation returned HTTP ${response.status}`);
  return response.json();
}

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

  const gated = config.lane ? config : { ...config, lane: CRYPTO_LANE_MANGA };
  const result = await postGraphql(fetcher, CHAPTER_PAGES_QUERY, {
    mangaId: manga._id,
    translationType: 'sub',
    chapterString: '1',
    page: 1,
    limit: 20,
    offset: 0,
  }, gated);
  if (result.errors?.length) {
    const first = result.errors[0];
    throw new Error(formatCryptoFailure({
      message: result.errors.map((item) => item.message).join('; '),
      code: first?.extensions?.code,
      epoch: gated.epoch,
      buildId: gated.buildId,
    }));
  }

  let data;
  try {
    data = result.data?.tobeparsed ? decryptAaResponse(result.data.tobeparsed, gated) : result.data;
  } catch (error) {
    throw new Error(formatCryptoFailure({
      message: `AllManga crypto validation could not decrypt the response: ${error.message}`,
      epoch: gated.epoch,
      buildId: gated.buildId,
    }), { cause: error });
  }
  if (!Array.isArray(data?.chapterPages?.edges)) {
    throw new Error(formatCryptoFailure({
      message: 'AllManga crypto validation returned no chapter page data',
      epoch: gated.epoch,
      buildId: gated.buildId,
    }));
  }
  markConfigVerified(gated);
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

async function resolveCompleteCryptoConfig({
  forceRefresh = false,
  excludeKeys = new Set(),
  allowLastVerifiedFallback = true,
  lane = CRYPTO_LANE_MANGA,
} = {}) {
  const normalizedLane = String(lane || CRYPTO_LANE_MANGA);
  if (!forceRefresh) {
    const cached = getCachedCompleteConfig(normalizedLane);
    if (cached && !excludeKeys.has(cached.candidateKey)) return cached;
  }

  try {
    return await fetchLiveCryptoConfig({ excludeKeys, lane: normalizedLane });
  } catch (error) {
    if (allowLastVerifiedFallback) {
      const verified = getLastVerifiedCompleteConfig(normalizedLane);
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
  MKISSA_API_ORIGIN,
  STREAM_QUERY_HASH,
  KNOWN_NON_MASK_HEX,
  CRYPTO_MATERIAL_TTL_MS,
  CRYPTO_LANE_ANIME,
  CRYPTO_LANE_MANGA,
  CRYPTO_LANE_MUSIC,
  APP_ENTRY_REGEX,
  CHUNK_REF_REGEX,
  CHAPTER_PAGES_QUERY,
  deriveKey,
  deriveMaskFromJu,
  bootstrapEpochBucket,
  buildBootstrapHeader,
  buildAaRequest,
  buildAaRequestFromHash,
  decryptAaResponse,
  candidateKey,
  laneForQuery,
  parseBootstrapJson,
  buildAtomicConfig,
  extractClientCryptoCandidates,
  extractClientCrypto,
  extractJuCandidate,
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
