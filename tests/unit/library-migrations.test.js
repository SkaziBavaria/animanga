'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mergeAnimeMigration } = require('../../lib/library-migrations');

test('migration applies only mapping fields to the latest library record', () => {
  const current = { id: 'old', archived: true, name: 'Custom', watchedEpisodes: ['1', '2'] };
  const stale = { id: 'old', archived: false, name: 'Original', watchedEpisodes: [], provider: 'hianime', hianimeId: 'matched-123' };
  assert.deepEqual(mergeAnimeMigration(current, stale), { ...current, provider: 'hianime', hianimeId: 'matched-123' });
  assert.equal(mergeAnimeMigration(undefined, stale), undefined);
  const manuallyMatched = { ...current, hianimeId: 'manual-456' };
  assert.equal(mergeAnimeMigration(manuallyMatched, stale), manuallyMatched);
  const mappedByProviderId = { ...current, providerId: 'next-3' };
  assert.equal(mergeAnimeMigration(mappedByProviderId, stale), mappedByProviderId);
});
