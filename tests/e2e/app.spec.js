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

  test('navigates between sections and switches anime or manga from the brand', async ({ page }) => {
    await page.click('.tab[data-section="discover"]');
    await expect(page.locator('#searchView')).toHaveClass(/active/);
    await expect(page.locator('#libraryView')).not.toHaveClass(/active/);

    await page.click('.tab[data-view="settingsView"]');
    await expect(page.locator('#settingsView')).toHaveClass(/active/);

    await page.click('#mediaSwitchBtn');
    await expect(page.locator('#mediaModeLabel')).toHaveText('Manga');
    await expect(page.locator('#mangaLibraryView')).toHaveClass(/active/);

    await page.click('#mediaSwitchBtn');
    await expect(page.locator('#mediaModeLabel')).toHaveText('Anime');
    await expect(page.locator('#libraryView')).toHaveClass(/active/);
  });

  test('opens and closes the browser player', async ({ page }) => {
    await page.click('#libraryList .show-card button[data-action="play"]');
    await expect(page.locator('#playerDialog')).toBeVisible();
    await expect(page.locator('#toast')).toContainText('Opening player');
    await expect.poll(() => page.locator('#toast').evaluate((element) => element.matches(':popover-open'))).toBe(true);
    await expect(page.locator('#fullscreenBtn')).toHaveCount(0);
    await expect(page.locator('#videoControls')).toBeVisible();
    await expect(page.locator('#playerFullscreenBtn')).toBeVisible();
    await expect(page.locator('#prevEpisodeBtn')).toBeVisible();
    await expect(page.locator('#nextEpisodeBtn')).toBeVisible();
    await expect(page.locator('#playerVideo')).not.toHaveAttribute('controls');

    await page.evaluate(() => {
      const video = document.querySelector('#playerVideo');
      Object.defineProperty(video, 'duration', { value: 100, configurable: true });
      Object.defineProperty(video, 'currentTime', { value: 50, writable: true, configurable: true });
    });
    await page.click('#closePlayerBtn');
    await expect(page.locator('#playerDialog')).toBeHidden();
    await expect(page.locator('#libraryList .show-card button[data-action="play"]')).toHaveText('Resume ep 2');
  });

  test('keyboard and wheel shortcuts control the browser player', async ({ page }) => {
    await page.click('#libraryList .show-card button[data-action="play"]');
    await expect(page.locator('#playerDialog')).toBeVisible();

    await page.evaluate(() => {
      const video = document.querySelector('#playerVideo');
      window.__playerPaused = true;
      video.onerror = null;
      Object.defineProperty(video, 'duration', { value: 100, configurable: true });
      Object.defineProperty(video, 'currentTime', { value: 50, writable: true, configurable: true });
      Object.defineProperty(video, 'paused', {
        configurable: true,
        get: () => window.__playerPaused,
      });
      video.play = () => {
        window.__playerPaused = false;
        video.dispatchEvent(new Event('play'));
        return Promise.resolve();
      };
      video.pause = () => {
        window.__playerPaused = true;
        video.dispatchEvent(new Event('pause'));
      };
      video.dispatchEvent(new Event('loadedmetadata'));
    });

    await page.keyboard.press('ArrowRight');
    await expect.poll(() => page.evaluate(() => document.querySelector('#playerVideo').currentTime)).toBe(60);
    await expect(page.locator('#playerOsd')).toContainText('+10s');

    await page.keyboard.press('ArrowRight');
    await expect.poll(() => page.evaluate(() => document.querySelector('#playerVideo').currentTime)).toBe(70);
    await expect(page.locator('#playerOsd')).toContainText('+20s');

    await page.keyboard.press('ArrowDown');
    await expect.poll(() => page.evaluate(() => Math.round(document.querySelector('#playerVideo').volume * 100))).toBe(95);

    const box = await page.locator('#playerStage').boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, -100);
    await expect.poll(() => page.evaluate(() => Math.round(document.querySelector('#playerVideo').volume * 100))).toBe(100);
    await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe('playerStage');

    await page.keyboard.press('Space');
    await expect.poll(() => page.evaluate(() => window.__playerPaused)).toBe(false);
    await page.keyboard.press('Space');
    await expect.poll(() => page.evaluate(() => window.__playerPaused)).toBe(true);

    await page.evaluate(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Unidentified',
        code: 'Space',
        bubbles: true,
      }));
    });
    await expect.poll(() => page.evaluate(() => window.__playerPaused)).toBe(false);
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
