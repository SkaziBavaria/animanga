'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ACTIVE_REFRESH_MS,
  FINISHED_REFRESH_MS,
  ERROR_BACKOFF_MS,
  refreshAgeMs,
  pickDue,
  refreshKind,
  resetLibraryRefreshForTests,
} = require('../../lib/library-refresh');
const { providerHealth, resetProviderHealth } = require('../../lib/provider-health');

test.afterEach(() => {
  resetLibraryRefreshForTests();
  resetProviderHealth();
});

test('automatic refresh checks active titles more often than finished titles', () => {
  assert.equal(refreshAgeMs({ status: 'Ongoing' }), ACTIVE_REFRESH_MS);
  assert.equal(refreshAgeMs({ status: 'Finished' }), FINISHED_REFRESH_MS);
  assert.ok(ACTIVE_REFRESH_MS < FINISHED_REFRESH_MS);
});

test('automatic refresh selects only stale tracked items in oldest-first batches', () => {
  const now = Date.parse('2026-09-03T12:00:00Z');
  const items = [
    { id: 'fresh', status: 'Ongoing', lastCheckedAt: '2026-09-03T10:00:00Z' },
    { id: 'old', status: 'Ongoing', lastCheckedAt: '2026-09-02T10:00:00Z' },
    { id: 'older', status: 'Finished', lastCheckedAt: '2026-08-30T10:00:00Z' },
    { id: 'untracked', tracked: false, lastCheckedAt: '2020-01-01T00:00:00Z' },
  ];
  assert.deepEqual(pickDue(items, now, 2).map((item) => item.id), ['older', 'old']);
});

test('one bad anime item is backed off without blocking other due titles', async () => {
  const now = Date.parse('2026-09-12T12:00:00Z');
  const state = { shows: {
    bad: { id: 'bad', name: 'Bad title', tracked: true, lastCheckedAt: '2020-01-01T00:00:00Z' },
    good: { id: 'good', name: 'Good title', tracked: true, lastCheckedAt: '2020-01-01T00:00:00Z' },
  }, mangas: {} };
  const saved = [];
  const result = await refreshKind('anime', now, {
    readState: () => state,
    saveState: () => saved.push(true),
    async refreshShow(_state, item) {
      if (item.id === 'bad') throw new Error('Anime refresh returned mismatched or invalid metadata');
      return item;
    },
  });
  assert.deepEqual(result, { kind: 'anime', refreshed: 1 });
  assert.equal(state.shows.bad.refreshRetryAt, new Date(now + ERROR_BACKOFF_MS).toISOString());
  assert.match(state.jobs[0].label, /Bad title/);
  assert.match(state.jobs[0].error, /mismatched or invalid metadata/);
  assert.equal(state.jobs[0].status, 'skipped');
  assert.equal(pickDue(Object.values(state.shows), now).some((item) => item.id === 'bad'), false);
  assert.ok(saved.length >= 2);
});

test('auto-refresh pauses anime after a provider failure and records HiAnime health', async () => {
  const now = Date.parse('2026-09-12T12:00:00Z');
  const result = await refreshKind('anime', now, {
    readState: () => ({
      shows: {
        a: { id: 'a', tracked: true, status: 'Ongoing', lastCheckedAt: '2020-01-01T00:00:00Z' },
      },
      mangas: {},
    }),
    saveState() {},
    async refreshShow() {
      throw new Error('HiAnime HTTP 403');
    },
  });
  assert.equal(result.failed, true);
  assert.equal(providerHealth().hianime.ok, false);
  assert.equal(providerHealth().hianime.reason, 'HTTP 403');
});
