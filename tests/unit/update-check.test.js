'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  compareVersions,
  currentVersion,
  getUpdateInfo,
  normalizeVersion,
  refreshUpdateInfo,
  resetUpdateCheckForTests,
  updateHint,
} = require('../../lib/update-check');

test.beforeEach(() => {
  resetUpdateCheckForTests();
});

test('normalizeVersion strips v-prefix and junk', () => {
  assert.equal(normalizeVersion('v1.2.3'), '1.2.3');
  assert.equal(normalizeVersion('1.2'), '1.2');
  assert.equal(normalizeVersion(''), '');
});

test('compareVersions orders semver-like tags', () => {
  assert.equal(compareVersions('0.1.0', '0.2.0'), -1);
  assert.equal(compareVersions('v0.2.0', '0.1.9'), 1);
  assert.equal(compareVersions(currentVersion(), `v${currentVersion()}`), 0);
});

test('updateHint matches install method', () => {
  assert.match(updateHint('docker', '0.2.0'), /docker compose up -d --build/);
  assert.match(updateHint('npm', '0.2.0'), /npm install -g animanga@latest/);
});

test('refreshUpdateInfo reports a newer GitHub release', async () => {
  const fetcher = async () => ({
    ok: true,
    status: 200,
    async json() {
      return {
        tag_name: 'v9.9.9',
        html_url: 'https://github.com/SkaziBavaria/animanga/releases/tag/v9.9.9',
        published_at: '2099-01-01T00:00:00Z',
      };
    },
  });
  const update = await refreshUpdateInfo(fetcher);
  assert.equal(update.latest, '9.9.9');
  assert.match(update.url, /v9\.9\.9/);
  assert.match(update.hint, /Update available/);
});

test('refreshUpdateInfo returns null when current is newest', async () => {
  const fetcher = async () => ({
    ok: true,
    status: 200,
    async json() {
      return { tag_name: `v${currentVersion()}`, html_url: 'https://example.test/release' };
    },
  });
  assert.equal(await refreshUpdateInfo(fetcher), null);
});

test('getUpdateInfo caches a negative result after 404', async () => {
  let calls = 0;
  const fetcher = async () => {
    calls += 1;
    return { ok: false, status: 404, async json() { return {}; } };
  };
  assert.equal(await getUpdateInfo({ waitMs: 1000, fetcher }), null);
  assert.equal(await getUpdateInfo({ waitMs: 1000, fetcher }), null);
  assert.equal(calls, 1);
});
