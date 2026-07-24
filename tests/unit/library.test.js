'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mergeShow, presentShow } = require('../../lib/library');

test('mergeShow preserves useful metadata when a refresh returns empty fields', () => {
  const state = {
    settings: { mode: 'sub' },
    shows: {
      show: {
        id: 'show',
        name: 'Existing name',
        title: 'Existing name (12 episodes)',
        thumbnail: 'cover.jpg',
        episodeCount: 12,
        latestEpisode: '12',
        episodes: ['1', '2', '12'],
        watchedEpisodes: ['1'],
      },
    },
  };

  const merged = mergeShow(state, {
    id: 'show',
    name: '',
    title: ' (0 episodes)',
    thumbnail: '',
    episodeCount: 0,
    latestEpisode: null,
    episodes: [],
  });

  assert.equal(merged.name, 'Existing name');
  assert.equal(merged.title, 'Existing name (12 episodes)');
  assert.equal(merged.thumbnail, 'cover.jpg');
  assert.equal(merged.episodeCount, 12);
  assert.equal(merged.latestEpisode, '12');
  assert.deepEqual(merged.episodes, ['1', '2', '12']);
});

test('presentShow lets sequel data override a stale false flag', () => {
  const show = presentShow({
    id: 'bleach-conflict',
    name: 'BLEACH: Thousand-Year Blood War - The Conflict',
    hasNextSeason: false,
    relatedShows: [{ relation: 'sequel', showId: 'bleach-calamity' }],
    nextSeason: { id: 'bleach-calamity', status: 'Not Yet Released' },
    watchedEpisodes: [],
  });
  assert.equal(show.hasNextSeason, true);
  assert.equal(show.nextSeason.status, 'Not Yet Released');
});
