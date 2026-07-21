'use strict';

const { test, expect } = require('@playwright/test');
const { installApiMocks } = require('./fixtures');

test.describe('Manga', () => {
  test.beforeEach(async ({ page }) => {
    await installApiMocks(page);
    await page.goto('/');
    await page.click('#mediaSwitchBtn');
  });

  test('renders a separate manga library with reading progress', async ({ page }) => {
    await expect(page.locator('#mangaLibraryList .manga-card')).toHaveCount(1);
    await expect(page.locator('#mangaLibraryList')).toContainText('Manga Test Story');
    await expect(page.locator('#mangaLibraryList')).toContainText('Read 1 / 3');
    await expect(page.locator('#mangaLibraryList .pill.hot')).toContainText('Read 1 / 3');
    await expect(page.locator('#mangaLibraryList [data-action="manga-read"]')).toHaveText('Continue ch 2');
    await expect(page.locator('#mangaLibraryList [data-action="manga-read"]')).toHaveClass(/play-action-continue/);
    await expect(page.locator('#mangaCount')).toHaveText('1');
  });

  test('searches manga and keeps anime discover separate', async ({ page }) => {
    await page.click('.tab[data-section="discover"]');
    await page.fill('#mangaSearchInput', 'Test Story');
    const request = page.waitForRequest((item) => item.url().includes('/api/manga/search?q=Test%20Story'));
    await page.click('#mangaSearchForm button[type="submit"]');
    await request;
    await expect(page.locator('#mangaSearchResults .manga-card')).toHaveCount(1);
    await expect(page.locator('#mangaDiscoverView')).toHaveClass(/active/);
    await expect(page.locator('#searchView')).not.toHaveClass(/active/);
  });

  test('opens chapters and toggles read state explicitly', async ({ page }) => {
    await page.click('#mangaLibraryList [data-action="manga-chapters"]');
    await expect(page.locator('#mangaDialog')).toBeVisible();
    await expect(page.locator('#chapterGrid .chapter-row')).toHaveCount(3);
    const mark = page.waitForRequest((item) => item.url().endsWith('/api/manga/read') && item.method() === 'POST');
    await page.click('#chapterGrid [data-chapter="2"] [data-action="chapter-toggle"]');
    expect((await mark).postDataJSON()).toMatchObject({ id: 'manga1', chapter: '2', read: true });
    await expect(page.locator('#chapterGrid .chapter-row[data-chapter="2"]')).toHaveClass(/watched/);
  });

  test('opens chapters in the built-in reader without marking them automatically', async ({ page }) => {
    await page.click('#mangaLibraryList [data-action="manga-chapters"]');
    const pages = page.waitForRequest((item) => item.url().endsWith('/chapters/2/pages'));
    await page.click('#chapterGrid [data-chapter="2"] [data-action="chapter-open"]');
    await pages;
    await expect(page.locator('#mangaReaderDialog')).toBeVisible();
    await expect(page.locator('#mangaReaderPages .manga-page')).toHaveCount(1);
    await expect(page.locator('#mangaDownloadChapterBtn')).toHaveText('↓');
  });

  test('marks the current chapter read when advancing', async ({ page }) => {
    await page.click('#mangaLibraryList [data-action="manga-chapters"]');
    await page.click('#chapterGrid [data-chapter="2"] [data-action="chapter-open"]');
    const mark = page.waitForRequest((item) => item.url().endsWith('/api/manga/read') && item.method() === 'POST');
    await page.click('#mangaNextChapterBtn');
    expect((await mark).postDataJSON()).toMatchObject({ chapter: '2', read: true });
    await expect(page.locator('#mangaReaderMeta')).toContainText('Chapter 3');
  });

  test('downloads a chapter for offline reading', async ({ page }) => {
    await page.click('#mangaLibraryList [data-action="manga-chapters"]');
    const download = page.waitForRequest((item) => item.url().endsWith('/chapters/2/download') && item.method() === 'POST');
    await page.click('#chapterGrid [data-chapter="2"] [data-action="chapter-download"]');
    await download;
    await expect(page.locator('#chapterGrid [data-chapter="2"] [data-action="chapter-download"]')).toHaveText('⬇✓');
  });

  test('shows manga details without reusing the anime player', async ({ page }) => {
    await page.click('#mangaLibraryList [data-action="manga-about"]');
    await expect(page.locator('#mangaDialog')).toBeVisible();
    await expect(page.locator('#mangaDialogBody')).toContainText('A manga synopsis');
    await expect(page.locator('#mangaDialogBody .details-cover')).toHaveAttribute('src', /api\/proxy/);
    await expect(page.locator('#mangaDialogBody .related-item')).toContainText('Manga Test Sequel');
    await expect(page.locator('#mangaDialogBody .related-item .pill.hot')).toHaveText('Sequel');
    await expect(page.locator('#playerDialog')).toBeHidden();
  });
});
