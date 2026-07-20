'use strict';

const { test, expect } = require('@playwright/test');
const { installApiMocks, makeShow } = require('./fixtures');

const SHOWS = [
  makeShow({ id: 'a', name: 'Alpha', title: 'Alpha (12 episodes)', lastWatched: '3', latestEpisode: 12, watchedEpisodes: ['1', '2', '3'], newCount: 1 }),
  makeShow({ id: 'b', name: 'Bravo', title: 'Bravo (12 episodes)', lastWatched: '12', latestEpisode: 12, watchedEpisodes: ['12'], newCount: 0 }),
  makeShow({ id: 'c', name: 'Charlie', title: 'Charlie (12 episodes)', lastWatched: '', latestEpisode: 12, watchedEpisodes: [], newCount: 0 }),
];

test.describe('Library filtering & sorting', () => {
  test.beforeEach(async ({ page }) => {
    await installApiMocks(page, { library: SHOWS });
    await page.goto('/');
    await expect(page.locator('#libraryList .show-card')).toHaveCount(3);
  });

  test('filters to shows with new episodes to continue', async ({ page }) => {
    await page.selectOption('#libraryFilter', 'continue');
    await expect(page.locator('#libraryList .show-card')).toHaveCount(1);
    await expect(page.locator('#libraryList')).toContainText('Alpha');
  });

  test('filters to caught-up shows', async ({ page }) => {
    await page.selectOption('#libraryFilter', 'caughtup');
    await expect(page.locator('#libraryList .show-card')).toHaveCount(1);
    await expect(page.locator('#libraryList')).toContainText('Bravo');
  });

  test('filters to not-started shows', async ({ page }) => {
    await page.selectOption('#libraryFilter', 'notstarted');
    await expect(page.locator('#libraryList .show-card')).toHaveCount(1);
    await expect(page.locator('#libraryList')).toContainText('Charlie');
    const playButton = page.locator('.show-card[data-id="c"] button[data-action="play"]');
    await expect(playButton).toHaveText('Play ep 1');
    await expect(playButton).toHaveClass(/play-action-play/);
  });

  test('sorts alphabetically', async ({ page }) => {
    await page.selectOption('#librarySort', 'az');
    const titles = await page.locator('#libraryList .show-title').allTextContents();
    expect(titles).toEqual(['Alpha', 'Bravo', 'Charlie']);
  });

  test('removes a show from the library', async ({ page }) => {
    page.on('dialog', (dialog) => dialog.accept());
    const del = page.waitForRequest((req) => /\/api\/shows\/a$/.test(req.url()) && req.method() === 'DELETE');
    await page.locator('.show-card[data-id="a"] button[data-action="remove"]').click();
    await del;
    await expect(page.locator('#toast')).toContainText('Removed from library');
  });

  test('refresh button reloads the library', async ({ page }) => {
    const refresh = page.waitForRequest((req) => req.url().includes('/api/library?refresh=1'));
    await page.click('#refreshBtn');
    await refresh;
    await expect(page.locator('#toast')).toContainText('Library updated');
  });

  test('renders a downloaded-count pill on cards', async ({ page }) => {
    await installApiMocks(page, {
      library: [makeShow({ id: 'a', name: 'Alpha', title: 'Alpha (12 episodes)' })],
      downloads: {
        'a:1': { key: 'a:1', showId: 'a', episode: '1', status: 'done', showName: 'Alpha', updatedAt: new Date().toISOString() },
        'a:2': { key: 'a:2', showId: 'a', episode: '2', status: 'done', showName: 'Alpha', updatedAt: new Date().toISOString() },
      },
    });
    await page.goto('/');
    await expect(page.locator('.show-card[data-id="a"] .pill.downloaded')).toContainText('2 saved');
  });
});

