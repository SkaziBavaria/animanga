'use strict';

const { fetchWebText } = require('./web-fetch');
const { createDecipheriv } = require('node:crypto');

function decodeMegaplaySource(config) {
  let source = config?.sources;
  if (config?.enc) {
    try {
      // MegaPlay's e1 player uses a public, zero-padded AES key for its source envelope.
      const key = Buffer.alloc(32);
      key.write('i?LMTAx0Q6,:}50U');
      const decipher = createDecipheriv('aes-256-cbc', key, Buffer.from("W0;27ToaUpl_P%'c"));
      source = JSON.parse(Buffer.concat([
        decipher.update(Buffer.from(config.enc, 'base64url')), decipher.final(),
      ]).toString('utf8'));
    } catch {
      throw new Error('Vidstream-2 returned invalid source configuration');
    }
  }
  let url;
  try { url = new URL(source?.file); } catch { /* Validated below. */ }
  if (!url || !['https:', 'http:'].includes(url.protocol) || url.username || url.password
    || !url.pathname.endsWith('.m3u8')) {
    throw new Error('Vidstream-2 returned an invalid playlist URL');
  }
  return url.href;
}

function parseMegaplayPlayerId(html) {
  const player = String(html || '').match(/<[^>]+id=["']megaplay-player["'][^>]*>/i)?.[0]
    || String(html || '').match(/<[^>]+data-id=["'][^"']+["'][^>]*id=["']megaplay-player["'][^>]*>/i)?.[0]
    || '';
  const id = player.match(/data-id=["']([^"']+)["']/i)?.[1] || '';
  return /^[A-Za-z0-9_-]{1,32}$/.test(id) ? id : '';
}

function mapMegaplayCaptionTracks(tracks) {
  return (Array.isArray(tracks) ? tracks : [])
    .filter((item) => item && !/thumb/i.test(String(item.kind || item.type || item.label || '')))
    .map((item) => ({
      src: item.file || item.src || item.url,
      lang: item.lang || item.language,
      label: item.label,
      default: Boolean(item.default),
    }))
    .filter((item) => item.src);
}

async function fetchMegaplayConfig(embedUrl, { fetchText = fetchWebText } = {}) {
  if (!/^https?:\/\//i.test(embedUrl)) return null;
  let origin;
  try { origin = new URL(embedUrl).origin; } catch { return null; }
  const html = await fetchText(embedUrl, {
    timeoutMs: 15_000,
    headers: { Referer: `${origin}/` },
  });
  const id = parseMegaplayPlayerId(html);
  if (!id) return null;
  const raw = await fetchText(`${origin}/stream/getSources?id=${encodeURIComponent(id)}`, {
    timeoutMs: 15_000,
    headers: {
      Referer: embedUrl,
      'X-Requested-With': 'XMLHttpRequest',
    },
  });
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (!parsed || typeof parsed !== 'object' || parsed.error) return null;
  return {
    ...parsed,
    subtitles: mapMegaplayCaptionTracks(parsed.tracks),
    baseUrl: origin,
    referrer: `${origin}/`,
  };
}

async function fetchMegaplayCaptionConfig(embedUrl, options) {
  const parsed = await fetchMegaplayConfig(embedUrl, options);
  const subtitles = mapMegaplayCaptionTracks(parsed?.tracks);
  if (!subtitles.length) return null;
  return {
    subtitles,
    baseUrl: parsed.baseUrl,
    referrer: parsed.referrer,
  };
}

module.exports = {
  parseMegaplayPlayerId,
  mapMegaplayCaptionTracks,
  fetchMegaplayCaptionConfig,
  fetchMegaplayConfig,
  decodeMegaplaySource,
};
