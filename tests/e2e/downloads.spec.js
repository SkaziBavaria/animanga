'use strict';

const { test, expect } = require('@playwright/test');
const { installApiMocks } = require('./fixtures');

const DOWNLOADS = {
  'lib1:1': {
    key: 'lib1:1',
    showId: 'lib1',
    episode: '1',
    showName: 'Downloaded Show',
    status: 'done',
    file: { size: 1048576, filename: 'ep1.mp4' },
    updatedAt: new Date().toISOString(),
  },
  'lib1:2': {
    key: 'lib1:2',
    showId: 'lib1',
    episode: '2',
    showName: 'Downloaded Show',
    status: 'running',
    updatedAt: new Date().toISOString(),
  },
};

test.describe('Downloads panel', () => {
  test.beforeEach(async ({ page }) => {
    await installApiMocks(page, { downloads: DOWNLOADS });
    await page.goto('/');
    await page.click('.tab[data-view="settingsView"]');
    await page.click('.advanced-panel summary');
  });

  test('lists downloaded and in-progress episodes', async ({ page }) => {
    await expect(page.locator('#downloadsList .download-card')).toHaveCount(2);
    await expect(page.locator('#downloadsList')).toContainText('Downloaded Show');
    await expect(page.locator('#downloadsList')).toContainText('1 MB');
  });

  test('disables delete for an in-progress download', async ({ page }) => {
    const running = page.locator('.download-card[data-episode="2"] button[data-action="delete-download"]');
    await expect(running).toBeDisabled();
  });

  test('deletes a completed download', async ({ page }) => {
    page.on('dialog', (dialog) => dialog.accept());
    const del = page.waitForRequest((req) => /\/api\/downloads\/lib1\/1$/.test(req.url()) && req.method() === 'DELETE');
    await page.locator('.download-card[data-episode="1"] button[data-action="delete-download"]').click();
    await del;
    await expect(page.locator('#toast')).toContainText('Download deleted');
    await expect(page.locator('#downloadsList .download-card[data-episode="1"]')).toHaveCount(0);
  });

  test('deleting from the episode list removes the Settings downloads card', async ({ page }) => {
    await page.click('.tab[data-section="library"]');
    await page.click('#libraryList .show-card button[data-action="episodes"]');
    await expect(page.locator('#episodeGrid .episode-delete[data-episode="1"]')).toBeVisible();
    await page.locator('#episodeGrid .episode-delete[data-episode="1"]').click();
    await expect(page.locator('#toast')).toContainText('Episode 1 deleted');
    await expect(page.locator('#episodeGrid .episode-delete[data-episode="1"]')).toHaveCount(0);

    await page.click('#closeDialogBtn');
    await page.click('.tab[data-view="settingsView"]');
    await page.click('.advanced-panel summary');
    await expect(page.locator('#downloadsList .download-card[data-episode="1"]')).toHaveCount(0);
    await expect(page.locator('#downloadsList .download-card[data-episode="2"]')).toHaveCount(1);
  });

  test('refresh button reloads downloads', async ({ page }) => {
    const refresh = page.waitForRequest((req) => req.url().endsWith('/api/downloads') && req.method() === 'GET');
    await page.click('#downloadsBtn');
    await refresh;
    await expect(page.locator('#downloadsList .download-card')).toHaveCount(2);
  });
});
