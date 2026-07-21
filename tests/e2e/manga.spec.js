'use strict';

const { test, expect } = require('@playwright/test');
const { installApiMocks, MANGA } = require('./fixtures');

test.describe('Manga', () => {
  test.use({ locale: 'sv-SE' });

  test.beforeEach(async ({ page }) => {
    await installApiMocks(page);
    await page.goto('/');
    await page.click('#mediaSwitchBtn');
  });

  test('renders a separate manga library with reading progress', async ({ page }) => {
    await expect(page.locator('#mangaLibraryList .manga-card')).toHaveCount(1);
    await expect(page.locator('#mangaLibraryList')).toContainText('Manga Test Story');
    await expect(page.locator('#mangaLibraryList')).toContainText('Progress 1 / 3');
    await expect(page.locator('#mangaLibraryList .pill.hot', { hasText: 'Progress 1 / 3' })).toBeVisible();
    await expect(page.locator('#mangaLibraryList')).toContainText('JP');
    await expect(page.locator('#mangaLibraryList [data-action="manga-read"]')).toHaveText('Continue ch 2');
    await expect(page.locator('#mangaLibraryList [data-action="manga-read"]')).toHaveClass(/play-action-continue/);
    await expect(page.locator('#mangaLibraryList')).toContainText('Ongoing since 2024');
    await expect(page.locator('#mangaLibraryList')).toContainText('Ch 3');
    await expect(page.locator('#mangaCount')).toHaveText('1');
  });

  test('uses recent chapter activity instead of an unknown lifecycle status', async ({ page }) => {
    const now = new Date();
    const manga = {
      ...MANGA,
      status: '',
      airedStart: { year: 2020 },
      lastChapterDate: {
        year: now.getUTCFullYear(),
        month: now.getUTCMonth() + 1,
        date: now.getUTCDate(),
      },
    };
    await page.route('**/api/manga/library', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ mangas: [manga] }),
    }));
    await page.reload();

    await expect(page.locator('#mangaLibraryList')).not.toContainText('Status unknown');
    await expect(page.locator('#mangaLibraryList')).not.toContainText('2020');
    await expect(page.locator('#mangaLibraryList')).toContainText('Recently updated');
    await expect(page.locator('#mangaLibraryList')).toContainText('Ch 3 · 0 days ago');
  });

  test('labels manga origins with compact country codes', async ({ page }) => {
    const mangas = [
      { ...MANGA, id: 'jp', name: 'Japanese Story', countryOfOrigin: 'JP' },
      { ...MANGA, id: 'kr', name: 'Korean Story', countryOfOrigin: 'KR' },
      { ...MANGA, id: 'cn', name: 'Chinese Story', countryOfOrigin: 'CN' },
    ];
    await page.route('**/api/manga/library', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ mangas }),
    }));
    await page.reload();

    await expect(page.locator('.manga-card[data-manga-id="jp"] .show-meta').getByText('JP', { exact: true })).toBeVisible();
    await expect(page.locator('.manga-card[data-manga-id="kr"] .show-meta').getByText('KR', { exact: true })).toBeVisible();
    await expect(page.locator('.manga-card[data-manga-id="cn"] .show-meta').getByText('CN', { exact: true })).toBeVisible();
  });

  test('switches a tracked manga between translated and raw chapters', async ({ page }) => {
    const select = page.locator('#mangaLibraryList .manga-card[data-manga-id="manga1"] select[data-action="manga-language"]');
    await expect(select).toHaveValue('sub');
    const request = page.waitForRequest((item) => item.url().endsWith('/api/manga/manga1') && item.method() === 'PATCH');
    await select.selectOption('raw');
    expect((await request).postDataJSON()).toEqual({ language: 'raw' });

    await expect(page.locator('#mangaLibraryList .manga-card[data-manga-id="manga1"] select[data-action="manga-language"]')).toHaveValue('raw');
    await expect(page.locator('#mangaLibraryList .manga-card[data-manga-id="manga1"]')).toContainText('Progress 1 / 2');
    const chaptersRequest = page.waitForRequest((item) => {
      const url = new URL(item.url());
      return url.pathname === '/api/manga/manga1/chapters' && url.searchParams.get('language') === 'raw';
    });
    await page.click('#mangaLibraryList [data-action="manga-chapters"]');
    await chaptersRequest;
    await expect(page.locator('#chapterGrid .chapter-row')).toHaveCount(2);
  });

  test('continues after the highest read chapter when starting mid-series', async ({ page }) => {
    const manga = {
      ...MANGA,
      chapters: ['5', '1', '4', '2', '3'],
      chapterCount: 5,
      latestChapter: '5',
      readChapters: ['3'],
      lastRead: '3',
      newCount: 4,
    };
    await page.route('**/api/manga/library', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ mangas: [manga] }),
    }));
    await page.reload();

    await expect(page.locator('#mangaLibraryList [data-action="manga-read"]')).toHaveText('Continue ch 4');
  });

  test('shows chapter progress instead of counting decimal chapter entries', async ({ page }) => {
    const manga = {
      ...MANGA,
      chapters: ['274', '274.5', '275', '275.5', '276', '277'],
      chapterCount: 6,
      latestChapter: '277',
      readChapters: ['274', '274.5', '275', '275.5', '276'],
      lastRead: '276',
      newCount: 1,
    };
    await page.route('**/api/manga/library', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ mangas: [manga] }),
    }));
    await page.reload();

    await expect(page.locator('#mangaLibraryList')).toContainText('Progress 276 / 277');
    await expect(page.locator('#mangaLibraryList')).not.toContainText('Read 5 / 6');
    await expect(page.locator('#mangaLibraryList [data-action="manga-read"]')).toHaveText('Continue ch 277');
  });

  test('searches manga and keeps anime discover separate', async ({ page }) => {
    await page.click('.tab[data-section="discover"]');
    await page.fill('#mangaSearchInput', 'Test Story');
    const request = page.waitForRequest((item) => new URL(item.url()).pathname === '/api/manga/search' && new URL(item.url()).searchParams.get('q') === 'Test Story');
    await page.click('#mangaSearchForm button[type="submit"]');
    await request;
    await expect(page.locator('#mangaSearchResults .manga-card')).toHaveCount(1);
    await expect(page.locator('#mangaDiscoverView')).toHaveClass(/active/);
    await expect(page.locator('#searchView')).not.toHaveClass(/active/);
  });

  test('offers a manga release watch when search has no results', async ({ page }) => {
    await page.route('**/api/manga/search?**', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ total: 0, results: [] }),
    }));
    await page.click('.tab[data-section="discover"]');
    await page.fill('#mangaSearchInput', 'future-manga');
    await page.click('#mangaSearchForm button[type="submit"]');

    const watchButton = page.locator('#mangaSearchResults button[data-action="manga-watch-release"]');
    await expect(watchButton).toBeVisible();
    const request = page.waitForRequest((item) => item.url().endsWith('/api/manga/release-watches') && item.method() === 'POST');
    await watchButton.click();
    expect((await request).postDataJSON()).toEqual({ query: 'future-manga', language: 'sub' });

    await expect(page.locator('#mangaReleaseWatchesCount')).toHaveText('1');
    await expect(page.locator('#mangaReleaseWatchesList')).toBeVisible();
    await expect(page.locator('#mangaReleaseWatchesList')).toContainText('future-manga');
    await expect(page.locator('#toast')).toContainText('Watching manga');
  });

  test('browses manga categories and applies multiple filters', async ({ page }) => {
    await page.click('.tab[data-section="discover"]');
    const hotRequest = page.waitForRequest((item) => new URL(item.url()).pathname === '/api/manga/popular' && new URL(item.url()).searchParams.get('range') === '1');
    await page.click('.manga-browse-button:has-text("Hot")');
    await hotRequest;

    await page.click('#mangaGenreFilter summary');
    await page.check('#mangaGenreFilter input[value="Fantasy"]');
    await page.check('#mangaGenreFilter input[value="Seinen"]');
    await page.fill('#mangaYearFilter', '2024');
    const filterRequest = page.waitForRequest((item) => {
      const url = new URL(item.url());
      return url.searchParams.getAll('genre').join(',') === 'Fantasy,Seinen' && url.searchParams.get('year') === '2024';
    });
    await page.click('#mangaGenreApplyBtn');
    await filterRequest;
    await expect(page.locator('#mangaGenreFilterSummary')).toContainText('Fantasy, Seinen, 2024');
  });

  test('offers to mark earlier unread chapters and unmarks only the selected chapter', async ({ page }) => {
    await page.click('#mangaLibraryList [data-action="manga-chapters"]');
    await expect(page.locator('#mangaDialog')).toBeVisible();
    await expect(page.locator('#chapterGrid .chapter-row')).toHaveCount(3);
    await expect(page.locator('#chapterGrid .episode-row')).toHaveCount(3);
    await expect(page.locator('#chapterGrid article[data-chapter="1"] .episode-watch')).toHaveClass(/active/);
    await expect(page.locator('#chapterGrid article[data-chapter="1"] .episode-view-progress')).toHaveAttribute('aria-valuenow', '100');
    await expect(page.locator('#chapterGrid article[data-chapter="2"] .chapter-open')).toHaveClass(/next/);
    await expect(page.locator('#chapterGrid article[data-chapter="2"] .episode-state').first()).toHaveText('Up next');
    await expect(page.locator('#chapterGrid article[data-chapter="1"]')).toContainText('Released');
    await expect(page.locator('#chapterGrid article[data-chapter="2"]')).toContainText('Release date unavailable');
    const mark = page.waitForRequest((item) => item.url().endsWith('/api/manga/read-through') && item.method() === 'POST');
    await page.click('#chapterGrid [data-chapter="3"] [data-action="chapter-toggle"]');
    await expect(page.locator('#mangaReadConfirmDialog')).toBeVisible();
    await expect(page.locator('#mangaReadConfirmMessage')).toContainText('1 earlier unread chapter found');
    await expect(page.locator('#mangaReadConfirmDialog button[value="no"]')).toHaveText('No');
    await expect(page.locator('#mangaReadConfirmDialog button[value="yes"]')).toHaveText('Yes');
    await page.click('#mangaReadConfirmDialog button[value="yes"]');
    expect((await mark).postDataJSON()).toMatchObject({ id: 'manga1', chapter: '3', chapters: ['1', '2', '3'] });
    await expect(page.locator('#chapterGrid .chapter-row[data-chapter="2"]')).toHaveClass(/watched/);
    await expect(page.locator('#chapterGrid .chapter-row[data-chapter="3"]')).toHaveClass(/watched/);

    const unmark = page.waitForRequest((item) => item.url().endsWith('/api/manga/read') && item.method() === 'POST');
    await page.click('#chapterGrid [data-chapter="3"] [data-action="chapter-toggle"]');
    expect((await unmark).postDataJSON()).toMatchObject({ id: 'manga1', chapter: '3', read: false });
    await expect(page.locator('#chapterGrid .chapter-row[data-chapter="2"]')).toHaveClass(/watched/);
    await expect(page.locator('#chapterGrid .chapter-row[data-chapter="3"]')).not.toHaveClass(/watched/);

    const markWithoutPrompt = page.waitForRequest((item) => item.url().endsWith('/api/manga/read') && item.method() === 'POST');
    await page.click('#chapterGrid [data-chapter="3"] [data-action="chapter-toggle"]');
    expect((await markWithoutPrompt).postDataJSON()).toMatchObject({ chapter: '3', read: true });
  });

  test('marks only the selected chapter when the earlier-chapter prompt is declined', async ({ page }) => {
    await page.click('#mangaLibraryList [data-action="manga-chapters"]');
    const mark = page.waitForRequest((item) => item.url().endsWith('/api/manga/read') && item.method() === 'POST');
    await page.click('#chapterGrid [data-chapter="3"] [data-action="chapter-toggle"]');
    await expect(page.locator('#mangaReadConfirmDialog')).toBeVisible();
    await page.click('#mangaReadConfirmDialog button[value="no"]');
    expect((await mark).postDataJSON()).toMatchObject({ chapter: '3', read: true });

    await expect(page.locator('#chapterGrid .chapter-row[data-chapter="2"]')).not.toHaveClass(/watched/);
    await expect(page.locator('#chapterGrid .chapter-row[data-chapter="3"]')).toHaveClass(/watched/);
  });

  test('keeps chapter jump without the old mark-read-through action', async ({ page }) => {
    await page.click('#mangaLibraryList [data-action="manga-chapters"]');
    await expect(page.locator('#mangaChapterTools')).toBeVisible();
    await expect(page.locator('#mangaMarkThroughBtn')).toHaveCount(0);
    await page.fill('#mangaChapterTarget', '2');
    await page.click('#mangaChapterJumpBtn');
    await expect(page.locator('#chapterGrid .chapter-row[data-chapter="2"]')).toHaveClass(/chapter-jump-highlight/);
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

  test('opens the manga reader fullscreen through the document root', async ({ page }) => {
    await page.click('#mangaLibraryList [data-action="manga-chapters"]');
    await page.click('#chapterGrid [data-chapter="2"] [data-action="chapter-open"]');
    await page.evaluate(() => {
      document.documentElement.requestFullscreen = async () => {
        document.documentElement.dataset.fullscreenRequested = 'true';
      };
    });

    await page.click('#mangaFullscreenBtn');

    await expect(page.locator('html')).toHaveAttribute('data-fullscreen-requested', 'true');
    await expect(page.locator('#mangaReaderDialog')).toHaveClass(/manga-reader-fullscreen/);
    await expect(page.locator('body')).toHaveClass(/manga-reader-fullscreen-active/);
    await expect(page.locator('#mangaFullscreenBtn')).toHaveAttribute('aria-label', 'Exit fullscreen');
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
    await expect(page.locator('#chapterGrid [data-chapter="2"] [data-action="chapter-download"]')).toHaveClass(/downloaded/);
    await expect(page.locator('#chapterGrid [data-chapter="2"] [data-action="chapter-download"]')).toHaveText('✓');
  });

  test('queues a limited chapter range for offline reading', async ({ page }) => {
    await page.click('#mangaLibraryList [data-action="manga-chapters"]');
    await expect(page.locator('#mangaDownloadTools')).toBeVisible();
    await expect(page.locator('#mangaDownloadPanel')).toBeHidden();
    await expect(page.locator('#mangaDownloadCustomRange')).toBeHidden();

    await page.click('#mangaDownloadToggleBtn');
    await expect(page.locator('#mangaDownloadPanel')).toBeVisible();
    await expect(page.locator('#mangaDownloadFrom')).toHaveValue('2');
    await expect(page.locator('#mangaDownloadTo')).toHaveValue('3');
    await expect(page.locator('.manga-download-quick[data-count="10"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#mangaDownloadRangeBtn')).toHaveText('Download 2 chapters');

    await page.click('#mangaDownloadCustomBtn');
    await expect(page.locator('#mangaDownloadCustomRange')).toBeVisible();
    await page.fill('#mangaDownloadFrom', '3');
    await expect(page.locator('#mangaDownloadRangeBtn')).toHaveText('Download 1 chapter');
    await page.click('.manga-download-quick[data-count="10"]');
    await expect(page.locator('#mangaDownloadCustomRange')).toBeHidden();

    page.once('dialog', (dialog) => dialog.accept());
    const request = page.waitForRequest((item) => item.url().endsWith('/chapters/download-batch') && item.method() === 'POST');
    await page.click('#mangaDownloadRangeBtn');
    expect((await request).postDataJSON()).toEqual({ chapters: ['2', '3'] });
    await expect(page.locator('#mangaDownloadPanel')).toBeHidden();
    await expect(page.locator('#mangaDownloadStatus progress')).toBeVisible();
    await expect(page.locator('#toast')).toContainText('2 chapters downloaded');
    await expect(page.locator('#chapterGrid [data-chapter="2"] [data-action="chapter-download"]')).toHaveClass(/downloaded/);
    await expect(page.locator('#chapterGrid [data-chapter="3"] [data-action="chapter-download"]')).toHaveClass(/downloaded/);
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
