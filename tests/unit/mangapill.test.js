'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseSearchResults, parseChapterRows, parseChapterImages, getChapterPagesByTitle } = require('../../lib/mangapill');
const { setAnidbTextFetcherForTests } = require('../../lib/anidb-fetch');

test.afterEach(() => setAnidbTextFetcherForTests(null));

test('parses MangaPill search, chapters and reader images', () => {
  assert.deepEqual(parseSearchResults('<a href="/manga/12/demo-story"><img alt="Demo Story cover"></a>'), [
    { id: '12', slug: 'demo-story', name: 'Demo Story', path: '/manga/12/demo-story' },
  ]);
  assert.deepEqual(parseChapterRows('<a href="/chapters/12-10001000/demo-story-chapter-1">Chapter 1</a>'), [
    { path: '/chapters/12-10001000/demo-story-chapter-1', number: '1' },
  ]);
  assert.deepEqual(parseChapterImages('<img alt="Demo Chapter 1 Page 1" src="https://cdn.example/read/1.jpg">'), [
    { number: 1, url: 'https://cdn.example/read/1.jpg' },
  ]);
});

test('resolves MangaPill pages with a safe title match', async () => {
  setAnidbTextFetcherForTests(async (url) => {
    if (url.includes('/search?')) return '<a href="/manga/12/demo-story"><img alt="Demo Story cover"></a>';
    if (url.includes('/manga/')) return '<a href="/chapters/12-10001000/demo-story-chapter-1">Chapter 1</a>';
    return '<img alt="Demo Story Chapter 1 Page 1" src="https://cdn.example/read/1.jpg">';
  });
  const result = await getChapterPagesByTitle(['Demo Story'], '1');
  assert.equal(result.sourceName, 'MangaPill');
  assert.equal(result.pages[0].url, 'https://cdn.example/read/1.jpg');
});