test.describe('Resume playback from the library card', () => {
  test('switches between sub and dub without losing shared progress', async ({ page }) => {
    await installApiMocks(page, {
      library: [makeShow({
        id: 'a',
        name: 'Alpha',
        lastWatched: '2',
        latestEpisode: 12,
        watchedEpisodes: ['1', '2'],
        episodeCounts: { sub: 12, dub: 12 },
      })],
      positions: {
        'a:3': { showId: 'a', episode: '3', position: 400, duration: 1400, updatedAt: new Date().toISOString() },
      },
    });
    await page.goto('/');

    const card = page.locator('.show-card[data-id="a"]');
    await expect(card.locator('button[data-action="play"]')).toHaveText('Resume ep 3');
    const update = page.waitForRequest((request) => request.url().endsWith('/api/shows/a') && request.method() === 'PATCH');
    await card.locator('select[data-action="mode"]').selectOption('dub');
    expect((await update).postDataJSON()).toEqual({ mode: 'dub' });
    await expect(card.locator('select[data-action="mode"]')).toHaveValue('dub');
    await expect(card.locator('button[data-action="play"]')).toHaveText('Resume ep 3');
  });

  test('shows "Resume" and targets the in-progress episode, not the next one', async ({ page }) => {
    await installApiMocks(page, {
      library: [makeShow({
        id: 'a',
        name: 'Alpha',
        title: 'Alpha (12 episodes)',
        lastWatched: '2',
        latestEpisode: 12,
        watchedEpisodes: ['1', '2'],
      })],
      // Episode 3 was only half-watched; its resume position should be selected.
      positions: {
        'a:3': { showId: 'a', episode: '3', position: 400, duration: 1400, updatedAt: new Date().toISOString() },
      },
    });
    await page.goto('/');

    const playButton = page.locator('.show-card[data-id="a"] button[data-action="play"]');
    await expect(playButton).toHaveText('Resume ep 3');
    await expect(playButton).toHaveClass(/play-action-resume/);
    await expect(playButton).toHaveAttribute('data-ep', '3');
  });

  test('ignores stale resume positions for watched episodes', async ({ page }) => {
    await installApiMocks(page, {
      library: [makeShow({
        id: 'a',
        name: 'Alpha',
        title: 'Alpha (3 episodes)',
        episodeCount: 3,
        lastWatched: '3',
        latestEpisode: 3,
        watchedEpisodes: ['1', '2', '3'],
        episodes: ['1', '2', '3'],
      })],
      positions: {
        'a:3': { showId: 'a', episode: '3', position: 400, duration: 1400, updatedAt: new Date().toISOString() },
      },
    });
    await page.goto('/');

    const playButton = page.locator('.show-card[data-id="a"] button[data-action="play"]');
    await expect(playButton).toHaveText('Play');
    await expect(playButton).toHaveClass(/play-action-play/);
  });

  test('falls back to the next episode once no position is in progress', async ({ page }) => {
    await installApiMocks(page, {
      library: [makeShow({
        id: 'a',
        name: 'Alpha',
        title: 'Alpha (12 episodes)',
        lastWatched: '3',
        latestEpisode: 12,
        watchedEpisodes: ['1', '2', '3'],
        episodes: ['1', '2', '3', '4', '5'],
      })],
      positions: {},
    });
    await page.goto('/');

    const playButton = page.locator('.show-card[data-id="a"] button[data-action="play"]');
    await expect(playButton).toHaveText('Continue ep 4');
    await expect(playButton).toHaveClass(/play-action-continue/);
    await expect(playButton).toHaveAttribute('data-ep', '4');
  });

  test('resuming from the library plays the in-progress episode and seeks to the saved position', async ({ page }) => {
    await installApiMocks(page, {
      library: [makeShow({
        id: 'a',
        name: 'Alpha',
        title: 'Alpha (12 episodes)',
        lastWatched: '2',
        latestEpisode: 12,
        watchedEpisodes: ['1', '2'],
      })],
      positions: {
        'a:3': { showId: 'a', episode: '3', position: 400, duration: 1400, updatedAt: new Date().toISOString() },
      },
    });
    await page.goto('/');

    const playRequest = page.waitForRequest((req) => req.url().endsWith('/api/play') && req.method() === 'POST');
    await page.click('.show-card[data-id="a"] button[data-action="play"]');
    const req = await playRequest;
    expect(req.postDataJSON()).toMatchObject({ id: 'a', episode: '3' });
    await expect(page.locator('#playerDialog')).toBeVisible();
  });
});
