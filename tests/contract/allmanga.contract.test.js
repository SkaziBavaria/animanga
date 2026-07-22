'use strict';

// Live contract for the locked manga chapterPages resolver. Opt-in only.
const test = require('node:test');
const assert = require('node:assert/strict');
const { searchManga, getChapterPages, resetMangaCryptoForTests } = require('../../lib/allmanga');

const opts = { skip: process.env.RUN_CONTRACT === '1' ? false : 'set RUN_CONTRACT=1 to run live contract tests' };

test.afterEach(() => resetMangaCryptoForTests());

test('AllManga chapter pages decrypt for One Piece chapter 1', opts, async () => {
  const search = await searchManga('one piece', { language: 'sub', limit: 1 });
  assert.ok(search.results?.length, 'expected a manga search hit');
  const mangaId = search.results[0].id;
  assert.ok(mangaId, 'expected manga id');

  const chapter = await getChapterPages(mangaId, '1', 'sub');
  assert.ok(chapter.pages.length > 0, 'expected at least one page');
  for (const page of chapter.pages) {
    assert.match(page.url, /^https?:\/\//i, `page URL should be absolute: ${page.url}`);
  }
});
