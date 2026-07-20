'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { searchManga, getMangaDetails, setRawFetcher } = require('../../lib/allmanga');

test.afterEach(() => setRawFetcher());

test('searchManga maps AllManga results and normalizes cover urls', async () => {
  setRawFetcher(async (_query, variables) => ({
    data: {
      mangas: {
        pageInfo: { total: 1 },
        edges: [{
          _id: 'm1',
          name: 'Raw name',
          englishName: 'English name',
          thumbnail: 'mcovers/one.webp',
          availableChapters: { sub: 12 },
          lastChapterInfo: { sub: { chapterString: '12' } },
        }],
      },
    },
    variables,
  }));
  const result = await searchManga('English', { language: 'sub' });
  assert.equal(result.total, 1);
  assert.equal(result.results[0].name, 'English name');
  assert.equal(result.results[0].chapterCount, 12);
  assert.equal(result.results[0].thumbnail, 'https://aln.youtube-anime.com/mcovers/one.webp');
});

test('getMangaDetails sorts chapters and exposes manga metadata', async () => {
  setRawFetcher(async () => ({
    data: {
      manga: {
        _id: 'm1',
        name: 'Story',
        availableChapters: { sub: 3 },
        availableChaptersDetail: { sub: ['3', '1', '2.5'] },
        authors: ['Author'],
        genres: ['Drama'],
        status: 'Releasing',
      },
    },
  }));
  const manga = await getMangaDetails('m1');
  assert.deepEqual(manga.chapters, ['1', '2.5', '3']);
  assert.equal(manga.latestChapter, '3');
  assert.deepEqual(manga.authors, ['Author']);
});
