'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

async function loadUtil() {
  const source = fs.readFileSync(path.join(__dirname, '../../public/js/util.js'), 'utf8');
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}

test('nextEpisode remaps leftover absolute watch history onto the current season', async () => {
  const { nextEpisode, presentAnimeCard } = await loadUtil();
  const show = {
    episodes: Array.from({ length: 22 }, (_, index) => String(index + 1)),
    latestEpisode: '22',
    episodeCount: 22,
    episodeCounts: { sub: 20 },
    watchedEpisodes: ['73', '74', '89'],
    lastWatched: '89',
  };
  assert.equal(nextEpisode(show), '18');
  assert.equal(presentAnimeCard(show).lastWatched, '17');
});

test('nextEpisode skips watched episodes and finds a later unwatched episode', async () => {
  const { nextEpisode } = await loadUtil();
  assert.equal(nextEpisode({
    episodes: ['1', '2', '3', '4'],
    watchedEpisodes: ['1', '2'],
    lastWatched: '2',
  }), '3');
});

test('nextEpisode returns an earlier gap when no later episode is available', async () => {
  const { nextEpisode } = await loadUtil();
  assert.equal(nextEpisode({
    episodes: ['1', '2', '3'],
    watchedEpisodes: ['1', '3'],
    lastWatched: '3',
  }), '2');
});

test('nextEpisode returns null when every listed episode is watched', async () => {
  const { nextEpisode } = await loadUtil();
  assert.equal(nextEpisode({
    episodes: ['1', '2'],
    watchedEpisodes: ['1', '2'],
    lastWatched: '2',
  }), null);
});

test('cacheStatusLabel distinguishes live, cached and offline data', async () => {
  const { cacheStatusLabel } = await loadUtil();
  assert.equal(cacheStatusLabel({ cache: { cached: false } }), 'live');
  assert.equal(cacheStatusLabel({ cache: { cached: true, ageSeconds: 7200 } }), 'cached 2h ago');
  assert.equal(cacheStatusLabel({ offline: true, offlineAgeSeconds: 180 }), 'offline cache · 3m ago');
});

test('matchesLibraryQuery matches name englishName and title case-insensitively', async () => {
  const { matchesLibraryQuery } = await loadUtil();
  const item = { name: 'Spy x Family', englishName: 'SPY×FAMILY', title: 'Spy Family (12 episodes)' };
  assert.equal(matchesLibraryQuery(item, ''), true);
  assert.equal(matchesLibraryQuery(item, 'spy'), true);
  assert.equal(matchesLibraryQuery(item, 'FAMILY'), true);
  assert.equal(matchesLibraryQuery(item, 'zzz'), false);
});

test('hasExactTitleMatch distinguishes broad results from an exact title', async () => {
  const { hasExactTitleMatch } = await loadUtil();
  assert.equal(hasExactTitleMatch([{ name: 'Attack on Titan' }], 'titan'), false);
  assert.equal(hasExactTitleMatch([{ title: 'Titan (12 episodes)' }], 'titan'), true);
  assert.equal(hasExactTitleMatch([{ alternativeTitles: ['Shingeki no Kyojin'] }], 'shingeki-no-kyojin'), true);
});

test('presentAnimeCard recomputes newCount from last watched and latest', async () => {
  const { presentAnimeCard } = await loadUtil();
  const presented = presentAnimeCard({
    id: 'a',
    watchedEpisodes: ['1', '2'],
    lastWatched: '2',
    latestEpisode: '5',
  });
  assert.equal(presented.newCount, 3);
  assert.equal(presented.watchedCount, 2);
});

test('presentMangaCard counts unread chapters when chapter list exists', async () => {
  const { presentMangaCard } = await loadUtil();
  const presented = presentMangaCard({
    id: 'm',
    chapters: ['1', '2', '3', '4'],
    readChapters: ['1', '2'],
    latestChapter: '4',
  });
  assert.equal(presented.newCount, 2);
  assert.equal(presented.lastRead, '2');
});

