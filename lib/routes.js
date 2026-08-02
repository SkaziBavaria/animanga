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
      const status = Number(err.status || err.statusCode) || 500;
      if (status >= 500) console.error(err);
      // Never send stack traces to clients; only intentional HttpError.details.
      sendError(res, status, err.message || 'Internal server error', err.details);
    } else {
      res.destroy();
    }
  }
}

module.exports = { handleApi, cachedEpisodeDetails };
