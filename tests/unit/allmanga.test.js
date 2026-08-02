'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { searchManga, popularManga, getMangaDetails, setRawFetcher } = require('../../lib/allmanga');

test.afterEach(() => setRawFetcher());

test('searchManga maps ComicK results', async () => {
  let path;
  setRawFetcher(async (requestPath) => {
    path = requestPath;
    return [{
      hid: '1J46csio',
      slug: 'naruto',
      title: 'Naruto',
      rating: '8.4',
      bayesian_rating: '8.31',
      last_chapter: 700,
      chapter_count: 700,
      status: 2,
      country: 'jp',
      year: 1999,
      cover_url: 'https://meo.comick.pictures/2zB1b-s.jpg',
      md_titles: [{ title: 'Naruto', lang: 'en' }],
    }];
  });
  const result = await searchManga('naruto', { language: 'sub', sortBy: 'Trending' });
  assert.match(path, /\/v1\.0\/search\//);
  assert.match(path, /q=naruto/);
  assert.equal(result.results[0].id, 'naruto');
  assert.equal(result.results[0].name, 'Naruto');
  assert.equal(result.results[0].status, 'Finished');
  assert.equal(result.results[0].provider, 'comick');
});

test('searchManga prefers an English title that matches the ComicK slug', async () => {
  setRawFetcher(async () => [{
    hid: 'solo',
    slug: '00-solo-leveling',
    title: 'I am the only the one who levels up',
    md_titles: [
      { lang: 'en', title: 'Only I Level Up' },
      { lang: 'en', title: 'Solo Leveling' },
    ],
  }]);
  const result = await searchManga('solo leveling');
  assert.equal(result.results[0].name, 'Solo Leveling');
  assert.equal(result.results[0].sourceName, 'I am the only the one who levels up');
});

test('popularManga maps ranges onto ComicK sorts', async () => {
  let path;
  setRawFetcher(async (requestPath) => {
    path = requestPath;
    return [{
      hid: 'abc',
      slug: 'solo-leveling',
      title: 'Solo Leveling',
      last_chapter: 200,
      status: 2,
      country: 'kr',
    }];
  });
  const result = await popularManga(7, { limit: 5 });
  assert.match(path, /sort=uploaded/);
  assert.equal(result.results[0].name, 'Solo Leveling');
});

test('getMangaDetails sorts chapters and exposes manga metadata', async () => {
  setRawFetcher(async (requestPath) => {
    if (requestPath.includes('/chapters')) {
      return {
        chapters: [
          { chap: '3', hid: 'c3' },
          { chap: '1', hid: 'c1' },
          { chap: '2.5', hid: 'c25' },
        ],
      };
    }
    return {
      comic: {
        hid: 'h1',
        slug: 'story',
        title: 'Story',
        status: 1,
        last_chapter: 3,
        desc: 'Once upon a time',
        cover_url: 'https://meo.comick.pictures/x.jpg',
        md_comic_md_genres: [{ md_genres: { name: 'Drama' } }],
      },
      authors: [{ name: 'Author' }],
      artists: [],
    };
  });
  const manga = await getMangaDetails('story');
  assert.deepEqual(manga.chapters, ['1', '2.5', '3']);
  assert.equal(manga.latestChapter, '3');
  assert.deepEqual(manga.authors, ['Author']);
  assert.deepEqual(manga.genres, ['Drama']);
});

test('getMangaDetails can skip related manga lookups for chapter lists', async () => {
  let chapterCalls = 0;
  setRawFetcher(async (requestPath) => {
    if (requestPath.includes('/chapters')) {
      chapterCalls += 1;
      return { chapters: [{ chap: '1' }, { chap: '2' }] };
    }
    return {
      comic: {
        hid: 'h1',
        slug: 'story',
        title: 'Story',
        status: 1,
        recommendations: [{ hid: 'other', title: 'Other', rel: 'sequel' }],
      },
      authors: [],
      artists: [],
    };
  });
  const manga = await getMangaDetails('story', 'sub', { includeRelations: false });
  assert.equal(chapterCalls, 1);
  assert.deepEqual(manga.chapters, ['1', '2']);
  assert.deepEqual(manga.relations, []);
});
