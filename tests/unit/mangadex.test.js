'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseSearchResults, parseChapterRows, parseAtHomePages, getChapterPagesByTitle,
} = require('../../lib/mangadex');
const { setAnidbTextFetcherForTests } = require('../../lib/anidb-fetch');

test.afterEach(() => setAnidbTextFetcherForTests(null));

test('parses MangaDex titles, chapters and at-home pages', () => {
  assert.deepEqual(parseSearchResults({ data: [{
    id: 'manga-1',
    attributes: { title: { en: 'Demo Story' }, altTitles: [{ ja: 'Demo JP' }] },
  }] }), [{ id: 'manga-1', name: 'Demo Story', names: ['Demo Story', 'Demo JP'] }]);
  assert.deepEqual(parseChapterRows({ data: [{
    id: 'chapter-1', attributes: { chapter: '1', translatedLanguage: 'en' },
  }] }), [{ id: 'chapter-1', number: '1', translatedLanguage: 'en' }]);
  assert.deepEqual(parseAtHomePages({
    baseUrl: 'https://uploads.example', chapter: { hash: 'abc', data: ['1.jpg', '2.jpg'] },
  }), [
    { number: 1, url: 'https://uploads.example/data/abc/1.jpg' },
    { number: 2, url: 'https://uploads.example/data/abc/2.jpg' },
  ]);
});

test('resolves English MangaDex chapter pages after a safe alias match', async () => {
  const calls = [];
  setAnidbTextFetcherForTests(async (url) => {
    calls.push(url);
    if (url.includes('/manga?')) return JSON.stringify({ data: [{
      id: 'manga-1', attributes: { title: { en: 'Demo Story' }, altTitles: [] },
    }] });
    if (url.includes('/feed?')) return JSON.stringify({ total: 1, data: [{
      id: 'chapter-1', attributes: { chapter: '1', translatedLanguage: 'en' },
    }] });
    return JSON.stringify({ baseUrl: 'https://uploads.example', chapter: { hash: 'abc', data: ['1.jpg'] } });
  });
  const result = await getChapterPagesByTitle(['Demo Story'], '1', 'sub');
  assert.equal(result.sourceName, 'MangaDex');
  assert.equal(result.pages[0].url, 'https://uploads.example/data/abc/1.jpg');
  assert.match(calls.find((url) => url.includes('/feed?')), /translatedLanguage%5B%5D=en/);
});

test('rejects an unrelated MangaDex search result', async () => {
  setAnidbTextFetcherForTests(async () => JSON.stringify({ data: [{
    id: 'solo', attributes: { title: { en: 'Solo Leveling' }, altTitles: [] },
  }] }));
  await assert.rejects(getChapterPagesByTitle(['Demo Story'], '1'), /No safe MangaDex match/);
});
