'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mergeManga, presentManga } = require('../../lib/manga-library');

test('mergeManga preserves read chapters while refreshing metadata', () => {
  const state = { mangas: { m1: { id: 'm1', name: 'Old', readChapters: ['1'] } } };
  const manga = mergeManga(state, { id: 'm1', name: 'New', chapters: ['1', '2'] });
  assert.equal(manga.name, 'New');
  assert.deepEqual(manga.readChapters, ['1']);
});

test('presentManga calculates the latest reading state', () => {
  const manga = presentManga({ id: 'm1', chapters: ['1', '2', '3'], readChapters: ['1', '2'] });
  assert.equal(manga.lastRead, '2');
  assert.equal(manga.latestChapter, '3');
  assert.equal(manga.newCount, 1);
});
