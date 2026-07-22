'use strict';

const { spawnSync } = require('child_process');
const {
  ANI_CLI,
  HISTORY_FILE,
  HOST,
  PORT,
  ANIME_RESOLVER,
  ANI_CLI_FALLBACK,
} = require('../config');
const registry = require('../registry');
const { sendJson, readBody } = require('../http');
const { readState, saveState, recentJobs, backupStatus } = require('../state');
const { commandExists } = require('../process');
const { clientPlaybackEnabled } = require('../legacy/ani-cli');
const { hydrateJobLog, clearJobLogs } = require('../jobs');
const { settingsPatch } = require('../validation');

const STATUS_CACHE_MS = 30000;
let cachedStatus = null;
let cachedStatusAt = 0;

function statusPayload() {
  const now = Date.now();
  if (cachedStatus && now - cachedStatusAt < STATUS_CACHE_MS) return cachedStatus;

  const legacyEnabled = ANIME_RESOLVER === 'ani-cli' || ANI_CLI_FALLBACK;
  const version = legacyEnabled
    ? spawnSync(ANI_CLI, ['--version'], { encoding: 'utf8' })
    : { status: null, stdout: '' };
  cachedStatus = {
    ok: true,
    aniCli: ANI_CLI,
    aniCliVersion: version.stdout?.trim() || null,
    historyFile: HISTORY_FILE,
    host: HOST,
    port: PORT,
    deps: {
      node: process.version,
      aniCli: legacyEnabled && version.status === 0,
      mpv: commandExists('mpv'),
      androidActivityManager: commandExists('am'),
      clientPlayback: clientPlaybackEnabled(),
      animeResolver: ANIME_RESOLVER,
      aniCliFallback: ANI_CLI_FALLBACK,
    },
    backup: backupStatus(),
  };
  cachedStatusAt = now;
  return cachedStatus;
}

async function handleSystemRoutes(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/status') {
    return sendJson(res, 200, statusPayload());
  }

  if (req.method === 'GET' && url.pathname === '/api/settings') {
    return sendJson(res, 200, readState().settings);
  }

  if (req.method === 'POST' && url.pathname === '/api/settings') {
    const body = await readBody(req);
    const state = readState();
    state.settings = { ...state.settings, ...settingsPatch(body) };
    saveState(state);
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