test('releasePills labels finished, ongoing, cancelled, and announced clearly', async () => {
  const { releasePills } = await loadUtil();
  const dash = '\u2013';
  const dot = '\u00b7';
  assert.deepEqual(releasePills({
    status: 'Finished',
    airedStart: { year: 2015, month: 6, date: 5 },
    airedEnd: { year: 2018, month: 2, date: 25 },
  }), [`2015${dash}2018 ${dot} Finished`]);
  assert.deepEqual(releasePills({
    status: 'Releasing',
    airedStart: { year: 2024, month: 0, date: 1 },
  }), ['Ongoing since 2024']);
  assert.deepEqual(releasePills({
    status: 'Cancelled',
    airedStart: { year: 2021, month: 0, date: 1 },
  }), [`2021 ${dot} Cancelled`]);
  assert.deepEqual(releasePills({
    status: 'Not Yet Released',
    airedStart: { year: 2027, month: 0, date: 1 },
  }), [`Announced ${dot} 2027`]);
  assert.deepEqual(releasePills({
    status: 'Hiatus',
    airedStart: { year: 2020, month: 0, date: 1 },
  }), [`Hiatus ${dot} since 2020`]);
  assert.deepEqual(releasePills({
    status: 'Currently Airing',
    airedStart: { year: 2026, month: 6, date: 25 },
  }), ['Ongoing since 2026']);
  assert.deepEqual(releasePills({
    status: 'Finished Airing',
    airedStart: { year: 2013, month: 3, date: 9 },
    airedEnd: { year: 2014, month: 8, date: 14 },
  }), [`2013${dash}2014 ${dot} Finished`]);
});

test('compareNewestActivity keeps the latest activity at the front', async () => {
  const { compareNewestActivity } = await loadUtil();
  const none = () => [];
  const items = [
    { name: 'Old', updatedAt: '2024-01-01T00:00:00.000Z' },
    { name: 'Newest', lastActivityAt: '2026-09-12 18:00:00' },
    { name: 'Mid', lastActivityAt: '2025-06-01T00:00:00.000Z' },
    { name: 'Missing' },
  ];
  assert.deepEqual(
    [...items].sort((a, b) => compareNewestActivity(a, b, none)).map((item) => item.name),
    ['Newest', 'Mid', 'Missing', 'Old'],
  );
});

test('compareNewestActivity prefers watch activity over a later metadata refresh', async () => {
  const { compareNewestActivity } = await loadUtil();
  const refreshed = { name: 'Refreshed', updatedAt: '2026-09-12T20:00:00.000Z', lastActivityAt: '2026-01-01T00:00:00.000Z' };
  const watched = { name: 'Watched', updatedAt: '2026-01-02T00:00:00.000Z', lastActivityAt: '2026-09-12T21:00:00.000Z' };
  const sorted = [refreshed, watched].sort((a, b) => compareNewestActivity(a, b, () => []));
  assert.equal(sorted[0].name, 'Watched');
});

test('recent sort ignores metadata refresh when a title has no lastActivityAt', async () => {
  const { compareNewestActivity } = await loadUtil();
  const refreshed = { name: 'Refreshed', updatedAt: '2026-09-13T01:00:00.000Z' };
  const watched = {
    name: 'Watched',
    updatedAt: '2026-01-01T00:00:00.000Z',
    lastActivityAt: '2026-09-12T12:00:00.000Z',
  };
  const sorted = [refreshed, watched].sort((a, b) => compareNewestActivity(a, b, () => []));
  assert.equal(sorted[0].name, 'Watched');
});

test('playbackPositionToSave keeps a remembered mid-episode time after the player is reset', async () => {
  const { playbackPositionToSave } = await loadUtil();
  assert.deepEqual(
    playbackPositionToSave(0, Number.NaN, { time: 720, duration: 1440 }),
    { position: 720, duration: 1440 },
  );
  assert.equal(playbackPositionToSave(0, 1440, { time: 0, duration: 1440 }), null);
  assert.deepEqual(
    playbackPositionToSave(400, 1440, { time: 12, duration: 1440 }),
    { position: 400, duration: 1440 },
  );
});

test('episodeTitle prefers stored names and falls back to a numbered label', async () => {
  const { episodeTitle } = await loadUtil();
  assert.equal(episodeTitle({ episodeTitles: { 1: "The Journey's End" } }, '1'), "The Journey's End");
  assert.equal(episodeTitle({ episodeTitles: {} }, '12'), 'Episode 12');
});
