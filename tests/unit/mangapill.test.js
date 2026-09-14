'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseSearchResults, parseChapterRows, parseChapterImages, getChapterPagesByTitle } = require('../../lib/mangapill');
const { setTextFetcherForTests } = require('../../lib/web-fetch');

test.afterEach(() => setTextFetcherForTests(null));

test('parses MangaPill search, chapters and reader images', () => {
  assert.deepEqual(parseSearchResults('<a href="/manga/12/demo-story"><img alt="Demo Story cover"></a>'), [
    { id: '12', slug: 'demo-story', name: 'Demo Story', path: '/manga/12/demo-story' },
  ]);
  assert.deepEqual(parseChapterRows('<a href="/chapters/12-10001000/demo-story-chapter-1">Chapter 1</a>'), [
    { path: '/chapters/12-10001000/demo-story-chapter-1', number: '1' },
  ]);
  assert.deepEqual(parseChapterImages('<picture><img alt="Demo Chapter 1 Page 1" data-src="https://cdn.example/read/1.jpg"></picture>'), [
    { number: 1, url: 'https://cdn.example/read/1.jpg' },
  ]);
});

test('resolves MangaPill pages with a safe title match', async () => {
  setTextFetcherForTests(async (url) => {
    if (url.includes('/search?')) return '<a href="/manga/12/demo-story"><img alt="Demo Story cover"></a>';
    if (url.includes('/manga/')) return '<a href="/chapters/12-10001000/demo-story-chapter-1">Chapter 1</a>';
    return '<picture><img alt="Demo Story Chapter 1 Page 1" data-src="https://cdn.example/read/1.jpg"></picture>';
  });
  const result = await getChapterPagesByTitle(['Demo Story'], '1');
  assert.equal(result.sourceName, 'MangaPill');
  assert.equal(result.pages[0].url, 'https://cdn.example/read/1.jpg');
});

test('reader ignores banners and placeholders and preserves lazy page order', () => {
  const html = '<img src="https://cdn.example/banner.jpg"><picture><img data-src="https://cdn.example/1.jpg" src="https://cdn.example/placeholder.jpg"></picture><picture><img src="placeholder" data-src="https://cdn.example/2.jpg"></picture><picture><img data-src="https://cdn.example/1.jpg"></picture>';
  assert.deepEqual(parseChapterImages(html).map((page) => page.url), ['https://cdn.example/1.jpg', 'https://cdn.example/2.jpg']);
  assert.deepEqual(parseChapterImages('<picture><img data-src="javascript:bad"></picture>'), []);
});

test('MangaPill rejects wrong titles before requesting pages', async () => {
  setTextFetcherForTests(async () => '<a href="/manga/12/other"><img alt="Unrelated Work cover"></a>');
  await assert.rejects(getChapterPagesByTitle(['Demo Story'], '1'), /No safe MangaPill match/);
});
