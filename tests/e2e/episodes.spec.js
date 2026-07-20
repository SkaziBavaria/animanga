'use strict';

const { test, expect } = require('@playwright/test');
const { installApiMocks } = require('./fixtures');

test.describe('Episodes dialog', () => {
  test('opens the dialog and lists episodes with watched state', async ({ page }) => {
    await installApiMocks(page);
    await page.goto('/');
    await page.click('#libraryList .show-card button[data-action="episodes"]');

    await expect(page.locator('#showDialog')).toBeVisible();
    await expect(page.locator('#dialogTitle')).toContainText('Library Test Show');
    await expect(page.locator('#episodeGrid .episode-play')).toHaveCount(3);
    await expect(page.locator('#episodeGrid .episode-play[data-episode="1"]')).toHaveClass(/watched/);

    await page.click('#closeDialogBtn');
    await expect(page.locator('#showDialog')).toBeHidden();
  });

  test('shows a resume indicator for a partially watched episode', async ({ page }) => {
    await installApiMocks(page, {
      positions: { 'lib1:2': { showId: 'lib1', episode: '2', position: 120, duration: 1440 } },
    });
    await page.goto('/');
    await page.click('#libraryList .show-card button[data-action="episodes"]');

    const ep2 = page.locator('#episodeGrid .episode-play[data-episode="2"]');
    await expect(ep2).toHaveClass(/in-progress/);
    await expect(ep2).toContainText('Resume 2:00 / 24:00 · 8% watched');
    const progress = page.locator('#episodeGrid .episode-row-wrap[data-episode="2"] .episode-view-progress');
    await expect(progress).toBeVisible();
    await expect(progress).toHaveAttribute('aria-valuenow', '8');
  });

  test('shows complete progress for a watched episode', async ({ page }) => {
    await installApiMocks(page);
    await page.goto('/');
    await page.click('#libraryList .show-card button[data-action="episodes"]');

    const progress = page.locator('#episodeGrid .episode-row-wrap[data-episode="1"] .episode-view-progress');
    await expect(progress).toBeVisible();
    await expect(progress).toHaveClass(/complete/);
    await expect(progress).toHaveAttribute('aria-valuenow', '100');
  });

  test('downloads a single episode', async ({ page }) => {
    await installApiMocks(page);
    await page.goto('/');
    await page.click('#libraryList .show-card button[data-action="episodes"]');

    const dl = page.waitForRequest((req) => req.url().endsWith('/api/download') && req.method() === 'POST');
    await page.click('#episodeGrid .episode-download[data-episode="2"]');
    await dl;
    await expect(page.locator('#toast')).toContainText('Download started');
  });

  test('queues a full-season download', async ({ page }) => {
    await installApiMocks(page);
    await page.goto('/');
    await page.click('#libraryList .show-card button[data-action="episodes"]');

    const season = page.waitForRequest((req) => req.url().endsWith('/api/download-season') && req.method() === 'POST');
    await page.click('#downloadAllBtn');
    await season;
    await expect(page.locator('#toast')).toContainText('2 episodes queued');
  });

  test('marks an episode watched once playback finishes, not immediately on click', async ({ page }) => {
    await installApiMocks(page);
    await page.goto('/');
    await page.click('#libraryList .show-card button[data-action="episodes"]');

    await page.click('#episodeGrid .episode-play[data-episode="2"]');
    await expect(page.locator('#playerDialog')).toBeVisible();
    await expect(page.locator('#episodeGrid .episode-play[data-episode="2"]')).not.toHaveClass(/watched/);

    const mark = page.waitForRequest((req) => req.url().endsWith('/api/mark') && req.method() === 'POST');
    await page.evaluate(() => document.querySelector('#playerVideo').dispatchEvent(new Event('ended')));
    await mark;
    await expect(page.locator('#episodeGrid .episode-play[data-episode="2"]')).toHaveClass(/watched/);
  });

  test('does not mark the episode done from an early outro timestamp', async ({ page }) => {
    await installApiMocks(page, {
      skipTimes: { op: null, ed: { start: 2, end: 4 } },
    });
    await page.goto('/');
    await page.click('#libraryList .show-card button[data-action="episodes"]');

    await page.click('#episodeGrid .episode-play[data-episode="2"]');
    await expect(page.locator('#playerDialog')).toBeVisible();

    await page.evaluate(() => {
      const video = document.querySelector('#playerVideo');
      Object.defineProperty(video, 'duration', { value: 10, configurable: true });
      Object.defineProperty(video, 'currentTime', { value: 3, writable: true, configurable: true });
      video.dispatchEvent(new Event('loadedmetadata'));
    });

    // Skip times are fetched asynchronously; keep nudging timeupdate until they land.
    await expect.poll(() => page.evaluate(() => {
      document.querySelector('#playerVideo').dispatchEvent(new Event('timeupdate'));
      return document.querySelector('#skipButton').hidden;
    })).toBe(false);
    await expect(page.locator('#skipButton')).toContainText('Skip Outro');
    await expect(page.locator('#episodeGrid .episode-play[data-episode="2"]')).not.toHaveClass(/watched/);

    const mark = page.waitForRequest((req) => req.url().endsWith('/api/mark') && req.method() === 'POST');
    await page.evaluate(() => document.querySelector('#playerVideo').dispatchEvent(new Event('ended')));
    await mark;
    await expect(page.locator('#episodeGrid .episode-play[data-episode="2"]')).toHaveClass(/watched/);
  });

  test('retries skip lookup after the video duration becomes available', async ({ page }) => {
    const skipDurations = [];
    await installApiMocks(page, {
      skipTimes: (url) => {
        const duration = Number(url.searchParams.get('duration') || 0);
        skipDurations.push(duration);
        return duration > 0 ? { op: { start: 10, end: 90 }, ed: null } : { op: null, ed: null };
      },
    });
    await page.goto('/');
    await page.click('#libraryList .show-card button[data-action="episodes"]');

    await page.click('#episodeGrid .episode-play[data-episode="2"]');
    await expect(page.locator('#playerDialog')).toBeVisible();

    await expect.poll(() => skipDurations.includes(0)).toBe(true);
    await page.evaluate(() => {
      const video = document.querySelector('#playerVideo');
      Object.defineProperty(video, 'duration', { value: 120, configurable: true });
      Object.defineProperty(video, 'currentTime', { value: 12, writable: true, configurable: true });
      video.dispatchEvent(new Event('durationchange'));
    });

    await expect.poll(() => page.evaluate(() => {
      document.querySelector('#playerVideo').dispatchEvent(new Event('timeupdate'));
      return document.querySelector('#skipButton').hidden;
    })).toBe(false);
    expect(skipDurations).toContain(120);
    await expect(page.locator('#skipButton')).toContainText('Skip Intro');
  });
});
