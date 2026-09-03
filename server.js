#!/usr/bin/env node
'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const { HOST, PORT, ACCESS_TOKEN } = require('./lib/config');
const { isOpenBind } = require('./lib/bind-security');
const { ensureDataDir, startBackupSchedule, closeState } = require('./lib/state');
const { handleApi } = require('./lib/routes');
const { sendError } = require('./lib/http');
const { serveStatic } = require('./lib/static');
const { syncNow, waitForActiveSync } = require('./lib/sync');
const { requireAuthentication } = require('./lib/auth');
const { shutdownJobs } = require('./lib/jobs');
const { startLibraryRefreshSchedule, stopLibraryRefreshSchedule } = require('./lib/library-refresh');

ensureDataDir();
startBackupSchedule();
startLibraryRefreshSchedule();

// Best-effort provider ID migrations (non-blocking).
setTimeout(() => {
  try {
    const { readState, saveState } = require('./lib/state');
    const { migrateLibraryToAnidb } = require('./lib/anidb-migrate');
    const { migrateLibraryToComicK } = require('./lib/comick-migrate');
    const state = readState();
    migrateLibraryToAnidb(state, { limit: 25 })
      .then(async (animeReport) => [animeReport, await migrateLibraryToComicK(state, { limit: 25 })])
      .then(([animeReport, mangaReport]) => {
        if (animeReport.migrated || animeReport.needsRematch || mangaReport.migrated || mangaReport.needsRematch) {
          saveState(state);
          console.log(`[migration] anime=${animeReport.migrated}/${animeReport.needsRematch} manga=${mangaReport.migrated}/${mangaReport.needsRematch}`);
        }
      })
      .catch((error) => {
        console.warn('[anidb] library migration skipped:', error.message || error);
      });
  } catch (error) {
    console.warn('[anidb] library migration unavailable:', error.message || error);
  }
}, 2_500).unref();

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
});
process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
  process.exit(1);
});

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
  if (!requireAuthentication(req, res, url.pathname, url.searchParams)) return;
  if (url.pathname.startsWith('/api/')) {
    handleApi(req, res, url).catch((err) => {
      if (!res.headersSent) {
        sendError(res, Number(err.status || err.statusCode) || 500, err.message || 'Internal server error');
      } else {
        res.destroy();
      }
    });
    return;
  }
  serveStatic(req, res, url);
});

function lanAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((address) => address && (address.family === 'IPv4' || address.family === 4) && !address.internal)
    .map((address) => address.address)
    .filter((address, index, addresses) => addresses.indexOf(address) === index);
}

server.listen(PORT, HOST, () => {
  const availableHost = ['0.0.0.0', '::', '127.0.0.1', '::1'].includes(HOST) ? 'localhost' : HOST;
  console.log(`AniManga available at http://${availableHost}:${PORT}`);
  if (HOST === '0.0.0.0' || HOST === '::') {
    if (!fs.existsSync('/.dockerenv')) {
      for (const address of lanAddresses()) console.log(`AniManga available on LAN at http://${address}:${PORT}`);
    }
  }
  console.log(`Listening on ${HOST}:${PORT}`);
  if (ACCESS_TOKEN) console.log('Authentication enabled');
  else if (isOpenBind(HOST)) console.log('Open on the network without a password. Set ANIMANGA_ACCESS_TOKEN to lock it.');
});

const initialSyncTimer = setTimeout(() => syncNow({ silent: true }), 15_000);
const syncTimer = setInterval(() => syncNow({ silent: true }), 5 * 60_000);
initialSyncTimer.unref();
syncTimer.unref();

let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) {
    console.error(`Received ${signal} again; forcing exit`);
    process.exit(1);
  }
  shuttingDown = true;
  console.log(`Received ${signal}; shutting down`);
  clearTimeout(initialSyncTimer);
  clearInterval(syncTimer);

  const serverClosed = new Promise((resolve) => server.close(resolve));
  const connectionDeadline = setTimeout(() => server.closeAllConnections(), 10_000);
  connectionDeadline.unref();

  await Promise.all([
    serverClosed,
    shutdownJobs(),
    waitForActiveSync(),
    stopLibraryRefreshSchedule(),
  ]);
  clearTimeout(connectionDeadline);
  await closeState();
  console.log('AniManga stopped cleanly');
}

process.on('SIGTERM', () => shutdown('SIGTERM').catch((error) => {
  console.error('Shutdown failed:', error);
  process.exitCode = 1;
}));
process.on('SIGINT', () => shutdown('SIGINT').catch((error) => {
  console.error('Shutdown failed:', error);
  process.exitCode = 1;
}));

module.exports = { server, shutdown };
