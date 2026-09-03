'use strict';

const { sendError } = require('./http');
const { assertSameOriginMutation } = require('./csrf');
const { handleAnimeRoutes, cachedEpisodeDetails } = require('./routes/anime');
const { handleDownloadRoutes } = require('./routes/downloads');
const { handleMangaRoutes } = require('./routes/manga');
const { handlePlaybackRoutes } = require('./routes/playback');
const { handleSyncRoutes } = require('./routes/sync');
const { handleSystemRoutes } = require('./routes/system');

function isDownloadPath(pathname) {
  return pathname === '/api/download'
    || pathname === '/api/download-season'
    || pathname === '/api/downloads'
    || pathname.startsWith('/api/downloads/');
}

function publicRouteError(pathname, error) {
  const message = String(error?.message || error || '');
  const curlInternal = /upstream curl failed|curl:\s*\(\d+\)|curl_(?:chrome|firefox)|curl-impersonate/i.test(message);
  if (!curlInternal) return null;
  const status = Number(message.match(/(?:HTTP|error:)\s*(\d{3})/i)?.[1]) || 502;
  const provider = pathname.startsWith('/api/manga') ? 'Manga provider' : 'AniDB';
  return { status, message: `${provider} unavailable${status ? ` (HTTP ${status})` : ''}` };
}

async function handleApi(req, res, url) {
  try {
    assertSameOriginMutation(req);

    if (['/api/status', '/api/settings', '/api/jobs'].includes(url.pathname)) {
      await handleSystemRoutes(req, res, url);
    } else if (url.pathname === '/api/sync' || url.pathname.startsWith('/api/sync/')) {
      await handleSyncRoutes(req, res, url);
    } else if (url.pathname === '/api/manga' || url.pathname.startsWith('/api/manga/')) {
      await handleMangaRoutes(req, res, url);
    } else if (isDownloadPath(url.pathname)) {
      await handleDownloadRoutes(req, res, url);
    } else if (url.pathname === '/api/proxy' || url.pathname === '/api/play') {
      await handlePlaybackRoutes(req, res, url);
      } else {
      await handleAnimeRoutes(req, res, url);
    }

    if (!res.writableEnded) sendError(res, 404, 'API endpoint missing');
  } catch (err) {
    if (!res.headersSent) {
      const publicFailure = publicRouteError(url.pathname, err);
      const status = publicFailure?.status || Number(err.status || err.statusCode) || 500;
      if (status >= 500) console.error(err);
      // Never send stack traces to clients; only intentional HttpError.details.
      sendError(
        res,
        status,
        publicFailure?.message || err.message || 'Internal server error',
        publicFailure ? undefined : err.details,
      );
    } else {
      res.destroy();
    }
  }
}

module.exports = { handleApi, cachedEpisodeDetails, publicRouteError };
