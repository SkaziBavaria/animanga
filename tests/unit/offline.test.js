'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { cachedEpisodeDetails } = require('../../lib/routes');

test('cachedEpisodeDetails returns a stored episode list for offline use', () => {
  const result = cachedEpisodeDetails({ id: 'show', name: 'Show', episodes: ['1', '3'], latestEpisode: '3' });
  assert.deepEqual(result.episodes, ['1', '3']);
  assert.equal(result.latestEpisode, '3');
  assert.equal(result.offline, true);
});

test('cachedEpisodeDetails synthesizes numeric episodes from a stored count', () => {
  const result = cachedEpisodeDetails({ id: 'show', name: 'Show', episodeCount: 3 });
  assert.deepEqual(result.episodes, ['1', '2', '3']);
  assert.equal(result.cached, true);
});

test('cachedEpisodeDetails declines shows with no cached episode information', () => {
  assert.equal(cachedEpisodeDetails({ id: 'upcoming', episodeCount: 0 }), null);
});
