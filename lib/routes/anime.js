'use strict';

const { sendJson, sendError, readBody } = require('../http');
const {
  readState,
  saveState,
  updateShowWatched,
  savePositionAtomic,
} = require('../state');
const {
  cleanTitle,
  normalizeMode,
  episodeKey,
  episodesThrough,
  highestEpisode,
} = require('../episodes');
const {
  searchAnime,
  popularAnime,
  getShowDetails,
  getCachedShowDetails,
  recommendedAnime,
} = require('../allanime');
const {
  mergeShow,
  presentShow,
  presentReleaseWatch,
  createReleaseWatch,
  checkReleaseWatch,
  refreshShow,
} = require('../library');
const { presentPositions, presentMangaPositions } = require('../progress');
const { getSkipTimesForTitle } = require('../aniskip');
const { requiredString } = require('../validation');
const {
  touchShow,
  cachedEpisodeDetails,
  cacheMetadata,
  freshCacheEntry,
} = require('./shared');

async function handleAnimeRoutes(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/library') {
    const state = readState();
    const refresh = url.searchParams.get('refresh') === '1';
    let shows = Object.values(state.shows).filter((show) => show.tracked !== false);
    if (refresh) {
      const refreshed = [];
      for (const show of shows) {
        try {
          refreshed.push(await refreshShow(state, show));
        } catch (err) {
          refreshed.push({ ...presentShow(show), refreshError: err.message });
        }
      }
      saveState(state);
      shows = refreshed;
    } else {
      shows = shows.map(presentShow);
    }
    shows.sort((a, b) => (b.newCount - a.newCount) || String(a.name).localeCompare(String(b.name)));
    return sendJson(res, 200, { shows });
  }

  if (req.method === 'GET' && url.pathname === '/api/search') {
    const results = await searchAnime(
      url.searchParams.get('q'),
      url.searchParams.get('mode') || readState().settings.mode,
      {
        genres: url.searchParams.getAll('genre'),
        year: url.searchParams.get('year'),
      }
    );
    return sendJson(res, 200, { results });
  }

  if (req.method === 'GET' && url.pathname === '/api/popular') {
    const mode = url.searchParams.get('mode') || readState().settings.mode;
    const range = url.searchParams.get('range') || '0';
    const results = await popularAnime(range, mode);
    return sendJson(res, 200, { results });
  }

  if (req.method === 'GET' && url.pathname === '/api/skip-times') {
    const title = url.searchParams.get('title') || '';
    const episode = url.searchParams.get('episode') || '';
    const duration = Number(url.searchParams.get('duration') || 0);
    if (!title || !episode) return sendError(res, 422, 'Missing title or episode');
    const state = readState();
    const skip = await getSkipTimesForTitle(state, title, episode, duration);
    saveState(state);
    return sendJson(res, 200, { skip });
  }

  if (req.method === 'GET' && url.pathname === '/api/recommendations') {
    const state = readState();
    const mode = url.searchParams.get('mode') || state.settings.mode;
    const results = await recommendedAnime(state, mode);
    saveState(state);
    return sendJson(res, 200, { results });
  }

  if (req.method === 'GET' && url.pathname === '/api/release-watches') {
    const state = readState();
    const watches = Object.values(state.releaseWatches)
      .map(presentReleaseWatch)
      .sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')));
    return sendJson(res, 200, { watches });
  }

  if (req.method === 'POST' && url.pathname === '/api/release-watches') {
    const body = await readBody(req);
    const state = readState();
    const query = requiredString(body, 'query', { maxLength: 200 });
    const watch = createReleaseWatch(state, query, body.mode || state.settings.mode);
    saveState(state);
    return sendJson(res, 200, { watch: presentReleaseWatch(watch) });
  }

  if (req.method === 'POST' && url.pathname === '/api/release-watches/check') {
    const state = readState();
    const watches = Object.values(state.releaseWatches || {});
    const checked = [];
    for (const watch of watches) {
      checked.push(await checkReleaseWatch(state, watch));
    }
    saveState(state);
    return sendJson(res, 200, {
      watches: checked.map(presentReleaseWatch),
      found: checked.filter((watch) => watch.status === 'found').map(presentReleaseWatch),
    });
  }

  const releaseWatchMatch = url.pathname.match(/^\/api\/release-watches\/([^/]+)$/);
  if (req.method === 'DELETE' && releaseWatchMatch) {
    const id = decodeURIComponent(releaseWatchMatch[1]);
    const state = readState();
    if (!state.releaseWatches[id]) return sendError(res, 404, 'Release watch not found');
    delete state.releaseWatches[id];
    saveState(state);
    return sendJson(res, 200, { ok: true });
  }

  const episodeMatch = url.pathname.match(/^\/api\/shows\/([^/]+)\/episodes$/);
  if (req.method === 'GET' && episodeMatch) {
    const id = decodeURIComponent(episodeMatch[1]);
    const state = readState();
    const mode = url.searchParams.get('mode') || state.settings.mode;
    const cacheKey = `${normalizeMode(mode)}:base:${id}`;
    const cachedBefore = freshCacheEntry(state, cacheKey);
    try {
      const details = await getCachedShowDetails(state, id, mode);
      const episodes = details.episodes;
      if (touchShow(state, id, details)) saveState(state);
      return sendJson(res, 200, {
        ...details,
        episodes,
        latestEpisode: highestEpisode(episodes),
        cache: cacheMetadata(cachedBefore, { cached: Boolean(cachedBefore) }),
      });
    } catch (err) {
      const cached = cachedEpisodeDetails(state.shows[id]);
      if (!cached) throw err;
      return sendJson(res, 200, {
        ...cached,
        cache: cacheMetadata(state.cache?.details?.[cacheKey], {
          cached: true,
          offline: true,
          stale: true,
          fetchedAt: cached.lastCheckedAt || cached.updatedAt,
        }),
      });
    }
  }

  const detailsMatch = url.pathname.match(/^\/api\/shows\/([^/]+)\/details$/);
  if (req.method === 'GET' && detailsMatch) {
    const id = decodeURIComponent(detailsMatch[1]);
    const mode = url.searchParams.get('mode') || readState().settings.mode;
    const state = readState();
    const cacheKey = `${normalizeMode(mode)}:relations:${id}`;
    const cachedBefore = freshCacheEntry(state, cacheKey);
    try {
      const details = await getCachedShowDetails(state, id, mode, { includeRelations: true });
      if (touchShow(state, id, details)) saveState(state);
      return sendJson(res, 200, {
        show: presentShow(details),
        cache: cacheMetadata(cachedBefore, { cached: Boolean(cachedBefore) }),
      });
    } catch (err) {
      const cached = state.shows[id];
      if (!cached) throw err;
      return sendJson(res, 200, {
        show: presentShow(cached),
        cached: true,
        offline: true,
        cache: cacheMetadata(state.cache?.details?.[cacheKey], {
          cached: true,
          offline: true,
          stale: true,
          fetchedAt: cached.lastCheckedAt || cached.updatedAt,
        }),
      });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/track') {
    const body = await readBody(req);
    requiredString(body, 'id', { label: 'show id' });
    const state = readState();
    const show = mergeShow(state, { ...body, tracked: body.tracked ?? true });
    saveState(state);
    return sendJson(res, 200, { show: presentShow(show) });
  }

  const showMatch = url.pathname.match(/^\/api\/shows\/([^/]+)$/);
  if (req.method === 'DELETE' && showMatch) {
    const id = decodeURIComponent(showMatch[1]);
    const state = readState();
    const existing = state.shows[id] || { id };
    const show = mergeShow(state, { ...existing, id, tracked: false });
    saveState(state);
    return sendJson(res, 200, { show: presentShow(show) });
  }

  if (req.method === 'PATCH' && showMatch) {
    const id = decodeURIComponent(showMatch[1]);
    const body = await readBody(req);
    const state = readState();
    const existing = state.shows[id] || { id };
    const patch = { ...existing };
    if (Object.hasOwn(body, 'name')) patch.customName = body.name ? cleanTitle(body.name) : '';
    if (Object.hasOwn(body, 'mode')) {
      const mode = normalizeMode(body.mode);
      const details = await getCachedShowDetails(state, id, mode);
      if (!details.episodes?.length) return sendError(res, 422, `No ${mode.toUpperCase()} episodes are available for this anime`);
      Object.assign(patch, details, { mode });
    }
    const show = mergeShow(state, patch);
    saveState(state);
    return sendJson(res, 200, { show: presentShow(show) });
  }

  if (req.method === 'GET' && url.pathname === '/api/progress') {
    const state = readState();
    return sendJson(res, 200, {
      positions: presentPositions(state),
      mangaPositions: presentMangaPositions(state),
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/progress') {
    const body = await readBody(req);
    requiredString(body, 'id', { label: 'show id' });
    requiredString(body, 'episode');
    const result = savePositionAtomic(body);
    return sendJson(res, 200, { ok: true, ...result });
  }

  if (req.method === 'POST' && url.pathname === '/api/mark') {
    const body = await readBody(req);
    requiredString(body, 'id', { label: 'show id' });
    const state = readState();
    const existing = state.shows[body.id] || {};
    const ep = episodeKey(body.episode);
    if (!ep) throw new Error('Missing episode');
    const candidate = mergeShow(state, {
      ...existing,
      ...body,
      tracked: true,
    });
    const show = updateShowWatched(body.id, (watched) => {
      if (body.watched === false) watched.delete(ep);
      else watched.add(ep);
    }, candidate);
    return sendJson(res, 200, { show: presentShow(show) });
  }

  if (req.method === 'POST' && url.pathname === '/api/mark-range') {
    const body = await readBody(req);
    requiredString(body, 'id', { label: 'show id' });
    requiredString(body, 'episode');
    const state = readState();
    const existing = state.shows[body.id] || {};
    const mode = normalizeMode(body.mode || existing.mode || state.settings.mode);
    const target = episodeKey(body.episode);
    const targetValue = Number(target);

    if (Number.isFinite(targetValue) && targetValue <= 0) {
      const candidate = mergeShow(state, {
        ...existing,
        ...body,
        mode,
        tracked: true,
      });
      const show = updateShowWatched(body.id, (watched) => {
        for (const episode of watched) {
          if (Number.isFinite(Number(episode))) watched.delete(episode);
        }
      }, candidate);
      return sendJson(res, 200, { show: presentShow(show) });
    }

    let details;
    try {
      details = await getShowDetails(body.id, mode);
    } catch {
      details = { episodes: existing.episodes || [] };
    }

    const candidate = mergeShow(state, {
      ...existing,
      ...details,
      ...body,
      mode,
      tracked: true,
    });
    const throughTarget = episodesThrough(details.episodes || existing.episodes || [], target).map(episodeKey);
    const show = updateShowWatched(body.id, (watched) => {
      for (const episode of watched) {
        if (Number.isFinite(Number(episode))) watched.delete(episode);
      }
      for (const episode of throughTarget) watched.add(episode);
    }, candidate);
    return sendJson(res, 200, { show: presentShow(show) });
  }
}

module.exports = { handleAnimeRoutes, cachedEpisodeDetails };
