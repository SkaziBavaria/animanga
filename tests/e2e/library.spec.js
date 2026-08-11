'use strict';

const { test, expect } = require('@playwright/test');
const { installApiMocks, makeShow } = require('./fixtures');

const SHOWS = [
  makeShow({
    id: 'a',
    name: 'Alpha',
    title: 'Alpha (12 episodes)',
    lastWatched: '3',
    latestEpisode: 12,
    watchedEpisodes: ['1', '2', '3'],
    newCount: 1,
    status: 'Finished',
    airedStart: { year: 2015, month: 6, date: 5 },
    airedEnd: { year: 2018, month: 2, date: 25 },
    lastEpisodeDate: { year: 2018, month: 2, date: 25 },
    hasNextSeason: true,
    nextSeason: { status: 'Not Yet Released' },
  }),
  makeShow({
    id: 'b',
    name: 'Bravo',
    title: 'Bravo (12 episodes)',
    lastWatched: '12',
    latestEpisode: 12,
    watchedEpisodes: ['12'],
    newCount: 0,
    status: 'Releasing',
    airedStart: { year: 2024, month: 0, date: 1 },
    lastEpisodeTimestamp: Math.floor(Date.now() / 1000),
    broadcastInterval: '604800000',
    hasNextSeason: true,
    nextSeason: { status: 'Finished', episodeCount: 12 },
  }),
  makeShow({
    id: 'c',
    name: 'Charlie',
    title: 'Charlie (12 episodes)',
    lastWatched: '',
    latestEpisode: 12,
    watchedEpisodes: [],
    newCount: 0,
    status: 'Not Yet Released',
    airedStart: { year: 2027, month: 0, date: 1 },
  }),
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

  test('highlights progress instead of adding a separate new-episode pill', async ({ page }) => {
    const alpha = page.locator('.show-card[data-id="a"]');
    const progress = alpha.locator('.show-meta > .pill').first();
    await expect(progress).toHaveText('Progress 3 / 12');
    await expect(progress).toHaveClass(/hot/);
    await expect(progress).toHaveAttribute('title', '1 new episode available');
    await expect(alpha.locator('.show-meta')).not.toContainText('1 new');

    const bravoProgress = page.locator('.show-card[data-id="b"] .show-meta > .pill').first();
    await expect(bravoProgress).not.toHaveClass(/hot/);
  });

  test('shows a compact year range instead of separate start and last-episode pills', async ({ page }) => {
    const meta = page.locator('.show-card[data-id="a"] .show-meta');
    await expect(meta.locator('.pill.schedule')).toHaveCount(1);
    await expect(meta.locator('.pill.schedule')).toHaveText('2015–2018 · Finished');
    await expect(meta).not.toContainText('Started');
    await expect(meta).not.toContainText('Last ep');
  });

  test('estimates the next episode when only a broadcast interval is provided', async ({ page }) => {
    const schedule = page.locator('.show-card[data-id="b"] .pill.schedule');
    await expect(schedule).toHaveCount(2);
    await expect(schedule.nth(0)).toHaveText('Ongoing since 2024');
    await expect(schedule.nth(1)).toContainText('Expected ep 13');
  });

  test('uses clear sequel labels and reserves yellow for an available sequel', async ({ page }) => {
    const announced = page.locator('.show-card[data-id="a"] .pill.sequel');
    await expect(announced).toHaveText('Sequel announced');
    await expect(announced).toHaveClass(/upcoming/);
    await expect(announced).toHaveAttribute('title', 'A sequel has been announced');

    const available = page.locator('.show-card[data-id="b"] .pill.sequel');
    await expect(available).toHaveText('Sequel available');
    await expect(available).toHaveClass(/released/);
    await expect(available).toHaveAttribute('title', 'A sequel is available now');
  });

  test('shows the current title itself as announced without adding another pill', async ({ page }) => {
    const schedule = page.locator('.show-card[data-id="c"] .pill.schedule');
    await expect(schedule).toHaveCount(1);
    await expect(schedule).toHaveText('Announced · 2027');
    await expect(schedule).toHaveClass(/upcoming/);
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

  test('filters the library list by search query', async ({ page }) => {
    await page.fill('#librarySearchInput', 'brav');
    await expect(page.locator('#libraryList .show-card')).toHaveCount(1);
    await expect(page.locator('#libraryList')).toContainText('Bravo');
    await expect(page.locator('#libraryList')).not.toContainText('Alpha');

    await page.fill('#librarySearchInput', 'zzz');
    await expect(page.locator('#libraryList')).toContainText('No shows match this search.');
  });

  test('restores library filter sort search and active tab after reload', async ({ page }) => {
    await page.selectOption('#libraryFilter', 'continue');
    await page.selectOption('#librarySort', 'az');
    await page.fill('#librarySearchInput', 'alph');
    await page.click('.tab[data-section="discover"]');
    await expect(page.locator('#searchView')).toHaveClass(/active/);

    await page.reload();
    await expect(page.locator('#searchView')).toHaveClass(/active/);
    await page.click('.tab[data-section="library"]');
    await expect(page.locator('#libraryFilter')).toHaveValue('continue');
    await expect(page.locator('#librarySort')).toHaveValue('az');
    await expect(page.locator('#librarySearchInput')).toHaveValue('alph');
    await expect(page.locator('#libraryList .show-card')).toHaveCount(1);
    await expect(page.locator('#libraryList')).toContainText('Alpha');
  });

  test('removes a show from the library', async ({ page }) => {
    page.on('dialog', (dialog) => dialog.accept());
    const del = page.waitForRequest((req) => /\/api\/shows\/a$/.test(req.url()) && req.method() === 'DELETE');
    await page.locator('.show-card[data-id="a"] button[data-action="remove"]').click();
    await del;
    await expect(page.locator('#toast')).toContainText('Removed from library');
  });

  test('hides archived shows from the active library by default', async ({ page }) => {
    await installApiMocks(page, {
      library: [
        makeShow({ id: 'a', name: 'Alpha', title: 'Alpha (12 episodes)', archived: false }),
        makeShow({ id: 'z', name: 'Zulu', title: 'Zulu (12 episodes)', archived: true }),
      ],
    });
    await page.goto('/');
    await expect(page.locator('#libraryList .show-card')).toHaveCount(1);
    await expect(page.locator('#libraryList')).toContainText('Alpha');
    await expect(page.locator('#libraryList')).not.toContainText('Zulu');

    await page.selectOption('#libraryFilter', 'archived');
    await expect(page.locator('#libraryList .show-card')).toHaveCount(1);
    await expect(page.locator('#libraryList')).toContainText('Zulu');

    await page.selectOption('#libraryFilter', 'all');
    await expect(page.locator('#libraryList .show-card')).toHaveCount(2);
  });

  test('lists undismissed sequels from active and archived shows', async ({ page }) => {
    await installApiMocks(page, {
      library: [
        makeShow({
          id: 'active-source',
          name: 'Active source',
          nextSeason: { id: 'sequel-a', name: 'Sequel A', status: 'Not Yet Released', airedStart: { year: 2027 } },
        }),
        makeShow({
          id: 'archived-source',
          name: 'Archived source',
          archived: true,
          nextSeason: { id: 'sequel-b', name: 'Sequel B', status: 'Releasing', airedStart: { year: 2026 } },
        }),
        makeShow({
          id: 'dismissed-source',
          name: 'Dismissed source',
          dismissedNextSeasonId: 'sequel-c',
          nextSeason: { id: 'sequel-c', name: 'Sequel C' },
        }),
      ],
    });
    await page.goto('/');

    await expect(page.locator('#libraryFilter option[value="sequels"]')).toHaveText('Sequels found (2)');
    await page.selectOption('#libraryFilter', 'sequels');
    await expect(page.locator('#libraryList .sequel-alert')).toHaveCount(2);
    await expect(page.locator('#libraryList')).toContainText('After Archived source');
    await expect(page.locator('#libraryList')).not.toContainText('Sequel C');
  });

  test('can dismiss a sequel from the sequel filter', async ({ page }) => {
    await installApiMocks(page, {
      library: [makeShow({
        id: 'source',
        name: 'Source show',
        archived: true,
        nextSeason: { id: 'sequel', name: 'New sequel', status: 'Releasing' },
      })],
    });
    await page.goto('/');
    await page.selectOption('#libraryFilter', 'sequels');

    const dismiss = page.waitForRequest((req) => req.url().endsWith('/api/shows/source') && req.method() === 'PATCH');
    await page.locator('button[data-action="dismiss-sequel"]').click();
    expect((await dismiss).postDataJSON()).toEqual({ dismissedNextSeasonId: 'sequel' });
    await expect(page.locator('#libraryList')).toContainText('No new sequels found.');

    await page.reload();
    await page.selectOption('#libraryFilter', 'sequels');
    await expect(page.locator('#libraryList .sequel-alert')).toHaveCount(0);
  });

  test('archives and unarchives a show from the library card', async ({ page }) => {
    const archive = page.waitForRequest((req) => /\/api\/shows\/a$/.test(req.url()) && req.method() === 'PATCH');
    await page.locator('.show-card[data-id="a"] button[data-action="archive"]').click();
    expect((await archive).postDataJSON()).toEqual({ archived: true });
    await expect(page.locator('#toast')).toContainText('Archived');
    await expect(page.locator('.show-card[data-id="a"]')).toHaveCount(0);

    await page.selectOption('#libraryFilter', 'archived');
    await expect(page.locator('.show-card[data-id="a"]')).toContainText('Archived');
    const unarchive = page.waitForRequest((req) => /\/api\/shows\/a$/.test(req.url()) && req.method() === 'PATCH');
    await page.locator('.show-card[data-id="a"] button[data-action="unarchive"]').click();
    expect((await unarchive).postDataJSON()).toEqual({ archived: false });
    await expect(page.locator('#toast')).toContainText('Moved back to active library');
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
        // Search/details responses often contain only the currently selected mode.
        // Missing dub availability must remain selectable and be verified on switch.
        episodeCounts: { sub: 12 },
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
        newCount: 0,
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

  test('uses the signed proxy URL for remote streams', async ({ page }) => {
    const proxyUrl = '/api/proxy?url=https%3A%2F%2Fcdn.example%2Fep.mp4&exp=9999999999&sig=testsig&referrer=https%3A%2F%2Fok.ru%2F';
    await installApiMocks(page, {
      library: [makeShow({
        id: 'a',
        name: 'Alpha',
        title: 'Alpha (12 episodes)',
        lastWatched: '2',
        latestEpisode: 12,
        watchedEpisodes: ['1', '2'],
      })],
      playback: {
        url: 'https://cdn.example/ep.mp4',
        referrer: 'https://ok.ru/',
        proxyUrl,
        provider: 'OK.ru',
      },
    });
    await page.goto('/');
    await page.click('.show-card[data-id="a"] button[data-action="play"]');
    await expect(page.locator('#playerDialog')).toBeVisible();
    await expect.poll(async () => page.locator('#playerVideo').evaluate((video) => {
      const src = video.currentSrc || video.src || '';
      return src.includes('/api/proxy?') && src.includes('sig=testsig');
    })).toBe(true);
  });
});

test.describe('Episode watched marking', () => {
  test('offers to mark earlier unwatched episodes and unmarks only the selected episode', async ({ page }) => {
    await installApiMocks(page, {
      library: [makeShow({
        id: 'lib1',
        name: 'Library Test Show',
        watchedEpisodes: ['1'],
        lastWatched: '1',
        latestEpisode: 3,
        episodeCount: 3,
      })],
    });
    await page.goto('/');
    await page.click('#libraryList .show-card button[data-action="episodes"]');
    await expect(page.locator('#showDialog')).toBeVisible();
    await expect(page.locator('#episodeGrid .episode-row-wrap')).toHaveCount(3);

    const mark = page.waitForRequest((item) => item.url().endsWith('/api/mark-range') && item.method() === 'POST');
    await page.click('#episodeGrid [data-episode="3"] [data-action="episode-watched"]');
    await expect(page.locator('#animeWatchConfirmDialog')).toBeVisible();
    await expect(page.locator('#animeWatchConfirmMessage')).toContainText('1 earlier unwatched episode found');
    await page.click('#animeWatchConfirmDialog button[value="yes"]');
    expect((await mark).postDataJSON()).toMatchObject({ id: 'lib1', episode: '3' });
    await expect(page.locator('#episodeGrid [data-episode="2"] .episode-watch')).toHaveClass(/active/);
    await expect(page.locator('#episodeGrid [data-episode="3"] .episode-watch')).toHaveClass(/active/);

    const unmark = page.waitForRequest((item) => item.url().endsWith('/api/mark') && item.method() === 'POST');
    await page.click('#episodeGrid [data-episode="3"] [data-action="episode-watched"]');
    expect((await unmark).postDataJSON()).toMatchObject({ id: 'lib1', episode: '3', watched: false });
    await expect(page.locator('#episodeGrid [data-episode="2"] .episode-watch')).toHaveClass(/active/);
    await expect(page.locator('#episodeGrid [data-episode="3"] .episode-watch')).not.toHaveClass(/active/);
  });

  test('marks only the selected episode when the earlier-episode prompt is declined', async ({ page }) => {
    await installApiMocks(page, {
      library: [makeShow({
        id: 'lib1',
        name: 'Library Test Show',
        watchedEpisodes: ['1'],
        lastWatched: '1',
        latestEpisode: 3,
        episodeCount: 3,
      })],
    });
    await page.goto('/');
    await page.click('#libraryList .show-card button[data-action="episodes"]');
    const mark = page.waitForRequest((item) => item.url().endsWith('/api/mark') && item.method() === 'POST');
    await page.click('#episodeGrid [data-episode="3"] [data-action="episode-watched"]');
    await expect(page.locator('#animeWatchConfirmDialog')).toBeVisible();
    await page.click('#animeWatchConfirmDialog button[value="no"]');
    expect((await mark).postDataJSON()).toMatchObject({ episode: '3', watched: true });
    await expect(page.locator('#episodeGrid [data-episode="2"] .episode-watch')).not.toHaveClass(/active/);
    await expect(page.locator('#episodeGrid [data-episode="3"] .episode-watch')).toHaveClass(/active/);
  });
});
