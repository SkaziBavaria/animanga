#!/usr/bin/env node
'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const { HOST, PORT, HISTORY_FILE, ACCESS_TOKEN } = require('./lib/config');
const { ensureDataDir, startBackupSchedule, closeState } = require('./lib/state');
const { handleApi } = require('./lib/routes');
const { serveStatic } = require('./lib/static');
const { syncNow, waitForActiveSync } = require('./lib/sync');
const { requireAuthentication } = require('./lib/auth');
const { shutdownJobs } = require('./lib/jobs');

ensureDataDir();
startBackupSchedule();

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
  if (!requireAuthentication(req, res, url.pathname)) return;
  if (url.pathname.startsWith('/api/')) {
    handleApi(req, res, url);
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
  else if (HOST === '0.0.0.0' || HOST === '::') console.warn('WARNING: AniManga is exposed without authentication. Set ANIMANGA_ACCESS_TOKEN or bind to localhost.');
  console.log(`History: ${HISTORY_FILE}`);
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
