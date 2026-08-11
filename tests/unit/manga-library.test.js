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

test('presentManga newCount ignores unread gaps behind the furthest chapter', () => {
  const manga = presentManga({ id: 'm1', chapters: ['1', '2', '3', '4', '5'], readChapters: ['1', '2', '4'] });
  assert.equal(manga.lastRead, '4');
  assert.equal(manga.newCount, 1);
});

test('creates stable manga release watches from normalized queries', () => {
  const state = { mangaReleaseWatches: {} };
  const first = createMangaReleaseWatch(state, '  Future   Story  ');
  const second = createMangaReleaseWatch(state, 'future story');
  assert.equal(first.id, second.id);
  assert.equal(Object.keys(state.mangaReleaseWatches).length, 1);
  assert.deepEqual(presentMangaReleaseWatch(first), {
    id: first.id,
    query: 'Future Story',
    status: 'watching',
    createdAt: first.createdAt,
    updatedAt: first.updatedAt,
    lastCheckedAt: null,
    foundAt: null,
    matchedManga: null,
  });
});

test('marks a manga release watch found when search starts returning a manga', async () => {
  setRawFetcher(async () => ([{
    hid: 'futureHid1',
    slug: 'future-1',
    title: 'Future Story',
    last_chapter: 1,
    chapter_count: 1,
    status: 1,
  }]));
  const state = { mangaReleaseWatches: {} };
  const watch = createMangaReleaseWatch(state, 'Future Story');
  const checked = await checkMangaReleaseWatch(state, watch);
  assert.equal(checked.status, 'found');
  assert.equal(checked.matchedManga.id, 'future-1');
  assert.ok(checked.foundAt);
  assert.ok(checked.lastCheckedAt);
});
