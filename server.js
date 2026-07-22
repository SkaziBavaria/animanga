#!/usr/bin/env node
'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const { HOST, PORT, HISTORY_FILE, ACCESS_TOKEN, ACCESS_USERNAME } = require('./lib/config');
const { ensureDataDir, startBackupSchedule } = require('./lib/state');
const { handleApi } = require('./lib/routes');
const { serveStatic } = require('./lib/static');
const { syncNow } = require('./lib/sync');
const { requireAuthentication } = require('./lib/auth');

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
  if (ACCESS_TOKEN) console.log(`Authentication enabled for user ${ACCESS_USERNAME}`);
  else if (HOST === '0.0.0.0' || HOST === '::') console.warn('WARNING: AniManga is exposed without authentication. Set ANIMANGA_ACCESS_TOKEN or bind to localhost.');
  console.log(`History: ${HISTORY_FILE}`);
});

setTimeout(() => syncNow({ silent: true }), 15_000).unref();
setInterval(() => syncNow({ silent: true }), 5 * 60_000).unref();
