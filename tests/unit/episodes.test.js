'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  cleanTitle,
  aniCliQueryTitle,
  parseEpisodeCount,
  preferredName,
  normalizeMode,
  normalizeEpisode,
  episodesThrough,
  compareEpisodes,
  highestEpisode,
} = require('../../lib/episodes');

test('cleanTitle strips the episode-count suffix', () => {
  assert.equal(cleanTitle('Bleach (366 episodes)'), 'Bleach');
  assert.equal(cleanTitle('One Piece (1 episode)'), 'One Piece');
  assert.equal(cleanTitle('  Naruto  '), 'Naruto');
});

test('aniCliQueryTitle prefers english then name then title', () => {
  assert.equal(aniCliQueryTitle({ englishName: 'Attack on Titan', name: 'Shingeki' }), 'Attack on Titan');
  assert.equal(aniCliQueryTitle({ name: 'Shingeki no Kyojin' }), 'Shingeki no Kyojin');
  assert.equal(aniCliQueryTitle({ title: 'Bleach (12 episodes)' }), 'Bleach');
});

test('parseEpisodeCount extracts the number', () => {
  assert.equal(parseEpisodeCount('Bleach (366 episodes)'), 366);
  assert.equal(parseEpisodeCount('No count here'), null);
});

test('preferredName honours customName override', () => {
  assert.equal(preferredName({ customName: 'My Name', name: 'Other' }), 'My Name');
  assert.equal(preferredName({ name: 'Fallback' }), 'Fallback');
});

test('normalizeMode only allows sub or dub', () => {
  assert.equal(normalizeMode('dub'), 'dub');
  assert.equal(normalizeMode('sub'), 'sub');
  assert.equal(normalizeMode('anything'), 'sub');
  assert.equal(normalizeMode(undefined), 'sub');
});

test('compareEpisodes sorts numerically then lexically', () => {
  assert.deepEqual(['10', '2', '1'].sort(compareEpisodes), ['1', '2', '10']);
  assert.deepEqual(['1', '1.5', '2'].sort(compareEpisodes), ['1', '1.5', '2']);
});

test('episodesThrough returns all episodes up to and including target', () => {
  assert.deepEqual(episodesThrough(['1', '2', '3', '4'], '3'), ['1', '2', '3']);
});

test('episodesThrough synthesises a range when episode list is empty', () => {
  assert.deepEqual(episodesThrough([], '3'), ['1', '2', '3']);
});

test('normalizeEpisode trims to a string', () => {
  assert.equal(normalizeEpisode(' 5 '), '5');
  assert.equal(normalizeEpisode(null), '');
});

test('highestEpisode returns the largest episode', () => {
  assert.equal(highestEpisode(['1', '2', '10', '3']), '10');
  assert.equal(highestEpisode([]), null);
});
