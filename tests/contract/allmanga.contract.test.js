'use strict';

// Live contract for manga chapterPages decryption. Opt-in only.
const test = require('node:test');
const assert = require('node:assert/strict');
const { popularManga, getChapterPages, resetMangaCryptoForTests } = require('../../lib/allmanga');

const opts = { skip: process.env.RUN_CONTRACT === '1' ? false : 'set RUN_CONTRACT=1 to run live contract tests' };

test.afterEach(() => resetMangaCryptoForTests());

test('AllManga chapter pages decrypt for a catalog hit', opts, async () => {
  const popular = await popularManga(0, { language: 'sub', limit: 10 });
  const manga = popular.results.find((item) => item.id && (item.latestChapters?.sub || item.chapterCount > 0))
    || popular.results[0];
  assert.ok(manga?.id, 'expected a manga id from the popular list');

  const chapterString = String(manga.latestChapters?.sub || '1');
  const chapter = await getChapterPages(manga.id, chapterString, 'sub');
  assert.ok(chapter.pages.length > 0, 'expected at least one page');
  for (const page of chapter.pages) {
    assert.match(page.url, /^https?:\/\//i, `page URL should be absolute: ${page.url}`);
  }
});
