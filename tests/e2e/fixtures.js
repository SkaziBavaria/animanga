'use strict';

const DEFAULT_SETTINGS = {
  mode: 'sub',
  quality: 'best',
  skipIntro: false,
  autoTrackPlayed: true,
};

const LIBRARY_SHOW = {
  id: 'lib1',
  name: 'Library Test Show',
  title: 'Library Test Show (12 episodes)',
  mode: 'sub',
  episodeCount: 12,
  latestEpisode: 12,
  newCount: 2,
  watchedEpisodes: ['1'],
  lastWatched: '1',
  thumbnail: '',
  genres: ['Action'],
};

function makeShow(overrides = {}) {
  return { ...LIBRARY_SHOW, ...overrides };
}

function jsonBody(data, status = 200) {
  return { status, contentType: 'application/json', body: JSON.stringify(data) };
}

/**
 * Installs deterministic mocks for every /api/* route so the real frontend can
 * be exercised end-to-end without ani-cli or the AllAnime API.
 *
 * Supported overrides: settings, library, downloads, positions, releaseWatches,
 * searchResults, jobs, relations, playbackStatus (for local playback lookup).
 *
 * @param {import('@playwright/test').Page} page
 * @param {object} [overrides]
 */
async function installApiMocks(page, overrides = {}) {
  const settings = { ...DEFAULT_SETTINGS, ...(overrides.settings || {}) };
  const library = overrides.library || [LIBRARY_SHOW];
  const downloads = overrides.downloads || {};
  const positions = overrides.positions || {};
  const releaseWatches = overrides.releaseWatches || [];
  const jobs = overrides.jobs || [];
  const relations = overrides.relations || [];
  const localPlayback = overrides.localPlayback || null;
  const skipTimes = overrides.skipTimes || { op: null, ed: null };

  const searchResult = (q) => ({
    id: 'search1',
    name: `Result for ${q || 'browse'}`,
    title: `Result for ${q || 'browse'} (24 episodes)`,
    episodeCount: 24,
    latestEpisode: 24,
    mode: 'sub',
    thumbnail: '',
  });

  const detailsFor = (id) => ({
    ...LIBRARY_SHOW,
    id,
    description: 'E2E synopsis for the show under test.',
    genres: ['Action', 'Adventure'],
    type: 'TV',
    status: 'Finished',
    score: 8.5,
    relations,
  });

  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const p = url.pathname;
    const method = request.method();
    const body = () => request.postDataJSON() || {};

    // --- read/health ---
    if (p === '/api/status') {
      return route.fulfill(jsonBody({
        ok: true,
        aniCli: 'ani-cli',
        aniCliVersion: 'e2e',
        deps: { node: 'test', aniCli: true, mpv: false, androidActivityManager: false, clientPlayback: true },
      }));
    }
    if (p === '/api/settings' && method === 'GET') return route.fulfill(jsonBody(settings));
    if (p === '/api/settings' && method === 'POST') return route.fulfill(jsonBody({ ...settings, ...body() }));
    if (p === '/api/progress' && method === 'GET') return route.fulfill(jsonBody({ positions }));
    if (p === '/api/progress' && method === 'POST') return route.fulfill(jsonBody({ ok: true }));
    if (p === '/api/library') return route.fulfill(jsonBody({ shows: library }));
    if (p === '/api/downloads' && method === 'GET') {
      return route.fulfill(jsonBody({ downloadDir: '/data/downloads', downloads }));
    }
    if (p === '/api/release-watches' && method === 'GET') return route.fulfill(jsonBody({ watches: releaseWatches }));
    if (p === '/api/release-watches/check') return route.fulfill(jsonBody({ watches: releaseWatches, found: [] }));
    if (p === '/api/jobs' && method === 'GET') return route.fulfill(jsonBody({ jobs }));
    if (p === '/api/jobs' && method === 'DELETE') return route.fulfill(jsonBody({ ok: true }));
    if (p === '/api/skip-times' && method === 'GET') {
      const skip = typeof skipTimes === 'function' ? skipTimes(url) : skipTimes;
      return route.fulfill(jsonBody({ skip }));
    }

    // --- discover ---
    if (p === '/api/search') {
      return route.fulfill(jsonBody({ results: overrides.searchResults || [searchResult(url.searchParams.get('q'))] }));
    }
    if (p === '/api/popular' || p === '/api/recommendations') {
      return route.fulfill(jsonBody({ results: overrides.searchResults || [searchResult(null)] }));
    }

    // --- show details / episodes ---
    if (/^\/api\/shows\/[^/]+\/episodes$/.test(p)) {
      return route.fulfill(jsonBody({
        episodes: ['1', '2', '3'],
        latestEpisode: '3',
        name: 'Library Test Show',
        episodeTitles: { 1: 'Pilot', 2: 'Second', 3: 'Third' },
      }));
    }
    if (/^\/api\/shows\/([^/]+)\/details$/.test(p)) {
      const id = p.match(/^\/api\/shows\/([^/]+)\/details$/)[1];
      return route.fulfill(jsonBody({ show: detailsFor(decodeURIComponent(id)) }));
    }

    // --- library mutations ---
    if (p === '/api/track' && method === 'POST') return route.fulfill(jsonBody({ show: { ...body(), tracked: true } }));
    if (/^\/api\/shows\/[^/]+$/.test(p) && method === 'DELETE') {
      return route.fulfill(jsonBody({ show: { id: p.split('/').pop(), tracked: false } }));
    }
    if (/^\/api\/shows\/[^/]+$/.test(p) && method === 'PATCH') {
      return route.fulfill(jsonBody({ show: { ...body() } }));
    }
    if (p === '/api/mark' && method === 'POST') return route.fulfill(jsonBody({ show: { ...body(), tracked: true } }));
    if (p === '/api/mark-range' && method === 'POST') return route.fulfill(jsonBody({ show: { ...body(), tracked: true } }));

    // --- release watches ---
    if (p === '/api/release-watches' && method === 'POST') {
      const data = body();
      return route.fulfill(jsonBody({ watch: { id: 'w1', query: data.query, mode: data.mode, status: 'watching' } }));
    }
    if (/^\/api\/release-watches\/[^/]+$/.test(p) && method === 'DELETE') {
      return route.fulfill(jsonBody({ ok: true }));
    }

    // --- downloads mutations / playback ---
    if (/^\/api\/downloads\/[^/]+\/[^/]+\/playback$/.test(p)) {
      if (localPlayback) return route.fulfill(jsonBody({ playback: localPlayback }));
      return route.fulfill(jsonBody({ error: 'Downloaded episode not found' }, 404));
    }
    if (/^\/api\/downloads\/[^/]+\/[^/]+$/.test(p) && method === 'DELETE') {
      return route.fulfill(jsonBody({ download: { status: 'deleted' } }));
    }
    if (/^\/api\/downloads\/[^/]+$/.test(p) && method === 'DELETE') {
      return route.fulfill(jsonBody({ deleted: 1, cancelled: 0 }));
    }
    if (p === '/api/download' && method === 'POST') {
      return route.fulfill(jsonBody({ job: { id: 'job1', status: 'queued' }, download: { key: 'lib1:1', status: 'queued' } }));
    }
    if (p === '/api/download-season' && method === 'POST') {
      return route.fulfill(jsonBody({ queued: [{ episode: '1' }, { episode: '2' }], concurrency: 2 }));
    }

    // --- playback / command ---
    if (p === '/api/play' && method === 'POST') {
      return route.fulfill(jsonBody({ job: { status: 'done' }, playback: { url: '/e2e-blank.mp4', title: 'E2E playback' } }));
    }
    if (p === '/api/command' && method === 'POST') {
      return route.fulfill(jsonBody({ job: { id: 'cmd1', status: 'launched' } }));
    }

    return route.fulfill(jsonBody({}));
  });
}

module.exports = { installApiMocks, makeShow, DEFAULT_SETTINGS, LIBRARY_SHOW };
