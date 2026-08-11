'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseSearchResults, parseChapterRows, parseReaderPagePaths, parseViewerImage, getChapterPagesByTitle,
} = require('../../lib/mangatown');
const { setAnidbTextFetcherForTests } = require('../../lib/anidb-fetch');

test.afterEach(() => setAnidbTextFetcherForTests(null));

test('parses MangaTown search, decimal chapters and paged readers', () => {
  assert.deepEqual(parseSearchResults(`
    <a class="manga_cover" href="/manga/demo_story/" title="Demo Story"><img></a>
    <a class="manga_cover" href="/manga/demo_story_side/" title="Demo Story Side"></a>`), [
    { id: 'demo_story', name: 'Demo Story', path: '/manga/demo_story/' },
    { id: 'demo_story_side', name: 'Demo Story Side', path: '/manga/demo_story_side/' },
  ]);
  assert.deepEqual(parseChapterRows(`
    <ul class="chapter_list">
      <li><a href="/manga/demo_story/c011.5/">Demo Story 11.5</a></li>
      <li><a href="/manga/demo_story/c000/">Demo Story 0</a></li>
    </ul>`), [
    { path: '/manga/demo_story/c011.5/', number: '11.5' },
    { path: '/manga/demo_story/c000/', number: '0' },
  ]);
  assert.deepEqual(parseReaderPagePaths(`
    <option value="/manga/demo_story/c011.5/1.html">1</option>
    <option value="/manga/demo_story/c011.5/2.html">2</option>
    <option value="/manga/demo_story/c011.5/featured.html">Featured</option>`), [
    '/manga/demo_story/c011.5/1.html', '/manga/demo_story/c011.5/2.html',
  ]);
  assert.equal(parseViewerImage('<div id="viewer"><img src="//cdn.example/page-1.jpg"></div>'), 'https://cdn.example/page-1.jpg');
});

test('resolves MangaTown pages with a safe title match and bounded page URLs', async () => {
  const calls = [];
  setAnidbTextFetcherForTests(async (url) => {
    calls.push(url);
    if (url.includes('/search?')) {
      return '<a class="manga_cover" href="/manga/demo_story/" title="Demo Story"></a>';
    }
    if (url.endsWith('/manga/demo_story/')) {
      return '<ul class="chapter_list"><li><a href="/manga/demo_story/c001/">Demo Story 1</a></li></ul>';
    }
    if (url.endsWith('/manga/demo_story/c001/')) {
      return `<div class="page_select">
        <option value="/manga/demo_story/c001/2.html">2</option>
        <option value="/manga/demo_story/c001/3.html">3</option>
      </div><div id="viewer"><img src="https://cdn.example/1.jpg"></div>`;
    }
    if (url.endsWith('/2.html')) return '<div id="viewer"><img src="https://cdn.example/2.jpg"></div>';
    if (url.endsWith('/3.html')) return '<div id="viewer"><img src="https://cdn.example/3.jpg"></div>';
    throw new Error(`Unexpected request ${url}`);
  });
  const result = await getChapterPagesByTitle(['Demo Story'], '1');
  assert.equal(result.sourceName, 'MangaTown');
  assert.deepEqual(result.pages.map((page) => page.url), [
    'https://cdn.example/1.jpg', 'https://cdn.example/2.jpg', 'https://cdn.example/3.jpg',
  ]);
  assert.equal(calls.filter((url) => url.endsWith('/1.html')).length, 0);
});

test('rejects an unrelated MangaTown search result', async () => {
  setAnidbTextFetcherForTests(async () => (
    '<a class="manga_cover" href="/manga/solo_leveling/" title="Solo Leveling"></a>'
  ));
  await assert.rejects(getChapterPagesByTitle(['Demo Story'], '1'), /No safe MangaTown match/);
});
