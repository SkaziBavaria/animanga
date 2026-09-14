'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createAnimeProvider, normalizeDetails, providerIdentity, bindCatalogToLibrary } = require('../../lib/anime-provider');
const { touchShow } = require('../../lib/routes/shared');
const { pickMatch } = require('../../lib/hianime-migrate');

test('provider details preserve library identity and normalize episode objects', async () => {
  const state = { settings: {}, shows: { 'legacy-1': { id: 'legacy-1', hianimeId: 'new-2', archived: true, watchedEpisodes: ['1'] } } };
  const service = createAnimeProvider({ hianime: { getShowDetails: async (id) => ({ id, episodes: [{ number: '1', title: 'First' }, { number: '2' }] }) } });
  const details = await service.details(state, 'legacy-1');
  assert.equal(details.id, 'legacy-1');
  assert.deepEqual(details.episodes, ['1', '2']);
  assert.equal(details.episodeTitles['1'], 'First');
  touchShow(state, 'legacy-1', details);
  assert.deepEqual(Object.keys(state.shows), ['legacy-1']);
  assert.deepEqual(state.shows['legacy-1'].watchedEpisodes, ['1']);
  assert.equal(state.shows['legacy-1'].archived, true);
});

test('stored provider mapping wins over client hints and slug shapes are not identities', () => {
  const state = { shows: { 'same-1': { id: 'same-1', hianimeId: 'correct-2' } } };
  assert.equal(providerIdentity(state, { id: 'same-1', hianimeId: 'wrong-3' }).providerId, 'correct-2');
  assert.equal(providerIdentity(state, 'unknown-1').provider, 'hianime');
  assert.equal(providerIdentity(state, { id: 'unknown-1', provider: 'hianime' }).provider, 'hianime');
});

test('unmapped library titles cannot be used as catalog ids', () => {
  const state = { shows: { 'legacy-1': { id: 'legacy-1', name: 'Custom' } } };
  assert.throws(() => providerIdentity(state, 'legacy-1'), /catalog match/);
});

test('wrong provider identity cannot be applied to stored history', () => {
  assert.throws(() => normalizeDetails({ id: 'local', providerId: 'right' }, { id: 'wrong' }), /wrong identity/);
  assert.throws(() => touchShow({ shows: { local: { id: 'local' } } }, 'local', { id: 'wrong' }), /wrong identity/);
});

test('playback uses the same provider mapping as metadata', async () => {
  const service = createAnimeProvider({ hianime: { resolveEpisodePlayback: async (options) => options } });
  const result = await service.playback({ shows: { old: { id: 'old', hianimeId: 'new' } } }, 'old', { episode: '15', mode: 'dub' });
  assert.deepEqual(result, { showId: 'new', episode: '15', mode: 'dub' });
});

test('automatic migration does not map a season to its sequel by prefix', () => {
  assert.equal(pickMatch({ name: 'Example' }, [{ id: 'sequel', name: 'Example Season 2' }]), null);
});

test('Discover reuses an archived library identity instead of creating a duplicate', () => {
  const state = { shows: { old: { id: 'old', archived: true, hianimeId: 'new' } } };
  const [result] = bindCatalogToLibrary(state, [{ id: 'new', hianimeId: 'new', name: 'Example' }]);
  assert.equal(result.id, 'old');
  assert.equal(result.hianimeId, 'new');
});

test('details persist a generic catalog mapping beside the library id', async () => {
  const state = { settings: {}, shows: { 'legacy-1': { id: 'legacy-1', providerId: 'new-2' } } };
  const service = createAnimeProvider({ hianime: { getShowDetails: async (id) => ({ id, episodes: ['1'] }) } });
  const details = await service.details(state, 'legacy-1');
  assert.equal(details.id, 'legacy-1');
  assert.equal(details.provider, 'hianime');
  assert.equal(details.providerId, 'new-2');
  assert.equal(details.hianimeId, 'new-2');
});

test('concurrent details share a fetch but never share mutable returned objects', async () => {
  let calls = 0;
  const service = createAnimeProvider({ hianime: { getShowDetails: async (id) => { calls++; return { id, episodes: ['1'] }; } } });
  const input = { id: 'new', provider: 'hianime' };
  const [first, second] = await Promise.all([service.details({}, input), service.details({}, input)]);
  first.episodes.push('2');
  assert.deepEqual(second.episodes, ['1']);
  assert.equal(calls, 1);
  await service.details({}, input, 'sub', { force: true });
  assert.equal(calls, 2);
});
