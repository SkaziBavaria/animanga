'use strict';

// Live contract for the ComicK catalog and Weeb Central page resolver. Opt-in only.
const test = require('node:test');
const assert = require('node:assert/strict');
const { searchManga, getMangaDetails, getChapterPages } = require('../../lib/allmanga');

const opts = { skip: process.env.RUN_CONTRACT === '1' ? false : 'set RUN_CONTRACT=1 to run live contract tests' };

test('ComicK + Weeb Central chapter pages resolve for a catalog hit', opts, async () => {
  const search = await searchManga('Naruto', { limit: 10 });
  const manga = search.results.find((item) => item.id && item.name.toLowerCase() === 'naruto');
  assert.ok(manga?.id, 'expected Naruto in ComicK search results');

  const details = await getMangaDetails(manga.id, { includeRelations: false });
  const chapterEntry = details.chapters.find((item) => String(item) === '1');
  assert.ok(chapterEntry, 'expected chapter 1 in the ComicK chapter list');

  const chapterString = String(chapterEntry);
  const chapter = await getChapterPages(manga.id, chapterString);
  assert.ok(chapter.pages.length > 0, 'expected at least one page');
  for (const page of chapter.pages) {
    assert.match(page.url, /^https?:\/\//i, `page URL should be absolute: ${page.url}`);
  }
});
