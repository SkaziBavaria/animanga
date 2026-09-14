'use strict';

const { fetchWebText } = require('./web-fetch');

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

async function fetchMegaplayCaptionConfig(embedUrl, { fetchText = fetchWebText } = {}) {
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
  const subtitles = mapMegaplayCaptionTracks(parsed?.tracks);
  if (!subtitles.length) return null;
  return {
    subtitles,
    baseUrl: origin,
    referrer: `${origin}/`,
  };
}

module.exports = {
  parseMegaplayPlayerId,
  mapMegaplayCaptionTracks,
  fetchMegaplayCaptionConfig,
};
