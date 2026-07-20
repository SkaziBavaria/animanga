'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ani-web-sync-config-'));
process.env.ANI_WEB_DATA_DIR = testDir;
process.env.ANI_CLI_HIST_DIR = path.join(testDir, 'history');
process.env.ANI_CLI_DOWNLOAD_DIR = path.join(testDir, 'downloads');

const sync = require('../../lib/sync');
const githubSync = require('../../lib/github-sync');
const { ensureDataDir } = require('../../lib/state');

test('stores Google credentials server-side and produces an OAuth URL', () => {
  ensureDataDir();
  const configured = sync.configure({ clientId: 'client.apps.googleusercontent.com', clientSecret: 'secret', deviceName: 'Phone' });
  assert.equal(configured.clientId, 'client.apps.googleusercontent.com');
  assert.equal(configured.hasClientSecret, true);
  assert.equal(Object.hasOwn(configured, 'clientSecret'), false);

  const url = new URL(sync.authorizationUrl('http://127.0.0.1:7831/api/sync/google/callback'));
  assert.equal(url.origin, 'https://accounts.google.com');
  assert.equal(url.searchParams.get('scope'), 'https://www.googleapis.com/auth/drive.appdata');
  assert.equal(url.searchParams.get('access_type'), 'offline');
});

test('uses GitHub device flow without exposing tokens', async () => {
  ensureDataDir();
  const requests = [];
  githubSync.setRawFetcher(async (url, options = {}) => {
    requests.push({ url: String(url), options });
    if (String(url).endsWith('/login/device/code')) {
      return new Response(JSON.stringify({
        device_code: 'device-secret',
        user_code: 'ABCD-1234',
        verification_uri: 'https://github.com/login/device',
        expires_in: 900,
        interval: 5,
      }), { status: 200 });
    }
    if (String(url).endsWith('/login/oauth/access_token')) {
      return new Response(JSON.stringify({ access_token: 'github-secret-token', token_type: 'bearer', scope: 'repo' }), { status: 200 });
    }
    if (String(url).endsWith('/user')) {
      return new Response(JSON.stringify({ login: 'zafer' }), { status: 200 });
    }
    throw new Error(`Unexpected GitHub request: ${url}`);
  });

  const configured = sync.configureGithub({ clientId: 'github-client-id', deviceName: 'Laptop' });
  assert.equal(configured.clientId, 'github-client-id');
  assert.equal(sync.publicConfig().provider, 'github');
  const pending = await sync.startGithubAuthorization();
  assert.equal(pending.status, 'pending');
  assert.equal(pending.userCode, 'ABCD-1234');
  assert.match(String(requests[0].options.body), /scope=repo/);

  const authorized = await sync.pollGithubAuthorization();
  assert.equal(authorized.status, 'success');
  const visible = sync.publicConfig().github;
  assert.equal(visible.connected, true);
  assert.equal(visible.account, 'zafer');
  assert.equal(Object.hasOwn(visible, 'token'), false);
  githubSync.setRawFetcher(null);
});

test('uploads one private-repo sync file per device', async () => {
  const requests = [];
  githubSync.setRawFetcher(async (url, options = {}) => {
    requests.push({ url: String(url), options });
    if (String(url).endsWith('/repos/zafer/aniweb-sync-data')) {
      return new Response(JSON.stringify({ name: 'aniweb-sync-data', private: true }), { status: 200 });
    }
    if (String(url).endsWith('/contents/devices') && (!options.method || options.method === 'GET')) {
      return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
    }
    if (String(url).includes('/contents/devices/') && options.method === 'PUT') {
      return new Response(JSON.stringify({ content: { sha: 'new-sha' } }), { status: 201 });
    }
    throw new Error(`Unexpected GitHub request: ${url}`);
  });

  const result = await githubSync.syncNow();
  assert.equal(result.provider, 'github');
  assert.equal(result.files, 1);
  const upload = requests.find((request) => request.options.method === 'PUT');
  assert.match(upload.url, /\/contents\/devices\/.+\.json$/);
  assert.equal(JSON.parse(upload.options.body).message.startsWith('Sync ani-web device '), true);
  githubSync.setRawFetcher(null);
});

test('refuses to place sync data in a public repository', async () => {
  githubSync.setRawFetcher(async (url) => {
    if (String(url).endsWith('/repos/zafer/aniweb-sync-data')) {
      return new Response(JSON.stringify({ name: 'aniweb-sync-data', private: false }), { status: 200 });
    }
    throw new Error(`Unexpected GitHub request: ${url}`);
  });
  await assert.rejects(() => githubSync.syncNow(), /must be private/);
  githubSync.setRawFetcher(null);
});
