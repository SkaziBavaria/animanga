#!/usr/bin/env node
'use strict';

const http = require('http');
const { HOST, PORT, HISTORY_FILE } = require('./lib/config');
const { ensureDataDir } = require('./lib/state');
const { handleApi } = require('./lib/routes');
const { serveStatic } = require('./lib/static');

ensureDataDir();

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
