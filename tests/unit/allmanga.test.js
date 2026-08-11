'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  searchManga, popularManga, getMangaDetails, getChapterPages, assertComicIdentity,
  setRawFetcher, setPageResolversForTests,
  DEFAULT_PAGE_RESOLVER_NAMES,
} = require('../../lib/allmanga');

test.afterEach(() => {
  setRawFetcher();
  setPageResolversForTests();
});

test('uses the maintained manga resolver fallback order', () => {
  assert.deepEqual(DEFAULT_PAGE_RESOLVER_NAMES, ['Weeb Central', 'MangaPill', 'MangaDex', 'MangaTown']);
});

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
  const result = await searchManga('naruto', { sortBy: 'Trending' });
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
  const manga = await getMangaDetails('story', { includeRelations: false });
  assert.equal(chapterCalls, 1);
  assert.deepEqual(manga.chapters, ['1', '2']);
  assert.deepEqual(manga.relations, []);
});

test('chapter pages fall back after a resolver rejects the title', async () => {
  setRawFetcher(async () => ({
    comic: { hid: 'h1', slug: 'demo-story', title: 'Demo Story', md_titles: [] },
  }));
  const calls = [];
  setPageResolversForTests([
    async () => { calls.push('primary'); throw new Error('No safe primary match'); },
    async () => {
      calls.push('fallback');
      return { resolvedTitle: 'Demo Story', pages: [{ number: 1, url: 'https://cdn.example/1.jpg' }] };
    },
  ]);
  const result = await getChapterPages('demo-story', '1');
  assert.deepEqual(calls, ['primary', 'fallback']);
  assert.equal(result.pages[0].url, 'https://cdn.example/1.jpg');
  assert.equal(result.catalogRequestId, 'demo-story');
  assert.equal(result.catalogHid, 'h1');
});

test('ComicK payload identity accepts only the requested slug or hid', () => {
  const payload = { comic: { hid: 'hid-1', slug: 'demo-story' } };
  assert.equal(assertComicIdentity('demo-story', payload), payload);
  assert.equal(assertComicIdentity('hid-1', payload), payload);
  assert.throws(() => assertComicIdentity('another-story', payload), /identity mismatch/);
});

test('ComicK fallback rejects the first unrelated search result', async () => {
  setRawFetcher(async (requestPath) => {
    if (requestPath.includes('/v1.0/search/')) {
      return [{ hid: 'solo', slug: 'solo-leveling', title: 'Solo Leveling' }];
    }
    return { comic: { hid: 'dress', slug: 'my-dress-up-darling', title: 'My Dress-Up Darling' } };
  });
  await assert.rejects(getChapterPages('married-man', '1'), /exact search match missing/);
});

test('ComicK fallback accepts an exact search identity and revalidates its details', async () => {
  let detailCalls = 0;
  setRawFetcher(async (requestPath) => {
    if (requestPath.includes('/v1.0/search/')) {
      return [{ hid: 'hid-1', slug: 'demo-story', title: 'Demo Story' }];
    }
    detailCalls += 1;
    if (detailCalls === 1) throw new Error('temporary detail failure');
    return { comic: { hid: 'hid-1', slug: 'demo-story', title: 'Demo Story', md_titles: [] } };
  });
  setPageResolversForTests([async () => ({
    resolvedTitle: 'Demo Story', pages: [{ number: 1, url: 'https://cdn.example/1.jpg' }],
  })]);
  const result = await getChapterPages('demo-story', '1');
  assert.equal(result.catalogSlug, 'demo-story');
});

test('resolver chain rejects a provider result bound to an unrelated title', async () => {
  setRawFetcher(async () => ({
    comic: { hid: 'hid-1', slug: 'demo-story', title: 'Demo Story', md_titles: [] },
  }));
  setPageResolversForTests([async () => ({
    resolvedTitle: 'Solo Leveling', pages: [{ number: 1, url: 'https://cdn.example/1.jpg' }],
  })]);
  await assert.rejects(getChapterPages('demo-story', '1'), /resolved title did not match/);
});
