'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  hasAnimeCatalogMapping,
  resolveAnimeCatalogIdentity,
  applyAnimeCatalogMapping,
  bindCatalogToLibrary,
  catalogFieldsFromClient,
} = require('../../lib/library-identity');

test('library identity stays on the local record when a catalog mapping is applied', () => {
  const show = {
    id: 'legacy-1',
    name: 'Custom',
    watchedEpisodes: ['1', '8'],
    archived: true,
  };
  const mapped = applyAnimeCatalogMapping(show, { provider: 'hianime', providerId: 'new-slug-2' });
  assert.equal(mapped.id, 'legacy-1');
  assert.deepEqual(mapped.watchedEpisodes, ['1', '8']);
  assert.equal(mapped.archived, true);
  assert.equal(mapped.name, 'Custom');
  assert.equal(mapped.provider, 'hianime');
  assert.equal(mapped.providerId, 'new-slug-2');
  assert.equal(mapped.hianimeId, 'new-slug-2');
  assert.equal(mapped.legacyAnidbId, 'legacy-1');
});

test('stored catalog mapping wins over a client provider id', () => {
  const stored = { id: 'same-1', provider: 'hianime', providerId: 'correct-2', hianimeId: 'correct-2' };
  const identity = resolveAnimeCatalogIdentity(stored, { id: 'same-1', hianimeId: 'wrong-3' });
  assert.deepEqual(identity, { id: 'same-1', provider: 'hianime', providerId: 'correct-2' });
});

test('catalog results reuse the library id for either providerId or legacy hianimeId', () => {
  const state = {
    shows: {
      old: { id: 'old', archived: true, provider: 'hianime', providerId: 'new' },
      other: { id: 'other', hianimeId: 'legacy-only' },
    },
  };
  const [byProviderId] = bindCatalogToLibrary(state, [{ id: 'new', provider: 'hianime', providerId: 'new', name: 'Example' }]);
  const [byLegacyField] = bindCatalogToLibrary(state, [{ id: 'legacy-only', hianimeId: 'legacy-only', name: 'Other' }]);
  assert.equal(byProviderId.id, 'old');
  assert.equal(byLegacyField.id, 'other');
});

test('unmapped library rows are not treated as catalog identities', () => {
  const stored = { id: 'legacy-1', name: 'Custom' };
  assert.deepEqual(resolveAnimeCatalogIdentity(stored, { id: 'legacy-1' }), {
    id: 'legacy-1',
    provider: 'hianime',
    providerId: '',
    missing: true,
  });
  const leftover = { id: 'legacy-1', provider: 'anidb' };
  assert.equal(resolveAnimeCatalogIdentity(leftover, leftover).missing, true);
});

test('client catalog fields accept providerId without requiring a HiAnime-specific key', () => {
  assert.deepEqual(catalogFieldsFromClient({
    id: 'old',
    providerId: 'next-3',
  }), {
    provider: 'hianime',
    providerId: 'next-3',
    hianimeId: 'next-3',
  });
  assert.equal(hasAnimeCatalogMapping({ providerId: 'next-3' }), true);
  assert.equal(hasAnimeCatalogMapping({ id: 'old' }), false);
});
