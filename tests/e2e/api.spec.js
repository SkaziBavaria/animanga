'use strict';

const { test, expect } = require('@playwright/test');

// Real backend integration against the running server (no mocks). Only exercises
// endpoints that stay local (no ani-cli / AllAnime network calls). Serial so the
// track -> mark -> untrack lifecycle runs in order against shared state.
test.describe.configure({ mode: 'serial' });

const SHOW_ID = 'e2e-api-show';

test.describe('Backend API', () => {
  test('reports health status', async ({ request }) => {
    const res = await request.get('/api/status');
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.deps).toBeTruthy();
  });

  test('reads and updates settings', async ({ request }) => {
    const initial = await (await request.get('/api/settings')).json();
    expect(initial).toHaveProperty('mode');

    const updated = await (await request.post('/api/settings', { data: { quality: '720' } })).json();
    expect(updated.quality).toBe('720');

    const reread = await (await request.get('/api/settings')).json();
    expect(reread.quality).toBe('720');
  });

  test('persists playback progress', async ({ request }) => {
    await request.post('/api/progress', {
      data: { id: SHOW_ID, episode: '1', position: 100, duration: 1400 },
    });
    const body = await (await request.get('/api/progress')).json();
    expect(body.positions[`${SHOW_ID}:1`]).toBeTruthy();
    expect(body.positions[`${SHOW_ID}:1`].position).toBe(100);
  });

  test('tracks, marks and untracks a show', async ({ request }) => {
    const tracked = await (await request.post('/api/track', {
      data: { id: SHOW_ID, name: 'E2E API Show', episodes: ['1', '2', '3'], mode: 'sub', tracked: true },
    })).json();
    expect(tracked.show.tracked).toBe(true);

    let library = await (await request.get('/api/library')).json();
    expect(library.shows.some((s) => s.id === SHOW_ID)).toBe(true);

    const marked = await (await request.post('/api/mark', {
      data: { id: SHOW_ID, episode: '1', watched: true },
    })).json();
    expect(marked.show.watchedEpisodes).toContain('1');

    const removed = await request.delete(`/api/shows/${SHOW_ID}`);
    expect(removed.ok()).toBeTruthy();

    library = await (await request.get('/api/library')).json();
    expect(library.shows.some((s) => s.id === SHOW_ID)).toBe(false);
  });

  test('returns downloads and jobs collections', async ({ request }) => {
    const downloads = await (await request.get('/api/downloads')).json();
    expect(downloads).toHaveProperty('downloads');
    const jobs = await (await request.get('/api/jobs')).json();
    expect(Array.isArray(jobs.jobs)).toBe(true);
  });

  test('serves static assets and 404s unknown routes', async ({ request }) => {
    const index = await request.get('/');
    expect(index.ok()).toBeTruthy();
    expect(await index.text()).toContain('Ani Web');

    const appJs = await request.get('/js/app.js');
    expect(appJs.ok()).toBeTruthy();

    const missing = await request.get('/does-not-exist.txt');
    expect(missing.status()).toBe(404);

    const badApi = await request.get('/api/nope');
    expect(badApi.status()).toBe(404);
  });
});
