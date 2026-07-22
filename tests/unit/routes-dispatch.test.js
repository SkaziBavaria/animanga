'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');

process.env.ANI_WEB_DATA_DIR = path.join(os.tmpdir(), `ani-web-routes-${process.pid}`);

const { handleApi } = require('../../lib/routes');

function response() {
  return {
    headersSent: false,
    writableEnded: false,
    writeHead(status, headers = {}) {
      this.status = status;
      this.headers = headers;
      this.headersSent = true;
    },
    end(value = '') {
      this.body = String(value);
      this.writableEnded = true;
    },
    destroy() {
      this.destroyed = true;
      this.writableEnded = true;
    },
  };
}

async function request(pathname) {
  const req = { method: 'GET', headers: {}, on() {} };
  const res = response();
  await handleApi(req, res, new URL(pathname, 'http://localhost'));
  return { res, json: res.body ? JSON.parse(res.body) : null };
}

test('dispatcher reaches each read-only route domain', async () => {
  const cases = [
    ['/api/status', 200, 'ok'],
    ['/api/sync', 200, 'provider'],
    ['/api/library', 200, 'shows'],
    ['/api/manga/library', 200, 'mangas'],
    ['/api/downloads', 200, 'downloads'],
  ];

  for (const [pathname, status, property] of cases) {
    const result = await request(pathname);
    assert.equal(result.res.status, status, pathname);
    assert.ok(Object.hasOwn(result.json, property), pathname);
  }
});

test('dispatcher reaches playback and returns a consistent unknown-route response', async () => {
  const proxy = await request('/api/proxy');
  assert.equal(proxy.res.status, 400);
  assert.equal(proxy.json.error, 'Missing url');

  const missing = await request('/api/does-not-exist');
  assert.equal(missing.res.status, 404);
  assert.equal(missing.json.error, 'API endpoint missing');
});
