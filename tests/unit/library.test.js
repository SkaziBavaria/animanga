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

test('mergeShow remaps leftover absolute watch history onto the current episode list', () => {
  const state = { settings: { mode: 'sub' }, shows: {} };
  const merged = mergeShow(state, {
    id: 'season',
    name: 'Season Show',
    episodes: Array.from({ length: 22 }, (_, index) => String(index + 1)),
    latestEpisode: '22',
    episodeCount: 22,
    watchedEpisodes: ['73', '74', '89'],
    lastWatched: '89',
  });
  assert.deepEqual(merged.watchedEpisodes, ['1', '2', '17']);
});

test('mergeShow uses a language that actually has episode counts', () => {
  const state = { settings: { mode: 'sub' }, shows: {} };
  const merged = mergeShow(state, {
    id: 'sub-only',
    name: 'Sub Only',
    mode: 'dub',
    episodeCounts: { sub: 9 },
  });
  assert.equal(merged.mode, 'sub');
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

test('presentShow uses the stored episode list when catalog ticks lag behind', () => {
  const show = presentShow({
    id: 'lagging-ticks',
    name: 'Lagging ticks',
    latestEpisode: '8',
    episodeCount: 8,
    episodeCounts: { sub: 8, dub: 8 },
    episodes: Array.from({ length: 10 }, (_, index) => String(index + 1)),
    watchedEpisodes: ['1', '2', '3', '4', '5', '6', '7', '8'],
  });
  assert.equal(show.latestEpisode, '10');
  assert.equal(show.lastWatched, '8');
  assert.equal(show.newCount, 2);
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
