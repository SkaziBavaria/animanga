'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { searchManga, popularManga, getMangaDetails, setRawFetcher } = require('../../lib/allmanga');

test.afterEach(() => setRawFetcher());

test('searchManga maps AllManga results and normalizes cover urls', async () => {
  let receivedVariables;
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
    variables: (receivedVariables = variables),
  }));
  const result = await searchManga('English', { language: 'sub', sortBy: 'Trending', genres: ['Fantasy', 'Seinen'], year: 2024 });
  assert.equal(result.total, 1);
  assert.equal(result.results[0].name, 'English name');
  assert.equal(result.results[0].chapterCount, 12);
  assert.deepEqual(result.results[0].chapterCounts, { sub: 12, raw: 0 });
  assert.equal(result.results[0].thumbnail, 'https://aln.youtube-anime.com/mcovers/one.webp');
  assert.deepEqual(receivedVariables.search, {
    allowAdult: false,
    allowUnknown: false,
    sortBy: 'Trending',
    sortDirection: 'DSC',
    isManga: true,
    query: 'English',
    genres: ['Fantasy', 'Seinen'],
    includeGenres: true,
    year: 2024,
  });
});

test('popularManga uses the dedicated manga ranking with its date range', async () => {
  let receivedVariables;
  setRawFetcher(async (_query, variables) => {
    receivedVariables = variables;
    return { data: { queryPopular: { total: 1, recommendations: [{ isManga: true, anyCard: { _id: 'm1', name: 'Weekly pick', availableChapters: { sub: 2 } } }] } } };
  });
  const result = await popularManga(7, { limit: 5 });
  assert.deepEqual(receivedVariables, { type: 'manga', size: 5, dateRange: 7 });
  assert.equal(result.results[0].name, 'Weekly pick');
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

test('getMangaDetails resolves related manga metadata in one follow-up query', async () => {
  setRawFetcher(async (query) => query.includes('r0: manga') ? {
    data: {
      r0: {
        _id: 'm2',
        name: 'The Sequel',
        thumbnail: 'mcovers/sequel.webp',
        availableChapters: { sub: 4 },
        status: 'Releasing',
      },
    },
  } : {
    data: {
      manga: {
        _id: 'm1',
        name: 'Story',
        availableChaptersDetail: { sub: ['1'] },
        relatedMangas: [{ relation: 'sequel', mangaId: 'm2' }],
      },
    },
  });
  const manga = await getMangaDetails('m1');
  assert.deepEqual(manga.relations, [{
    id: 'm2',
    name: 'The Sequel',
    sourceName: 'The Sequel',
    englishName: '',
    nativeName: '',
    thumbnail: 'https://aln.youtube-anime.com/mcovers/sequel.webp',
    language: 'sub',
    chapterCounts: { sub: 4, raw: 0 },
    latestChapters: { sub: null, raw: null },
    lastChapterDates: { sub: null, raw: null },
    chapterCount: 4,
    latestChapter: null,
    lastChapterDate: null,
    score: null,
    type: 'Manga',
    status: 'Releasing',
    airedStart: null,
    airedEnd: null,
    season: null,
    countryOfOrigin: '',
    title: 'The Sequel (4 chapters)',
    relation: 'sequel',
  }]);
});
