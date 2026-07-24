'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'animanga-sync-config-'));
process.env.ANIMANGA_DATA_DIR = testDir;
process.env.ANIMANGA_DOWNLOAD_DIR = path.join(testDir, 'downloads');

const sync = require('../../lib/sync');
const githubSync = require('../../lib/github-sync');
const { ensureDataDir } = require('../../lib/state');
const { DATABASE_FILE, DATA_DIR } = require('../../lib/config');

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
  assert.equal(require('../../lib/state').getAppValue('sync_google').callbackUrl, 'http://127.0.0.1:7831/api/sync/google/callback');
});

test('protects the local credential store with private Unix permissions', { skip: process.platform === 'win32' }, () => {
  ensureDataDir();
  assert.equal(fs.statSync(DATA_DIR).mode & 0o777, 0o700);
  assert.equal(fs.statSync(DATABASE_FILE).mode & 0o777, 0o600);
});

test('exchanges OAuth codes with the callback URL saved at authorization start', async () => {
  const callbackUrl = 'https://anime.example/api/sync/google/callback';
  sync.authorizationUrl(callbackUrl);
  const oauthState = require('../../lib/state').getAppValue('sync_google').oauthState;
  const originalFetch = global.fetch;
  let tokenBody = '';
  global.fetch = async (_url, options) => {
    tokenBody = String(options.body);
    return new Response(JSON.stringify({
      refresh_token: 'google-refresh-token',
      access_token: 'google-access-token',
      expires_in: 3600,
    }), { status: 200 });
  };
  try {
    await sync.finishAuthorization({
      code: 'oauth-code',
      state: oauthState,
      callbackUrl: 'https://attacker.example/callback',
    });
  } finally {
    global.fetch = originalFetch;
  }
  assert.equal(new URLSearchParams(tokenBody).get('redirect_uri'), callbackUrl);
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
    if (String(url).endsWith('/repos/zafer/animanga-sync-data')) {
      return new Response(JSON.stringify({ name: 'animanga-sync-data', private: true }), { status: 200 });
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
  assert.equal(JSON.parse(upload.options.body).message.startsWith('Sync AniManga device '), true);
  githubSync.setRawFetcher(null);
});

test('refuses to place sync data in a public repository', async () => {
  githubSync.setRawFetcher(async (url) => {
    if (String(url).endsWith('/repos/zafer/animanga-sync-data')) {
      return new Response(JSON.stringify({ name: 'animanga-sync-data', private: false }), { status: 200 });
    }
    throw new Error(`Unexpected GitHub request: ${url}`);
  });
  await assert.rejects(() => githubSync.syncNow(), /must be private/);
  githubSync.setRawFetcher(null);
});
