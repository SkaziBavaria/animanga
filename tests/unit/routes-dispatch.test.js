'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');

process.env.ANIMANGA_DATA_DIR = path.join(os.tmpdir(), `animanga-routes-${process.pid}`);

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

async function request(pathname, options = {}) {
  const rawBody = options.body === undefined
    ? ''
    : typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
  const req = Readable.from(rawBody ? [Buffer.from(rawBody)] : []);
  req.method = options.method || 'GET';
  req.headers = rawBody ? { 'content-length': String(Buffer.byteLength(rawBody)) } : {};
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

  const githubPollGet = await request('/api/sync/github/poll');
  assert.equal(githubPollGet.res.status, 405);
  assert.equal(githubPollGet.json.error, 'Method not allowed');

  const githubPollPost = await request('/api/sync/github/poll', { method: 'POST', body: {} });
  assert.equal(githubPollPost.res.status, 200);
  assert.ok(Object.hasOwn(githubPollPost.json, 'deviceAuth'));

  const missing = await request('/api/does-not-exist');
  assert.equal(missing.res.status, 404);
  assert.equal(missing.json.error, 'API endpoint missing');
});

test('dispatcher preserves typed body and validation errors', async () => {
  const malformed = await request('/api/settings', { method: 'POST', body: '{nope' });
  assert.equal(malformed.res.status, 400);
  assert.equal(malformed.json.error, 'Request body must contain valid JSON');

  const unknown = await request('/api/settings', { method: 'POST', body: { admin: true } });
  assert.equal(unknown.res.status, 422);
  assert.equal(unknown.json.error, 'Unknown settings field');

  const missingId = await request('/api/track', { method: 'POST', body: { name: 'No id' } });
  assert.equal(missingId.res.status, 422);
  assert.equal(missingId.json.error, 'Missing show id');
});

test('manga progress accepts the public mangaId payload shape', async () => {
  const result = await request('/api/manga/progress', {
    method: 'POST',
    body: { mangaId: 'manga-1', language: 'sub', chapter: '2', page: 4, pageCount: 9 },
  });
  assert.equal(result.res.status, 200);
  assert.equal(result.json.position.page, 4);
});
