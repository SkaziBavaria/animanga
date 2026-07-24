'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

async function loadUtil() {
  const source = fs.readFileSync(path.join(__dirname, '../../public/js/util.js'), 'utf8');
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}

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
});
