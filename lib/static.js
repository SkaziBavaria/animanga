'use strict';

const fs = require('fs');
const path = require('path');
const { PUBLIC_DIR, mimeTypes } = require('./config');

function pathInside(root, filePath) {
  const relative = path.relative(root, filePath);
  return relative === '' || Boolean(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function serveStatic(req, res, url) {
  let requested;
  try {
    requested = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400);
    res.end('Bad request');
    return;
  }
  const filePath = path.normalize(path.join(PUBLIC_DIR, requested));
  if (!pathInside(PUBLIC_DIR, filePath)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, {
      'content-type': mimeTypes[ext] || 'application/octet-stream',
      'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
    });
    res.end(data);
  });
}

module.exports = {
  pathInside,
  serveStatic,
};
