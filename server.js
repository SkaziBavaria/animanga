#!/usr/bin/env node
'use strict';

const http = require('http');
const { HOST, PORT, HISTORY_FILE } = require('./lib/config');
const { ensureDataDir, startBackupSchedule } = require('./lib/state');
const { handleApi } = require('./lib/routes');
const { serveStatic } = require('./lib/static');
const { syncNow } = require('./lib/sync');

ensureDataDir();
startBackupSchedule();

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
  if (url.pathname.startsWith('/api/')) {
    handleApi(req, res, url);
    return;
  }
  serveStatic(req, res, url);
});

server.listen(PORT, HOST, () => {
  console.log(`Ani Web running at http://${HOST}:${PORT}`);
  console.log(`History: ${HISTORY_FILE}`);
});

setTimeout(() => syncNow({ silent: true }), 15_000).unref();
setInterval(() => syncNow({ silent: true }), 5 * 60_000).unref();
