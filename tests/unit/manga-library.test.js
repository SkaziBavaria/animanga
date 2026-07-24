'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  mergeManga,
  presentManga,
  presentMangaReleaseWatch,
  createMangaReleaseWatch,
  checkMangaReleaseWatch,
} = require('../../lib/manga-library');
const { setRawFetcher } = require('../../lib/allmanga');

test.afterEach(() => setRawFetcher());

test('mergeManga preserves read chapters while refreshing metadata', () => {
  const state = { mangas: { m1: { id: 'm1', name: 'Old', readChapters: ['1'], archived: true } } };
  const manga = mergeManga(state, { id: 'm1', name: 'New', chapters: ['1', '2'] });
  assert.equal(manga.name, 'New');
  assert.deepEqual(manga.readChapters, ['1']);
  assert.equal(manga.archived, true);
});

test('mergeManga defaults archived to false and accepts archive updates', () => {
  const state = { mangas: {} };
  const created = mergeManga(state, { id: 'm2', name: 'Fresh' });
  assert.equal(created.archived, false);
  assert.equal(mergeManga(state, { id: 'm2', archived: true }).archived, true);
});

test('presentManga calculates the latest reading state', () => {
  const manga = presentManga({ id: 'm1', chapters: ['1', '2', '3'], readChapters: ['1', '2'] });
  assert.equal(manga.lastRead, '2');
  assert.equal(manga.latestChapter, '3');
  assert.equal(manga.newCount, 1);
});

test('creates stable manga release watches from normalized queries', () => {
  const state = { mangaReleaseWatches: {} };
  const first = createMangaReleaseWatch(state, '  Future   Story  ', 'sub');
  const second = createMangaReleaseWatch(state, 'future story', 'sub');
  assert.equal(first.id, second.id);
  assert.equal(Object.keys(state.mangaReleaseWatches).length, 1);
  assert.deepEqual(presentMangaReleaseWatch(first), {
    id: first.id,
    query: 'Future Story',
    language: 'sub',
    status: 'watching',
    createdAt: first.createdAt,
    updatedAt: first.updatedAt,
    lastCheckedAt: null,
    foundAt: null,
    matchedManga: null,
  });
});

test('marks a manga release watch found when search starts returning a manga', async () => {
  setRawFetcher(async () => ({
    data: {
      mangas: {
        pageInfo: { total: 1 },
        edges: [{
          _id: 'future-1',
          name: 'Future Story',
          availableChapters: { sub: 1 },
          lastChapterInfo: { sub: { chapterString: '1' } },
        }],
      },
    },
  }));
  const state = { mangaReleaseWatches: {} };
  const watch = createMangaReleaseWatch(state, 'Future Story', 'sub');
  const checked = await checkMangaReleaseWatch(state, watch);
  assert.equal(checked.status, 'found');
  assert.equal(checked.matchedManga.id, 'future-1');
  assert.ok(checked.foundAt);
  assert.ok(checked.lastCheckedAt);
});
