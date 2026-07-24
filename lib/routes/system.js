'use strict';

const { HOST, PORT } = require('../config');
const registry = require('../registry');
const { sendJson, readBody } = require('../http');
const { readState, saveState, recentJobs, backupStatus } = require('../state');
const { commandExists } = require('../process');
const { clientPlaybackEnabled } = require('../playback-mode');
const { hydrateJobLog, clearJobLogs } = require('../jobs');
const { settingsPatch } = require('../validation');
const { currentVersion, getUpdateInfo, installMethod } = require('../update-check');

const STATUS_CACHE_MS = 30000;
let cachedStatus = null;
let cachedStatusAt = 0;

async function statusPayload() {
  const now = Date.now();
  const update = await getUpdateInfo({ waitMs: cachedStatus ? 0 : 1500 });
  if (cachedStatus && now - cachedStatusAt < STATUS_CACHE_MS) {
    return { ...cachedStatus, update };
  }

  cachedStatus = {
    ok: true,
    version: currentVersion(),
    install: installMethod(),
    host: HOST,
    port: PORT,
    deps: {
      node: process.version,
      mpv: commandExists('mpv'),
      androidActivityManager: commandExists('am'),
      clientPlayback: clientPlaybackEnabled(),
      animeResolver: 'node',
    },
    backup: backupStatus(),
  };
  cachedStatusAt = now;
  return { ...cachedStatus, update };
}

async function handleSystemRoutes(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/status') {
    return sendJson(res, 200, await statusPayload());
  }

  if (req.method === 'GET' && url.pathname === '/api/settings') {
    return sendJson(res, 200, readState().settings);
  }

  if (req.method === 'POST' && url.pathname === '/api/settings') {
    const body = await readBody(req);
    const state = readState();
    state.settings = { ...state.settings, ...settingsPatch(body) };
    saveState(state);
    cachedStatus = null;
    cachedStatusAt = 0;
    return sendJson(res, 200, state.settings);
  }

  if (req.method === 'GET' && url.pathname === '/api/jobs') {
    const state = readState();
    const active = Array.from(registry.jobs.values());
    return sendJson(res, 200, {
      jobs: recentJobs(active, state.jobs || []).map(hydrateJobLog),
    });
  }

  if (req.method === 'DELETE' && url.pathname === '/api/jobs') {
    registry.jobs.clear();
    const state = readState();
    state.jobs = [];
    saveState(state);
    clearJobLogs();
    return sendJson(res, 200, { ok: true });
  }
}

module.exports = { handleSystemRoutes, statusPayload };
