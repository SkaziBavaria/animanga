'use strict';

const { publicProviderFailure } = require('../provider-health');

const { sendJson, sendError, readBody } = require('../http');
const { readState, saveState } = require('../state');
const { normalizeMode, normalizeEpisode } = require('../episodes');
const animeProvider = require('../anime-provider');
const { resolvePlaybackMode } = require('../playback-mode');
const { proxyStream } = require('../proxy');
const { buildProxyPath, PROXY_TTL_MEDIA_SECONDS } = require('../proxy-sign');
const { DEFAULT_MEDIA_REFERER } = require('../config');
const { touchShow } = require('./shared');

function proxyCaptionTrack(track, fallbackReferrer, index) {
  const src = String(track?.src || '').trim();
  if (!/^https?:\/\//i.test(src)) return null;
  const referrer = track.referrer || fallbackReferrer;
  return {
    id: `c${index}`,
    lang: String(track.lang || '').trim().slice(0, 16),
    label: String(track.label || 'Captions').trim().slice(0, 64) || 'Captions',
    default: Boolean(track.default),
    subtitleProxyUrl: buildProxyPath(src, referrer, { ttlSeconds: PROXY_TTL_MEDIA_SECONDS }),
  };
}

function withPlaybackProxies(playback) {
  const referrer = playback.referrer || DEFAULT_MEDIA_REFERER;
  const captionFallbackReferrer = playback.subtitleReferrer || referrer;
  const proxied = {
    ...playback,
    proxyUrl: buildProxyPath(
      playback.url,
      referrer,
      { ttlSeconds: PROXY_TTL_MEDIA_SECONDS },
    ),
  };
  const captionTracks = (Array.isArray(playback.subtitleTracks) ? playback.subtitleTracks : [])
    .map((track, index) => proxyCaptionTrack(track, captionFallbackReferrer, index))
    .filter(Boolean);
  if (captionTracks.length) {
    proxied.subtitleTracks = captionTracks;
    const selected = captionTracks.find((track) => track.default) || captionTracks[0];
    proxied.subtitleProxyUrl = selected.subtitleProxyUrl;
    proxied.subtitleLang = selected.lang;
    proxied.subtitleLabel = selected.label;
    delete proxied.subtitle;
    delete proxied.subtitleReferrer;
    return proxied;
  }
  const subtitle = String(playback.subtitle || '').trim();
  if (/^https?:\/\//i.test(subtitle)) {
    proxied.subtitleProxyUrl = buildProxyPath(
      subtitle,
      captionFallbackReferrer,
      { ttlSeconds: PROXY_TTL_MEDIA_SECONDS },
    );
  }
  return proxied;
}

function publicPlaybackError(error) {
  const failure = publicProviderFailure(error);
  const message = String(error?.message || error || '');
  const status = Number(message.match(/(?:HTTP|error:)\s*(\d{3})/i)?.[1]) || null;
  if (failure?.error) return { status: failure.upstreamStatus || status || 502, message: failure.error };
  if (status) return { status, message: `HiAnime unavailable (HTTP ${status})` };
  return { status: 502, message: 'Playback unavailable' };
}

async function handlePlaybackRoutes(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/proxy') {
    return proxyStream(req, res, url);
  }

  if (req.method === 'POST' && url.pathname === '/api/play') {
    const body = await readBody(req);
    if (body.download) {
      return sendError(res, 422, 'Use the download API for episode downloads');
    }

    const state = readState();
    const mode = normalizeMode(body.mode || state.settings.mode);
    let details = null;
    const identity = animeProvider.providerIdentity(state, body);

    const { useBrowserPlayback } = resolvePlaybackMode(body);
    if (!useBrowserPlayback) {
      return sendError(res, 422, 'Native external players are not supported; use browser playback');
    }

    if (!body.id || !body.episode) {
      return sendError(res, 422, 'Missing show id or episode');
    }

    // Browser play sends resolveOnly; do not block the stream on a slow details fetch.
    if (!body.resolveOnly) {
      details = await animeProvider.details(state, body, mode);
      if (!details.episodes.includes(normalizeEpisode(body.episode))) {
        return sendError(res, 422, `Episode ${body.episode} is not available yet`, {
          latestEpisode: details.latestEpisode,
          episodeCount: details.episodeCount,
        });
      }
      if (touchShow(state, body.id, details)) saveState(state);
    }

    try {
      const playback = await animeProvider.playback(state, body, {
        episode: body.episode,
        mode,
        quality: body.quality || state.settings.quality || 'best',
      });
      const job = {
        status: 'done',
        label: `Resolve ${details?.name || body.title || body.name || body.id} ep ${body.episode}`,
        output: `Playback URL resolved by AniManga (${playback.provider || 'hianime'})`,
        resolver: 'node',
      };
      return sendJson(res, 200, {
        job,
        playback: withPlaybackProxies(playback),
      });
    } catch (error) {
      const upstreamFailure = publicProviderFailure(error);
      if (upstreamFailure) return sendJson(res, upstreamFailure.upstreamStatus || 502, upstreamFailure);
      const failure = publicPlaybackError(error, identity.provider);
      return sendError(res, failure.status, failure.message);
    }
  }

  return sendError(res, 404, 'Playback endpoint missing');
}

module.exports = { handlePlaybackRoutes, publicPlaybackError, withPlaybackProxies };
