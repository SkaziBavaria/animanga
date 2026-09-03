'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  mergeShow, presentShow, pickReleaseWatchMatch, assertSafeShowRefresh,
} = require('../../lib/library');

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
        archived: true,
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
  assert.equal(merged.archived, true);
});

test('mergeShow defaults archived to false and accepts explicit archive updates', () => {
  const state = { settings: { mode: 'sub' }, shows: {} };
  const created = mergeShow(state, { id: 'fresh', name: 'Fresh' });
  assert.equal(created.archived, false);
  const archived = mergeShow(state, { id: 'fresh', archived: true });
  assert.equal(archived.archived, true);
});

test('anime refresh guard rejects mismatched and incomplete metadata', () => {
  const existing = { id: 'correct-1', sourceName: 'Correct Show', thumbnail: 'old.jpg' };
  assert.throws(() => assertSafeShowRefresh(existing, { id: 'wrong-2', name: 'Correct Show', thumbnail: 'new.jpg' }), /wrong identity/);
  assert.throws(() => assertSafeShowRefresh(existing, { id: 'correct-1', name: 'Service Unavailable', thumbnail: 'new.jpg' }), /mismatched/);
  assert.throws(() => assertSafeShowRefresh(existing, { id: 'correct-1', name: 'Correct Show' }), /incomplete/);
  assert.equal(assertSafeShowRefresh(existing, { id: 'correct-1', name: 'Correct Show', thumbnail: 'new.jpg' }).id, 'correct-1');
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

test('release watches reject loose search hits and accept exact titles or subtitles', () => {
  assert.equal(pickReleaseWatchMatch('Ghost of Tsushima', [
    { id: 'wrong', name: 'Dusk Maiden of Amnesia: Ghost Girl' },
  ]), null);
  assert.equal(pickReleaseWatchMatch('Ghost of Tsushima', [
    { id: 'subtitle', name: 'Ghost of Tsushima: Legends' },
  ]).id, 'subtitle');
});
