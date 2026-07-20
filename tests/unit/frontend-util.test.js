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
