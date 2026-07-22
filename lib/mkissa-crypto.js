'use strict';

const MKISSA_ORIGIN = 'https://mkissa.to';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:150.0) Gecko/20100101 Firefox/150.0';
const MAX_MASK_CHUNKS = 40;
const STREAM_QUERY_HASH = 'd405d0edd690624b66baba3068e0edc3ac90f1597d898a1ec8db4e5c43c00fec';
// Last-known mkissa client mask/buildId; live scrape overrides these when available.
const FALLBACK_CLIENT_MASK = '70bb5e6260e19a806b3609dc0b6eb718899b09edbd0c23703a5de00e544de128';
const FALLBACK_BUILD_ID = '64';
const AA_CRYPTO_REGEX = /window\.__aaCrypto\s*=\s*(\{[^{}]*\})/;
const APP_ENTRY_REGEX = /import\("([^"]*\/entry\/app\.[^"]*\.js)"\)/;
const CHUNK_REF_REGEX = /\.\.\/chunks\/([A-Za-z0-9_.-]+\.js)/g;
const HEX64_REGEX = /(?<![0-9a-fA-F])[0-9a-fA-F]{64}(?![0-9a-fA-F])/g;
// Older bundle: "mask",kr=fn(n)!=="string"?"63":""
const LEGACY_CLIENT_CRYPTO_REGEX = /["']([0-9a-fA-F]{64})["']\s*,\s*[A-Za-z_$][\w$]*=\w+\(\d+\)!==["']string["']\?["'](\d+)["']:["']["']/;
// Current bundle: Ba=fn(n)!=="string"?"mask":"",ln="64"
const MASK_TERNARY_WITH_BUILD_REGEX = /!==["']string["']\?["']([0-9a-fA-F]{64})["']:["']["']\s*,\s*[A-Za-z_$][\w$]*=["'](\d+)["']/;
const MASK_TERNARY_REGEX = /!==["']string["']\?["']([0-9a-fA-F]{64})["']:["']["']/;

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      'user-agent': USER_AGENT,
      referer: `${MKISSA_ORIGIN}/`,
      origin: MKISSA_ORIGIN,
    },
  });
  if (!response.ok) throw new Error(`mkissa crypto fetch failed (${response.status}) for ${url}`);
  return response.text();
}

function deriveKey(mask, partB) {
  const maskBytes = Buffer.isBuffer(mask) ? mask : Buffer.from(mask, 'hex');
  const partBytes = Buffer.isBuffer(partB) ? partB : Buffer.from(partB, 'base64');
  const key = Buffer.alloc(32);
  for (let i = 0; i < 32; i += 1) key[i] = partBytes[i] ^ maskBytes[i % maskBytes.length];
  return key;
}

function extractClientCrypto(source, { skipMaskHex = '' } = {}) {
  if (!source.includes('aaReq')) return null;
  const skip = skipMaskHex.toLowerCase();

  const withBuild = source.match(MASK_TERNARY_WITH_BUILD_REGEX) || source.match(LEGACY_CLIENT_CRYPTO_REGEX);
  if (withBuild) {
    const maskHex = withBuild[1].toLowerCase();
    if (maskHex !== STREAM_QUERY_HASH && maskHex !== skip) {
      return { maskHex, buildId: withBuild[2] };
    }
  }

  const ternaryMask = source.match(MASK_TERNARY_REGEX)?.[1]?.toLowerCase();
  const maskHex = (ternaryMask && ternaryMask !== STREAM_QUERY_HASH && ternaryMask !== skip)
    ? ternaryMask
    : [...source.matchAll(HEX64_REGEX)]
      .map((match) => match[0].toLowerCase())
      .find((hex) => hex !== STREAM_QUERY_HASH && hex !== skip);

  if (!maskHex) return null;

  const afterMask = source.slice(source.toLowerCase().indexOf(maskHex) + maskHex.length);
  const buildId = afterMask.match(/^\s*["']?\s*,\s*[A-Za-z_$][\w$]*=["'](\d+)["']/)?.[1]
    || source.match(/!==["']string["']\?["'](\d+)["']:["']["']/)?.[1]
    || FALLBACK_BUILD_ID;

  return { maskHex, buildId };
}

async function resolveClientCrypto(appEntryUrl) {
  if (!appEntryUrl) return { maskHex: FALLBACK_CLIENT_MASK, buildId: FALLBACK_BUILD_ID };

  const appJs = await fetchText(appEntryUrl);
  const chunkBase = `${appEntryUrl.replace(/\/entry\/[^/]+$/, '')}/chunks/`;
  const chunkNames = [...appJs.matchAll(CHUNK_REF_REGEX)].map((match) => match[1]);

  for (const name of chunkNames.slice(0, MAX_MASK_CHUNKS)) {
    const body = await fetchText(chunkBase + name).catch(() => '');
    const extracted = extractClientCrypto(body);
    if (extracted) return extracted;
  }
  return { maskHex: FALLBACK_CLIENT_MASK, buildId: FALLBACK_BUILD_ID };
}

async function fetchLiveCryptoConfig() {
  const html = await fetchText(`${MKISSA_ORIGIN}/`);
  const bootstrapJson = html.match(AA_CRYPTO_REGEX)?.[1];
  if (!bootstrapJson) throw new Error('Unable to obtain mkissa crypto bootstrap');
  const bootstrap = JSON.parse(bootstrapJson);
  if (!bootstrap?.partB || !Number.isFinite(Number(bootstrap.epoch))) {
    throw new Error('mkissa crypto bootstrap is incomplete');
  }

  const appEntryUrl = html.match(APP_ENTRY_REGEX)?.[1] || null;
  const client = await resolveClientCrypto(appEntryUrl);
  return {
    key: deriveKey(client.maskHex, bootstrap.partB).toString('hex'),
    epoch: String(bootstrap.epoch),
    buildId: String(client.buildId),
    origin: MKISSA_ORIGIN,
    maskHex: client.maskHex,
  };
}

module.exports = {
  MKISSA_ORIGIN,
  STREAM_QUERY_HASH,
  FALLBACK_CLIENT_MASK,
  FALLBACK_BUILD_ID,
  AA_CRYPTO_REGEX,
  APP_ENTRY_REGEX,
  CHUNK_REF_REGEX,
  deriveKey,
  extractClientCrypto,
  resolveClientCrypto,
  fetchLiveCryptoConfig,
  fetchText,
};
