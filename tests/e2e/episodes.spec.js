'use strict';

const { test, expect } = require('@playwright/test');
const { installApiMocks } = require('./fixtures');

test.describe('Episodes dialog', () => {
  test('skip buttons follow the seek bar on desktop, mobile and fullscreen', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await installApiMocks(page, { skipTimes: { op: { start: 10, end: 40 }, ed: { start: 70, end: 90 } } });
    await page.goto('/');
    await page.click('#libraryList .show-card button[data-action="episodes"]');
    await page.click('#episodeGrid .episode-play[data-episode="2"]');
    await page.evaluate(() => {
      const video = document.querySelector('#playerVideo');
      video.onerror = null;
      video.style.aspectRatio = '16 / 9';
      Object.defineProperty(video, 'duration', { value: 100, configurable: true });
      Object.defineProperty(video, 'currentTime', { value: 20, writable: true, configurable: true });
      video.dispatchEvent(new Event('loadedmetadata'));
    });
    for (const [width, height, fullscreen] of [[1280, 900, false], [390, 844, false], [844, 390, true], [1280, 900, true]]) {
      await page.setViewportSize({ width, height });
      await page.evaluate((enabled) => {
        document.querySelector('#playerDialog').classList.toggle('player-fullscreen', enabled);
      }, fullscreen);
      for (const [position, label, end] of [[20, 'Skip Intro', 40], [75, 'Skip Outro', 90]]) {
        await expect.poll(() => page.evaluate((time) => {
          const video = document.querySelector('#playerVideo');
          video.currentTime = time;
          video.dispatchEvent(new Event('timeupdate'));
          return document.querySelector('#skipButton').textContent;
        }, position)).toContain(label);
        const button = page.locator('#skipButton');
        const bounds = await button.boundingBox();
        const seek = await page.locator('#playerSeek').boundingBox();
        const gap = seek.y - (bounds.y + bounds.height);
        expect(gap).toBeGreaterThanOrEqual(8);
        expect(gap).toBeLessThanOrEqual(12);
        await button.click({ position: { x: bounds.width / 2, y: bounds.height - 4 } });
        expect(await page.locator('#playerVideo').evaluate((video) => video.currentTime)).toBe(end);
      }
    }
    await page.mouse.move(0, 0);
    await page.evaluate(() => {
      const video = document.querySelector('#playerVideo');
      video.currentTime = 20;
      video.dispatchEvent(new Event('timeupdate'));
    });
    const button = page.locator('#skipButton');
    const original = await button.boundingBox();
    await page.locator('.player-controls-row').evaluate(row => { row.style.minHeight = '84px'; });
    const resized = await button.boundingBox();
    const seek = await page.locator('#playerSeek').boundingBox();
    expect(resized.y).toBeLessThan(original.y);
    expect(seek.y - (resized.y + resized.height)).toBeGreaterThanOrEqual(8);
    expect(seek.y - (resized.y + resized.height)).toBeLessThanOrEqual(12);
    await page.locator('#playerStage').evaluate(stage => stage.classList.add('controls-hidden'));
    await expect(page.locator('#videoControls')).toHaveCSS('opacity', '0');
    await expect(button).toBeVisible();
    expect((await button.boundingBox()).y).toBeCloseTo(resized.y, 0);
    await button.click();
    expect(await page.locator('#playerVideo').evaluate(video => video.currentTime)).toBe(40);
  });

  test('opens the dialog and lists episodes with watched state', async ({ page }) => {
    await installApiMocks(page);
    await page.goto('/');
    await page.click('#libraryList .show-card button[data-action="episodes"]');

    await expect(page.locator('#showDialog')).toBeVisible();
    await expect(page.locator('#dialogTitle')).toContainText('Library Test Show');
    await expect(page.locator('#episodeGrid .episode-play')).toHaveCount(3);
    await expect(page.locator('#episodeGrid .episode-play[data-episode="1"]')).toHaveClass(/watched/);

    await page.locator('#showDialog').dispatchEvent('click');
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
    await expect(ep2).toContainText('Resume 2:00 / 24:00 · 8%');
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

  test('shows download activity beside the episode that is downloading', async ({ page }) => {
    await installApiMocks(page, {
      downloads: {
        'lib1:2': {
          key: 'lib1:2', showId: 'lib1', episode: '2', showName: 'Library Test Show', status: 'running',
          progressInfo: { phase: 'downloading', elapsedSeconds: 65, idleSeconds: 24, outTimeUs: 0, totalBytes: 0 },
        },
      },
    });
    await page.goto('/');
    await page.click('#libraryList .show-card button[data-action="episodes"]');

    const row = page.locator('#episodeGrid .episode-row-wrap[data-episode="2"]');
    await expect(row).toContainText('No video data · reconnecting (0:24)');
    await expect(row.locator('[role="progressbar"][aria-label="Download activity"]')).toBeVisible();
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

  test('marks the current episode watched when pressing next in the player', async ({ page }) => {
    await installApiMocks(page);
    await page.goto('/');
    await page.click('#libraryList .show-card button[data-action="episodes"]');

    await page.click('#episodeGrid .episode-play[data-episode="2"]');
    await expect(page.locator('#playerDialog')).toBeVisible();
    await expect(page.locator('#nextEpisodeBtn')).toBeEnabled();

    const mark = page.waitForRequest((req) => req.url().endsWith('/api/mark') && req.method() === 'POST');
    await page.click('#nextEpisodeBtn');
    expect((await mark).postDataJSON()).toMatchObject({ episode: '2', watched: true });
    await expect(page.locator('#episodeGrid .episode-play[data-episode="2"]')).toHaveClass(/watched/);
  });

  test('hides the next control on the last episode', async ({ page }) => {
    await installApiMocks(page);
    await page.goto('/');
    await page.click('#libraryList .show-card button[data-action="episodes"]');
    await page.click('#episodeGrid .episode-play[data-episode="3"]');
    await expect(page.locator('#playerDialog')).toBeVisible();
    await expect(page.locator('#nextEpisodeBtn')).toBeHidden();
    await expect(page.locator('#prevEpisodeBtn')).toBeVisible();
    await expect(page.locator('#prevEpisodeBtn')).toBeEnabled();
  });

  test('does not mark the episode done when closing at an early outro timestamp', async ({ page }) => {
    await installApiMocks(page, {
      skipTimes: { op: null, ed: { start: 20, end: 40 } },
    });
    await page.goto('/');
    await page.click('#libraryList .show-card button[data-action="episodes"]');

    await page.click('#episodeGrid .episode-play[data-episode="2"]');
    await expect(page.locator('#playerDialog')).toBeVisible();

    await page.evaluate(() => {
      const video = document.querySelector('#playerVideo');
      video.onerror = null;
      Object.defineProperty(video, 'duration', { value: 100, configurable: true });
      Object.defineProperty(video, 'currentTime', { value: 30, writable: true, configurable: true });
      video.dispatchEvent(new Event('loadedmetadata'));
    });

    // Skip times are fetched asynchronously; keep nudging timeupdate until they land.
    await expect.poll(() => page.evaluate(() => {
      document.querySelector('#playerVideo').dispatchEvent(new Event('timeupdate'));
      return document.querySelector('#skipButton').hidden;
    })).toBe(false);
    await expect(page.locator('#skipButton')).toContainText('Skip Outro');
    await expect(page.locator('#episodeGrid .episode-play[data-episode="2"]')).not.toHaveClass(/watched/);

    await page.click('#closePlayerBtn');
    await expect(page.locator('#episodeGrid .episode-play[data-episode="2"]')).not.toHaveClass(/watched/);
    await expect(page.locator('#libraryList .show-card button[data-action="play"]')).toHaveText('Resume ep 2');
  });

  test('marks the episode done when closing after a real outro starts', async ({ page }) => {
    await installApiMocks(page, {
      skipTimes: { op: null, ed: { start: 90, end: 100 } },
    });
    await page.goto('/');
    await page.click('#libraryList .show-card button[data-action="episodes"]');
    await page.click('#episodeGrid .episode-play[data-episode="2"]');
    await expect(page.locator('#playerDialog')).toBeVisible();

    await page.evaluate(() => {
      const video = document.querySelector('#playerVideo');
      video.onerror = null;
      Object.defineProperty(video, 'duration', { value: 100, configurable: true });
      Object.defineProperty(video, 'currentTime', { value: 92, writable: true, configurable: true });
      video.dispatchEvent(new Event('loadedmetadata'));
    });
    await expect.poll(() => page.evaluate(() => {
      document.querySelector('#playerVideo').dispatchEvent(new Event('timeupdate'));
      return document.querySelector('#skipButton').hidden;
    })).toBe(false);

    const mark = page.waitForRequest((req) => req.url().endsWith('/api/mark') && req.method() === 'POST');
    await page.click('#closePlayerBtn');
    expect((await mark).postDataJSON()).toMatchObject({ episode: '2', watched: true });
    await expect(page.locator('#episodeGrid .episode-play[data-episode="2"]')).toHaveClass(/watched/);
    await expect(page.locator('#libraryList .show-card button[data-action="play"]')).toHaveText('Continue ep 3');
  });

  test('waits for the video duration before looking up skip times', async ({ page }) => {
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

    await page.waitForTimeout(100);
    expect(skipDurations).not.toContain(0);
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
    expect(skipDurations).not.toContain(0);
    expect(skipDurations).toContain(120);
    await expect(page.locator('#skipButton')).toContainText('Skip Intro');
  });
});
