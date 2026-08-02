'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { migrateMangaEntry, pickBestMatch } = require('../../lib/comick-migrate');

test('title matching selects a dynamic ComicK result', () => {
  const match = pickBestMatch(
    { name: 'Solo Leveling' },
    [{ id: 'other', name: 'Leveling With the Gods' }, { id: '00-solo-leveling', name: 'Solo Leveling' }],
  );
  assert.equal(match.id, '00-solo-leveling');
});

test('migration preserves reading history, positions and release-watch references', async () => {
  const state = {
    mangas: {
      legacy123: { id: 'legacy123', name: 'A Story', readChapters: ['1', '2'], tracked: true },
      'a-story': { id: 'a-story', name: 'A Story', provider: 'comick', readChapters: ['3'], archived: true },
    },
    mangaPositions: {
      'legacy123:sub:4': { mangaId: 'legacy123', language: 'sub', chapter: '4', page: 7 },
    },
    mangaReleaseWatches: {
      watch1: { id: 'watch1', matchedManga: { id: 'legacy123', name: 'A Story' } },
    },
  };
  const search = async () => ({ results: [{ id: 'a-story', name: 'A Story', provider: 'comick' }] });
  const result = await migrateMangaEntry(state, state.mangas.legacy123, { search });
  assert.equal(result.to, 'a-story');
  assert.equal(state.mangas.legacy123, undefined);
  assert.deepEqual(state.mangas['a-story'].readChapters, ['1', '2', '3']);
  assert.equal(state.mangas['a-story'].archived, true);
  assert.equal(state.mangaPositions['legacy123:sub:4'], undefined);
  assert.equal(state.mangaPositions['a-story:sub:4'].mangaId, 'a-story');
  assert.equal(state.mangaReleaseWatches.watch1.matchedManga.id, 'a-story');
});

test('unmatched legacy manga remains available and marked for retry', async () => {
  const state = { mangas: { old: { id: 'old', name: 'Unknown', readChapters: ['5'] } } };
  const result = await migrateMangaEntry(state, state.mangas.old, { search: async () => ({ results: [] }) });
  assert.equal(result.needsRematch, true);
  assert.deepEqual(state.mangas.old.readChapters, ['5']);
  assert.equal(state.mangas.old.needsRematch, true);
});
