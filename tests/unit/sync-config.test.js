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
