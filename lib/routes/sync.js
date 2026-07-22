'use strict';

const { HOST, PORT } = require('../config');
const { sendJson, readBody } = require('../http');
const {
  publicConfig,
  configure,
  disconnect,
  authorizationUrl,
  finishAuthorization,
  syncNow,
  setProvider,
  configureGithub,
  disconnectGithub,
  startGithubAuthorization,
  pollGithubAuthorization,
} = require('../sync');

function requestOrigin(req) {
  const protocol = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() || 'http';
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || `${HOST}:${PORT}`).split(',')[0].trim();
  return `${protocol}://${host}`;
}

function callbackUrl(req) {
  return `${requestOrigin(req)}/api/sync/google/callback`;
}

async function handleSyncRoutes(req, res, url) {
  const publicCallbackUrl = callbackUrl(req);

  if (req.method === 'GET' && url.pathname === '/api/sync') {
    return sendJson(res, 200, publicConfig(publicCallbackUrl));
  }

  if (req.method === 'POST' && url.pathname === '/api/sync/config') {
    configure(await readBody(req));
    return sendJson(res, 200, publicConfig(publicCallbackUrl));
  }

  if (req.method === 'POST' && url.pathname === '/api/sync/provider') {
    const body = await readBody(req);
    setProvider(body.provider);
    return sendJson(res, 200, publicConfig(publicCallbackUrl));
  }

  if (req.method === 'POST' && url.pathname === '/api/sync/github/config') {
    configureGithub(await readBody(req));
    return sendJson(res, 200, publicConfig(publicCallbackUrl));
  }

  if (req.method === 'POST' && url.pathname === '/api/sync/github/connect') {
    return sendJson(res, 200, { deviceAuth: await startGithubAuthorization() });
  }

  if (req.method === 'GET' && url.pathname === '/api/sync/github/poll') {
    return sendJson(res, 200, {
      deviceAuth: await pollGithubAuthorization(),
      config: publicConfig(publicCallbackUrl),
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/sync/github/disconnect') {
    disconnectGithub();
    return sendJson(res, 200, publicConfig(publicCallbackUrl));
  }

  if (req.method === 'POST' && url.pathname === '/api/sync/disconnect') {
    disconnect();
    return sendJson(res, 200, publicConfig(publicCallbackUrl));
  }

  if (req.method === 'GET' && url.pathname === '/api/sync/google/connect') {
    return sendJson(res, 200, { url: authorizationUrl(publicCallbackUrl) });
  }

  if (req.method === 'GET' && url.pathname === '/api/sync/google/callback') {
    if (url.searchParams.get('error')) {
      throw new Error(`Google authorization: ${url.searchParams.get('error')}`);
    }
    await finishAuthorization({
      code: url.searchParams.get('code'),
      state: url.searchParams.get('state'),
      callbackUrl: publicCallbackUrl,
    });
    res.writeHead(302, { location: '/?sync=connected', 'cache-control': 'no-store' });
    res.end();
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/sync/run') {
    return sendJson(res, 200, await syncNow());
  }
}

module.exports = { handleSyncRoutes, requestOrigin, callbackUrl };
