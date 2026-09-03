'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ACTIVE_REFRESH_MS,
  FINISHED_REFRESH_MS,
  refreshAgeMs,
  pickDue,
} = require('../../lib/library-refresh');

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
