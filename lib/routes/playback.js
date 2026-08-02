'use strict';

const { sendJson, sendError, readBody } = require('../http');
const { readState, saveState } = require('../state');
const { normalizeMode, normalizeEpisode } = require('../episodes');
const { getShowDetails } = require('../anidb');
const { resolveEpisodePlayback } = require('../anime-resolver');
const { resolvePlaybackMode } = require('../playback-mode');
const { proxyStream } = require('../proxy');
const { buildProxyPath, PROXY_TTL_MEDIA_SECONDS } = require('../proxy-sign');
const { ANIDB_REFERER } = require('../config');
const { touchShow } = require('./shared');

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

    const { useBrowserPlayback } = resolvePlaybackMode(body);
    if (!useBrowserPlayback) {
      return sendError(res, 422, 'Native external players are not supported; use browser playback');
    }

    if (!body.id || !body.episode) {
      return sendError(res, 422, 'Missing show id or episode');
    }

    // Browser play sends resolveOnly; do not block the stream on a slow details fetch.
    if (!body.resolveOnly) {
      details = await getShowDetails(body.id, mode);
      if (!details.episodes.includes(normalizeEpisode(body.episode))) {
        return sendError(res, 422, `Episode ${body.episode} is not available yet`, {
          latestEpisode: details.latestEpisode,
          episodeCount: details.episodeCount,
        });
      }
      if (touchShow(state, body.id, details)) saveState(state);
    } else {
      getShowDetails(body.id, mode)
        .then((value) => {
          const live = readState();
          if (touchShow(live, body.id, value)) saveState(live);
        })
        .catch((error) => {
          console.warn(`[play] background show details unavailable for ${body.id}:`, error.message || error);
        });
    }

    try {
      const playback = await resolveEpisodePlayback({
        showId: body.id,
        episode: body.episode,
        mode,
        quality: body.quality || state.settings.quality || 'best',
      });
      const job = {
        status: 'done',
        label: `Resolve ${details?.name || body.title || body.name || body.id} ep ${body.episode}`,
        output: `Playback URL resolved by AniManga (${playback.provider || 'anidb'})`,
        resolver: 'node',
      };
      return sendJson(res, 200, {
        job,
        playback: {
          ...playback,
          proxyUrl: buildProxyPath(
            playback.url,
            playback.referrer || ANIDB_REFERER,
            { ttlSeconds: PROXY_TTL_MEDIA_SECONDS },
          ),
        },
      });
    } catch (error) {
      return sendError(res, 422, 'AniManga could not fetch a playable link', error.message || 'No playable source');
    }
  }

  return sendError(res, 404, 'Playback endpoint missing');
}

module.exports = { handlePlaybackRoutes };
