'use strict';

const { test, expect } = require('@playwright/test');
const { installApiMocks } = require('./fixtures');

test.describe('Shell & navigation', () => {
  test.beforeEach(async ({ page }) => {
    await installApiMocks(page);
    await page.goto('/');
  });

  test('loads the shell and renders the library', async ({ page }) => {
    await expect(page).toHaveTitle('Ani Web');
    await expect(page.locator('#statusText')).toContainText('ani-cli');
    await expect(page.locator('#libraryView')).toHaveClass(/active/);
    await expect(page.locator('#libraryList .show-card')).toHaveCount(1);
    await expect(page.locator('#libraryList')).toContainText('Library Test Show');
    await expect(page.locator('#libraryCount')).toHaveText('1');
  });

  test('navigates between the three tabs', async ({ page }) => {
    await page.click('.tab[data-view="searchView"]');
    await expect(page.locator('#searchView')).toHaveClass(/active/);
    await expect(page.locator('#libraryView')).not.toHaveClass(/active/);

    await page.click('.tab[data-view="settingsView"]');
    await expect(page.locator('#settingsView')).toHaveClass(/active/);

    await page.click('.tab[data-view="libraryView"]');
    await expect(page.locator('#libraryView')).toHaveClass(/active/);
  });

  test('opens and closes the browser player', async ({ page }) => {
    await page.click('#libraryList .show-card button[data-action="play"]');
    await expect(page.locator('#playerDialog')).toBeVisible();
    await expect(page.locator('#fullscreenBtn')).toHaveCount(0);
    await expect(page.locator('#videoControls')).toBeVisible();
    await expect(page.locator('#playerFullscreenBtn')).toBeVisible();
    await expect(page.locator('#prevEpisodeBtn')).toBeVisible();
    await expect(page.locator('#nextEpisodeBtn')).toBeVisible();
    await expect(page.locator('#playerVideo')).not.toHaveAttribute('controls');

    await page.click('#closePlayerBtn');
    await expect(page.locator('#playerDialog')).toBeHidden();
  });

  test('shows a toast when a downloaded episode plays locally', async ({ page }) => {
    await installApiMocks(page, {
      localPlayback: { local: true, url: '/api/downloads/lib1/2/file', title: 'Local ep 2' },
    });
    await page.goto('/');
    await page.click('#libraryList .show-card button[data-action="play"]');
    await expect(page.locator('#toast')).toContainText('downloaded');
    await expect(page.locator('#playerDialog')).toBeVisible();
  });
});
