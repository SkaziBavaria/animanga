'use strict';

const { test, expect } = require('@playwright/test');
const { installApiMocks, makeShow } = require('./fixtures');

test.describe('Discover: search & browse', () => {
  test('searches and renders result cards', async ({ page }) => {
    await installApiMocks(page);
    await page.goto('/');
    await page.click('.tab[data-section="discover"]');
    await page.fill('#searchInput', 'naruto');
    await page.click('#searchForm button[type="submit"]');

    await expect(page.locator('#searchResults .show-card')).toHaveCount(1);
    await expect(page.locator('#searchResults')).toContainText('Result for naruto');
  });

  test('tracks a show from search results', async ({ page }) => {
    await installApiMocks(page);
    await page.goto('/');
    await page.click('.tab[data-section="discover"]');
    await page.fill('#searchInput', 'bleach');
    await page.click('#searchForm button[type="submit"]');

    const trackRequest = page.waitForRequest((req) => req.url().endsWith('/api/track') && req.method() === 'POST');
    await page.click('#searchResults .show-card button[data-action="track"]');
    await trackRequest;
    await expect(page.locator('#toast')).toContainText('Anime tracked');
  });

  test('shows the watch-release action when search has no results', async ({ page }) => {
    await installApiMocks(page, { searchResults: [] });
    await page.goto('/');
    await page.click('.tab[data-section="discover"]');
    await page.fill('#searchInput', 'nonexistent-title');
    await page.click('#searchForm button[type="submit"]');

    const watchButton = page.locator('#searchResults button[data-action="watch-release"]');
    await expect(watchButton).toBeVisible();

    const watchRequest = page.waitForRequest((req) => req.url().endsWith('/api/release-watches') && req.method() === 'POST');
    await watchButton.click();
    await watchRequest;
    await expect(page.locator('#toast')).toContainText('Watching');
  });

  test('browses popular titles', async ({ page }) => {
    await installApiMocks(page);
    await page.goto('/');
    await page.click('.tab[data-section="discover"]');
    await page.click('.browse-button[data-popular-range="0"]');
    await expect(page.locator('#searchResults .show-card')).toHaveCount(1);
    await expect(page.locator('.browse-button[data-popular-range="0"]')).toHaveClass(/active/);
  });

  test('browses recommendations', async ({ page }) => {
    await installApiMocks(page);
    await page.goto('/');
    await page.click('.tab[data-section="discover"]');
    await page.click('.browse-button[data-recommended="1"]');
    await expect(page.locator('#searchResults .show-card')).toHaveCount(1);
  });

  test('filters discover results by multiple genres', async ({ page }) => {
    await installApiMocks(page);
    await page.goto('/');
    await page.click('.tab[data-section="discover"]');

    const request = page.waitForRequest((req) => {
      const url = new URL(req.url());
      return url.pathname === '/api/search'
        && url.searchParams.getAll('genre').join(',') === 'Action,Fantasy'
        && url.searchParams.get('year') === '2025';
    });
    await page.click('#genreFilterSummary');
    await page.check('#genreFilter input[value="Action"]');
    await page.check('#genreFilter input[value="Fantasy"]');
    await page.fill('#discoverYearFilter', '2025');
    await page.click('#genreApplyBtn');
    await request;

    await expect(page.locator('#searchResults .show-card')).toHaveCount(1);
    await expect(page.locator('#genreFilterSummary')).toContainText('Action, Fantasy, 2025');
  });

  test('opens the about dialog with synopsis and related seasons', async ({ page }) => {
    await installApiMocks(page, {
      relations: [{
        id: 'rel1',
        name: 'Season 2',
        relation: 'sequel',
        episodeCount: 12,
        status: 'Finished',
        airedStart: { year: 2024 },
      }],
    });
    await page.goto('/');
    await page.click('#libraryList .show-card button[data-action="details"]');
    await expect(page.locator('#detailsDialog')).toBeVisible();
    await expect(page.locator('#detailsBody')).toContainText('E2E synopsis');
    await expect(page.locator('#detailsBody .related-item')).toContainText('Season 2');
    await expect(page.locator('#detailsBody .related-item')).toContainText('2024 · 12 episodes · Finished');
    await expect(page.locator('#detailsActions button[data-action="details-untrack"]')).toBeVisible();

    await page.locator('#detailsDialog').dispatchEvent('click');
    await expect(page.locator('#detailsDialog')).toBeHidden();
  });

  test('tracks and untracks a show from the about dialog', async ({ page }) => {
    await installApiMocks(page, {
      library: [],
      searchResults: [makeShow({ id: 's1', name: 'Search Show', title: 'Search Show (12 episodes)' })],
    });
    await page.goto('/');
    await page.click('.tab[data-section="discover"]');
    await page.click('#searchResults .show-card button[data-action="details"]');
    await expect(page.locator('#detailsActions button[data-action="details-track"]')).toBeVisible();

    const track = page.waitForRequest((req) => req.url().endsWith('/api/track') && req.method() === 'POST');
    await page.click('#detailsActions button[data-action="details-track"]');
    await track;
    await expect(page.locator('#toast')).toContainText('Anime tracked');
    await expect(page.locator('#detailsActions button[data-action="details-untrack"]')).toBeVisible();

    page.on('dialog', (dialog) => dialog.accept());
    const untrack = page.waitForRequest((req) => /\/api\/shows\/s1$/.test(req.url()) && req.method() === 'DELETE');
    await page.click('#detailsActions button[data-action="details-untrack"]');
    await untrack;
    await expect(page.locator('#toast')).toContainText('Removed from library');
    await expect(page.locator('#detailsActions button[data-action="details-track"]')).toBeVisible();
  });
});
