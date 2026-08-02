'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseSearchResults, parseChapterRows, parseChapterImages, getChapterPagesByTitle, resetForTests,
} = require('../../lib/weebcentral');
const { setAnidbTextFetcherForTests } = require('../../lib/anidb-fetch');

test.afterEach(() => {
  resetForTests();
  setAnidbTextFetcherForTests(null);
});

test('parseSearchResults extracts Weeb Central titles', () => {
  const html = `<a href="https://weebcentral.com/series/01ABC/Naruto"><img src="cover.jpg" alt="Naruto cover"></a>`;
  assert.deepEqual(parseSearchResults(html), [{ id: '01ABC', slug: 'Naruto', name: 'Naruto' }]);
});

test('parseSearchResults decodes entities only once', () => {
  const results = parseSearchResults('<a href="https://weebcentral.com/series/ABC/title"><img alt="Fish &amp; Chips &amp;quot;Special&amp;quot; cover"></a>');
  assert.equal(results[0].name, 'Fish & Chips &quot;Special&quot;');
});

test('parseChapterRows extracts chapter ids and decimal numbers', () => {
  const html = `
    <a href="/chapters/01FIRST"><span><span>Chapter 1</span></span></a>
    <a href="/chapters/01SECOND"><span><span>Episode 35.5</span></span></a>`;
  assert.deepEqual(parseChapterRows(html), [
    { chapterId: '01FIRST', number: '1' },
    { chapterId: '01SECOND', number: '35.5' },
  ]);
});

test('parseChapterImages keeps reader images and removes page furniture', () => {
  const html = `
    <img src="https://weebcentral.com/static/images/brand.png">
    <img src="https://cdn.example/manga/0001-001.png">
    <img data-src="https://cdn.example/manga/0001-002.webp">`;
  assert.deepEqual(parseChapterImages(html).map((page) => page.url), [
    'https://cdn.example/manga/0001-001.png',
    'https://cdn.example/manga/0001-002.webp',
  ]);
});

test('chapter resolution caches title and chapter-list requests', async () => {
  const calls = [];
  setAnidbTextFetcherForTests(async (url) => {
    calls.push(url);
    if (url.includes('/search/simple')) {
      return '<a href="https://weebcentral.com/series/01ABC/Demo"><img alt="Demo cover"></a>';
    }
    if (url.includes('/full-chapter-list')) {
      return '<a href="/chapters/01CH"><span>Episode 1</span></a>';
    }
    return '<img src="https://cdn.example/demo-1.png">';
  });
  const first = await getChapterPagesByTitle(['Demo', 'Demo Alias'], '1');
  const second = await getChapterPagesByTitle(['Demo', 'Demo Alias'], '1');
  assert.equal(first.pages.length, 1);
  assert.equal(second.pages.length, 1);
  assert.equal(calls.filter((url) => url.includes('/search/simple')).length, 1);
  assert.equal(calls.filter((url) => url.includes('/full-chapter-list')).length, 1);
});
