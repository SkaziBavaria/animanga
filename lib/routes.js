'use strict';

const fs = require('fs');
const { spawnSync } = require('child_process');
const {
  ANI_CLI,
  HISTORY_FILE,
  HOST,
  PORT,
  DOWNLOAD_DIR,
  DOWNLOAD_CONCURRENCY,
  DETAIL_CACHE_TTL_MS,
} = require('./config');
const registry = require('./registry');
const { sendJson, sendError, readBody } = require('./http');
const {
  readState,
  saveState,
  recentJobs,
  updateShowWatched,
  savePositionAtomic,
  saveMangaPositionAtomic,
  updateMangaRead,
  updateMangaReadBatch,
  backupStatus,
} = require('./state');
const {
  cleanTitle,
  aniCliQueryTitle,
  normalizeMode,
  normalizeEpisode,
  episodeKey,
  episodesThrough,
  compareEpisodes,
  highestEpisode,
} = require('./episodes');
const { commandExists } = require('./process');
const {
  downloadKey,
  downloadStatus,
  isDownloadBusy,
  refreshDownloadRecords,
  reconcileDownloads,
  updateDownloadRecord,
  createDownloadRecord,
  cancelQueuedDownload,
  cancelRunningDownload,
  removeDownloadFiles,
  streamDownloadFile,
  isInsideDownloadDir,
  ensureShowDownloadDir,
} = require('./downloads');
const {
  searchAnime,
  popularAnime,
  getShowDetails,
  getCachedShowDetails,
  recommendedAnime,
} = require('./allanime');
const { searchManga, popularManga, getMangaDetails, getChapterPages } = require('./allmanga');
const {
  mergeManga,
  presentManga,
  refreshManga,
  presentMangaReleaseWatch,
  createMangaReleaseWatch,
  checkMangaReleaseWatch,
} = require('./manga-library');
const {
  cacheChapter,
  readManifest,
  presentPages,
  downloadChapter,
  listDownloads: listMangaDownloads,
  cachedChapterDates,
  localPage: localMangaPage,
  deleteDownload: deleteMangaDownload,
} = require('./manga-cache');
const {
  MAX_BATCH_CHAPTERS,
  startMangaDownloadBatch,
  listMangaDownloadJobs,
  cancelMangaDownloadJob,
} = require('./manga-download-jobs');
const {
  writeHistoryEntry,
  mergeShow,
  seedStateFromHistory,
  presentShow,
  presentReleaseWatch,
  createReleaseWatch,
  checkReleaseWatch,
  refreshShow,
} = require('./library');
const {
  buildAniCliArgs,
  parseDebugPlayback,
  clientPlaybackEnabled,
  resolvePlaybackMode,
  startJob,
  startPtyJob,
  startBackgroundJob,
  hydrateJobLog,
  clearJobLogs,
  runJobAndWait,
  parseArgsLine,
} = require('./jobs');
const { proxyStream } = require('./proxy');
const { presentPositions, presentMangaPositions } = require('./progress');
const { getSkipTimesForTitle } = require('./aniskip');
const {
  publicConfig: syncPublicConfig,
  configure: configureSync,
  disconnect: disconnectSync,
  authorizationUrl,
  finishAuthorization,
  syncNow,
  setProvider: setSyncProvider,
  configureGithub,
  disconnectGithub,
  startGithubAuthorization,
  pollGithubAuthorization,
} = require('./sync');

const STATUS_CACHE_MS = 30000;
let cachedStatus = null;
let cachedStatusAt = 0;

function requestOrigin(req) {
  const protocol = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() || 'http';
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || `${HOST}:${PORT}`).split(',')[0].trim();
  return `${protocol}://${host}`;
}

function syncCallbackUrl(req) {
  return `${requestOrigin(req)}/api/sync/google/callback`;
}

function touchShow(state, id, details) {
  if (!state.shows[id]) return false;
  mergeShow(state, { ...state.shows[id], ...details, lastCheckedAt: new Date().toISOString() });
  return true;
}

function cachedEpisodeDetails(show) {
  if (!show) return null;
  const latest = show.latestEpisode || show.episodeCount;
  const episodes = show.episodes?.length ? show.episodes : episodesThrough([], latest);
  if (!episodes.length) return null;
  return {
    ...show,
    episodes,
    latestEpisode: highestEpisode(episodes) || latest || null,
    cached: true,
    offline: true,
  };
}

function cacheMetadata(entry, options = {}) {
  const fetchedAt = entry?.createdAt || options.fetchedAt || null;
  const ageSeconds = fetchedAt
    ? Math.max(0, Math.floor((Date.now() - Date.parse(fetchedAt)) / 1000))
    : null;
  return {
    cached: Boolean(options.cached),
    offline: Boolean(options.offline),
    stale: Boolean(options.stale),
    fetchedAt,
    ageSeconds: Number.isFinite(ageSeconds) ? ageSeconds : null,
  };
}

function freshCacheEntry(state, key) {
  const entry = state.cache?.details?.[key] || null;
  if (!entry?.createdAt) return null;
  return Date.now() - Date.parse(entry.createdAt) < DETAIL_CACHE_TTL_MS ? entry : null;
}

async function queueDownload(state, details, episode, mode, quality) {
  const key = downloadKey(details.id, episode);
  const args = await buildAniCliArgs({
    id: details.id,
    episode,
    ...details,
    mode,
    download: true,
    player: 'default',
    quality,
  });
  const label = `Download ${details.name || details.title} ep ${episode}`;
  const downloadEnv = { ANI_CLI_DOWNLOAD_DIR: ensureShowDownloadDir(details) };
  const job = startBackgroundJob(label, args, downloadEnv, (updatedJob) => updateDownloadRecord(key, updatedJob));
  return createDownloadRecord(state, details, episode, mode, job);
}

function resolveDoneDownload(state, showId, episode, { reconcile = false } = {}) {
  const key = downloadKey(showId, episode);
  if (reconcile && !state.downloads?.[key]) {
    reconcileDownloads(state);
    saveState(state);
  }
  const record = downloadStatus(state.downloads?.[key]);
  if (!record || record.status !== 'done' || !record.file?.path) {
    return { error: [404, 'Downloaded episode not found'] };
  }
  if (!isInsideDownloadDir(record.file.path)) {
    return { error: [403, 'Download path is outside the download directory'] };
  }
  return { record };
}

function markRecordDeleted(record) {
  const now = new Date().toISOString();
  return { ...record, status: 'deleted', file: null, deletedAt: now, updatedAt: now };
}

function statusPayload() {
  const now = Date.now();
  if (cachedStatus && now - cachedStatusAt < STATUS_CACHE_MS) return cachedStatus;

  const version = spawnSync(ANI_CLI, ['--version'], { encoding: 'utf8' });
  cachedStatus = {
    ok: true,
    aniCli: ANI_CLI,
    aniCliVersion: version.stdout?.trim() || null,
    historyFile: HISTORY_FILE,
    host: HOST,
    port: PORT,
    deps: {
      node: process.version,
      aniCli: version.status === 0,
      mpv: commandExists('mpv'),
      androidActivityManager: commandExists('am'),
      clientPlayback: clientPlaybackEnabled(),
    },
    backup: backupStatus(),
  };
  cachedStatusAt = now;
  return cachedStatus;
}

async function handleApi(req, res, url) {
  try {
    if (req.method === 'GET' && url.pathname === '/api/status') {
      return sendJson(res, 200, statusPayload());
    }

    if (req.method === 'GET' && url.pathname === '/api/sync') {
      return sendJson(res, 200, syncPublicConfig(syncCallbackUrl(req)));
    }

    if (req.method === 'POST' && url.pathname === '/api/sync/config') {
      const body = await readBody(req);
      configureSync(body);
      return sendJson(res, 200, syncPublicConfig(syncCallbackUrl(req)));
    }

    if (req.method === 'POST' && url.pathname === '/api/sync/provider') {
      const body = await readBody(req);
      setSyncProvider(body.provider);
      return sendJson(res, 200, syncPublicConfig(syncCallbackUrl(req)));
    }

    if (req.method === 'POST' && url.pathname === '/api/sync/github/config') {
      const body = await readBody(req);
      configureGithub(body);
      return sendJson(res, 200, syncPublicConfig(syncCallbackUrl(req)));
    }

    if (req.method === 'POST' && url.pathname === '/api/sync/github/connect') {
      return sendJson(res, 200, { deviceAuth: await startGithubAuthorization() });
    }

    if (req.method === 'GET' && url.pathname === '/api/sync/github/poll') {
      return sendJson(res, 200, { deviceAuth: await pollGithubAuthorization(), config: syncPublicConfig(syncCallbackUrl(req)) });
    }

    if (req.method === 'POST' && url.pathname === '/api/sync/github/disconnect') {
      disconnectGithub();
      return sendJson(res, 200, syncPublicConfig(syncCallbackUrl(req)));
    }

    if (req.method === 'POST' && url.pathname === '/api/sync/disconnect') {
      disconnectSync();
      return sendJson(res, 200, syncPublicConfig(syncCallbackUrl(req)));
    }

    if (req.method === 'GET' && url.pathname === '/api/sync/google/connect') {
      return sendJson(res, 200, { url: authorizationUrl(syncCallbackUrl(req)) });
    }

    if (req.method === 'GET' && url.pathname === '/api/sync/google/callback') {
      if (url.searchParams.get('error')) throw new Error(`Google authorization: ${url.searchParams.get('error')}`);
      await finishAuthorization({
        code: url.searchParams.get('code'),
        state: url.searchParams.get('state'),
        callbackUrl: syncCallbackUrl(req),
      });
      res.writeHead(302, { location: '/?sync=connected', 'cache-control': 'no-store' });
      res.end();
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/sync/run') {
      return sendJson(res, 200, await syncNow());
    }

    if (req.method === 'GET' && url.pathname === '/api/settings') {
      return sendJson(res, 200, readState().settings);
    }

    if (req.method === 'POST' && url.pathname === '/api/settings') {
      const body = await readBody(req);
      const state = readState();
      state.settings = { ...state.settings, ...body };
      saveState(state);
      return sendJson(res, 200, state.settings);
    }

    if (req.method === 'GET' && url.pathname === '/api/library') {
      const state = readState();
      seedStateFromHistory(state);
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

    if (req.method === 'GET' && url.pathname === '/api/manga/library') {
      const state = readState();
      let mangas = Object.values(state.mangas).filter((manga) => manga.tracked !== false);
      if (url.searchParams.get('refresh') === '1') {
        const refreshed = [];
        for (const manga of mangas) {
          try {
            refreshed.push(await refreshManga(state, manga));
          } catch (err) {
            refreshed.push({ ...presentManga(manga), refreshError: err.message });
          }
        }
        saveState(state);
        mangas = refreshed;
      } else {
        mangas = mangas.map(presentManga);
      }
      mangas = mangas.map((manga) => ({
        ...manga,
        downloadedChapters: listMangaDownloads(manga.id, manga.language || 'sub').length,
      }));
      mangas.sort((a, b) => Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0) || String(a.name).localeCompare(String(b.name)));
      return sendJson(res, 200, { mangas });
    }

    if (req.method === 'GET' && url.pathname === '/api/manga/search') {
      const result = await searchManga(url.searchParams.get('q') || '', {
        page: Number(url.searchParams.get('page') || 1),
        language: url.searchParams.get('language') || 'sub',
        sortBy: url.searchParams.get('sort') || 'Latest_Update',
        genres: url.searchParams.getAll('genre'),
        year: url.searchParams.get('year') || null,
      });
      return sendJson(res, 200, result);
    }

    if (req.method === 'GET' && url.pathname === '/api/manga/popular') {
      return sendJson(res, 200, await popularManga(Number(url.searchParams.get('range') || 0), {
        language: url.searchParams.get('language') || 'sub',
      }));
    }

    if (req.method === 'GET' && url.pathname === '/api/manga/recommendations') {
      const state = readState();
      const genres = Object.values(state.mangas || {}).flatMap((manga) => manga.genres || []);
      const ranked = [...new Set(genres)].sort((a, b) => genres.filter((item) => item === b).length - genres.filter((item) => item === a).length).slice(0, 3);
      return sendJson(res, 200, await searchManga('', { genres: ranked, limit: 30, language: 'sub' }));
    }

    if (req.method === 'POST' && url.pathname === '/api/manga/track') {
      const body = await readBody(req);
      const state = readState();
      let details = {};
      try { details = await getMangaDetails(body.id, body.language || 'sub'); } catch {}
      const manga = mergeManga(state, { ...body, ...details, tracked: true });
      saveState(state);
      return sendJson(res, 200, { manga: presentManga(manga) });
    }

    if (req.method === 'POST' && url.pathname === '/api/manga/read') {
      const body = await readBody(req);
      const manga = updateMangaRead(body.id, body.chapter, body.read !== false, body.manga || {});
      return sendJson(res, 200, { manga: presentManga(manga) });
    }

    if (req.method === 'POST' && url.pathname === '/api/manga/read-through') {
      const body = await readBody(req);
      const target = episodeKey(body.chapter);
      if (!body.id) throw new Error('Missing manga id');
      if (!target || !Number.isFinite(Number(target))) throw new Error('Invalid target chapter');
      const state = readState();
      const existing = state.mangas[body.id] || {};
      let details = {};
      try {
        details = await getMangaDetails(body.id, existing.language || body.manga?.language || 'sub');
      } catch {
        details = {};
      }
      const availableChapters = details.chapters?.length
        ? details.chapters
        : body.chapters?.length
          ? body.chapters
          : existing.chapters || [];
      if (!availableChapters.length) throw new Error('Chapter list unavailable');
      const throughTarget = episodesThrough(availableChapters, target).map(episodeKey);
      const previouslyRead = new Set((existing.readChapters || []).map(String));
      const manga = updateMangaReadBatch(body.id, throughTarget, true, {
        ...existing,
        ...details,
        ...(body.manga || {}),
        chapters: availableChapters,
        tracked: true,
      });
      const marked = throughTarget.filter((chapter) => !previouslyRead.has(chapter)).length;
      return sendJson(res, 200, { manga: presentManga(manga), marked });
    }

    const mangaDetailsMatch = url.pathname.match(/^\/api\/manga\/([^/]+)\/details$/);
    if (req.method === 'GET' && mangaDetailsMatch) {
      const id = decodeURIComponent(mangaDetailsMatch[1]);
      const state = readState();
      const existing = state.mangas[id] || {};
      const language = (url.searchParams.get('language') || existing.language) === 'raw' ? 'raw' : 'sub';
      const details = await getMangaDetails(id, language);
      const manga = existing.id ? mergeManga(state, { ...existing, ...details }) : { ...existing, ...details };
      if (existing.id) saveState(state);
      return sendJson(res, 200, { manga: presentManga(manga) });
    }

    const mangaChaptersMatch = url.pathname.match(/^\/api\/manga\/([^/]+)\/chapters$/);
    if (req.method === 'GET' && mangaChaptersMatch) {
      const id = decodeURIComponent(mangaChaptersMatch[1]);
      const state = readState();
      const existing = state.mangas[id] || {};
      const language = (url.searchParams.get('language') || existing.language) === 'raw' ? 'raw' : 'sub';
      const details = await getMangaDetails(id, language);
      const manga = existing.id ? mergeManga(state, { ...existing, ...details }) : { ...existing, ...details };
      if (existing.id) saveState(state);
      const chapterDates = cachedChapterDates(id, language);
      if (details.latestChapter && details.lastChapterDate) chapterDates[String(details.latestChapter)] = details.lastChapterDate;
      return sendJson(res, 200, { manga: presentManga({ ...manga, chapterDates }), chapters: details.chapters, chapterDates });
    }

    const mangaDownloadsMatch = url.pathname.match(/^\/api\/manga\/([^/]+)\/downloads$/);
    if (req.method === 'GET' && mangaDownloadsMatch) {
      const id = decodeURIComponent(mangaDownloadsMatch[1]);
      const state = readState();
      const language = state.mangas[id]?.language || 'sub';
      return sendJson(res, 200, { downloads: listMangaDownloads(id, language) });
    }

    const mangaBatchDownloadMatch = url.pathname.match(/^\/api\/manga\/([^/]+)\/chapters\/download-batch$/);
    if (req.method === 'POST' && mangaBatchDownloadMatch) {
      const id = decodeURIComponent(mangaBatchDownloadMatch[1]);
      const body = await readBody(req);
      const state = readState();
      const manga = state.mangas[id];
      if (!manga) return sendError(res, 404, 'Manga not found');
      const requested = Array.from(new Set((body.chapters || []).map(String).filter(Boolean)));
      if (!requested.length) return sendError(res, 422, 'Select at least one chapter');
      if (requested.length > MAX_BATCH_CHAPTERS) {
        return sendError(res, 422, `A batch can contain at most ${MAX_BATCH_CHAPTERS} chapters`);
      }
      const available = new Set((manga.chapters || []).map(String));
      if (requested.some((chapter) => !available.has(chapter))) {
        return sendError(res, 422, 'One or more selected chapters are unavailable');
      }
      const job = startMangaDownloadBatch({
        mangaId: id,
        mangaName: manga.name || manga.title,
        language: manga.language || 'sub',
        chapters: requested,
      });
      return sendJson(res, 202, { job });
    }

    const mangaDownloadJobsMatch = url.pathname.match(/^\/api\/manga\/([^/]+)\/download-jobs$/);
    if (req.method === 'GET' && mangaDownloadJobsMatch) {
      const id = decodeURIComponent(mangaDownloadJobsMatch[1]);
      return sendJson(res, 200, { jobs: listMangaDownloadJobs(id) });
    }

    const mangaDownloadJobMatch = url.pathname.match(/^\/api\/manga\/([^/]+)\/download-jobs\/([^/]+)$/);
    if (req.method === 'DELETE' && mangaDownloadJobMatch) {
      const id = decodeURIComponent(mangaDownloadJobMatch[1]);
      const jobId = decodeURIComponent(mangaDownloadJobMatch[2]);
      const job = cancelMangaDownloadJob(id, jobId);
      if (!job) return sendError(res, 404, 'Manga download job not found');
      return sendJson(res, 200, { job });
    }

    const mangaDownloadMatch = url.pathname.match(/^\/api\/manga\/([^/]+)\/chapters\/([^/]+)\/download$/);
    if (mangaDownloadMatch && ['POST', 'DELETE'].includes(req.method)) {
      const id = decodeURIComponent(mangaDownloadMatch[1]);
      const chapter = decodeURIComponent(mangaDownloadMatch[2]);
      const state = readState();
      const language = state.mangas[id]?.language || 'sub';
      if (req.method === 'DELETE') {
        return sendJson(res, 200, { deleted: deleteMangaDownload(id, language, chapter) });
      }
      let result = readManifest(id, language, chapter);
      if (!result || result.downloaded) result = await getChapterPages(id, chapter, language);
      const manifest = await downloadChapter(id, language, chapter, result);
      return sendJson(res, 200, { download: { chapter, pages: manifest.pages.length, status: 'done' } });
    }

    const mangaLocalPageMatch = url.pathname.match(/^\/api\/manga\/([^/]+)\/chapters\/([^/]+)\/pages\/([^/]+)$/);
    if (req.method === 'GET' && mangaLocalPageMatch) {
      const id = decodeURIComponent(mangaLocalPageMatch[1]);
      const chapter = decodeURIComponent(mangaLocalPageMatch[2]);
      const number = decodeURIComponent(mangaLocalPageMatch[3]);
      const state = readState();
      const page = localMangaPage(id, state.mangas[id]?.language || 'sub', chapter, number);
      if (!page) return sendError(res, 404, 'Downloaded manga page not found');
      const stat = fs.statSync(page.file);
      res.writeHead(200, { 'content-type': page.contentType, 'content-length': stat.size, 'cache-control': 'private, max-age=31536000, immutable' });
      fs.createReadStream(page.file).pipe(res);
      return;
    }

    const mangaPagesMatch = url.pathname.match(/^\/api\/manga\/([^/]+)\/chapters\/([^/]+)\/pages$/);
    if (req.method === 'GET' && mangaPagesMatch) {
      const id = decodeURIComponent(mangaPagesMatch[1]);
      const chapter = decodeURIComponent(mangaPagesMatch[2]);
      const state = readState();
      const manga = state.mangas[id] || {};
      const language = manga.language || 'sub';
      const cached = readManifest(id, language, chapter);
      if (cached?.downloaded) return sendJson(res, 200, presentPages(id, language, chapter, cached));
      try {
        const result = await getChapterPages(id, chapter, language);
        cacheChapter(id, language, chapter, result);
        return sendJson(res, 200, result);
      } catch (error) {
        if (cached?.pages?.length) return sendJson(res, 200, cached);
        throw error;
      }
    }

    const mangaMatch = url.pathname.match(/^\/api\/manga\/([^/]+)$/);
    if (req.method === 'PATCH' && mangaMatch) {
      const id = decodeURIComponent(mangaMatch[1]);
      const body = await readBody(req);
      const language = body.language === 'raw' ? 'raw' : 'sub';
      const state = readState();
      const existing = state.mangas[id];
      if (!existing) return sendError(res, 404, 'Manga not found');
      const details = await getMangaDetails(id, language);
      const manga = mergeManga(state, { ...existing, ...details, language });
      saveState(state);
      return sendJson(res, 200, { manga: presentManga(manga) });
    }
    if (req.method === 'DELETE' && mangaMatch) {
      const id = decodeURIComponent(mangaMatch[1]);
      const state = readState();
      const manga = mergeManga(state, { ...(state.mangas[id] || { id }), tracked: false });
      saveState(state);
      return sendJson(res, 200, { manga: presentManga(manga) });
    }

    if (req.method === 'GET' && url.pathname === '/api/manga/release-watches') {
      const state = readState();
      const watches = Object.values(state.mangaReleaseWatches)
        .map(presentMangaReleaseWatch)
        .sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')));
      return sendJson(res, 200, { watches });
    }

    if (req.method === 'POST' && url.pathname === '/api/manga/release-watches') {
      const body = await readBody(req);
      const state = readState();
      const watch = createMangaReleaseWatch(state, body.query, body.language || 'sub');
      saveState(state);
      return sendJson(res, 200, { watch: presentMangaReleaseWatch(watch) });
    }

    if (req.method === 'POST' && url.pathname === '/api/manga/release-watches/check') {
      const state = readState();
      const watches = Object.values(state.mangaReleaseWatches || {});
      const checked = [];
      for (const watch of watches) {
        checked.push(await checkMangaReleaseWatch(state, watch));
      }
      saveState(state);
      return sendJson(res, 200, {
        watches: checked.map(presentMangaReleaseWatch),
        found: checked.filter((watch) => watch.status === 'found').map(presentMangaReleaseWatch),
      });
    }

    const mangaReleaseWatchMatch = url.pathname.match(/^\/api\/manga\/release-watches\/([^/]+)$/);
    if (req.method === 'DELETE' && mangaReleaseWatchMatch) {
      const id = decodeURIComponent(mangaReleaseWatchMatch[1]);
      const state = readState();
      if (!state.mangaReleaseWatches[id]) return sendError(res, 404, 'Manga release watch not found');
      delete state.mangaReleaseWatches[id];
      saveState(state);
      return sendJson(res, 200, { ok: true });
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
      const watch = createReleaseWatch(state, body.query, body.mode || state.settings.mode);
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

    if (req.method === 'GET' && url.pathname === '/api/downloads') {
      const state = readState();
      reconcileDownloads(state);
      const downloads = refreshDownloadRecords(state);
      saveState(state);
      return sendJson(res, 200, {
        downloadDir: DOWNLOAD_DIR,
        downloads: Object.fromEntries(Object.entries(downloads).map(([key, record]) => [key, downloadStatus(record)])),
        mangaDownloads: Object.values(state.mangas || {}).flatMap((manga) =>
          listMangaDownloads(manga.id, manga.language || 'sub').map((item) => ({
            ...item,
            mangaId: manga.id,
            mangaName: manga.name || manga.title || 'Manga',
            status: 'done',
          }))),
      });
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
      const result = savePositionAtomic(body);
      return sendJson(res, 200, { ok: true, ...result });
    }

    if (req.method === 'POST' && url.pathname === '/api/manga/progress') {
      const body = await readBody(req);
      const result = saveMangaPositionAtomic(body);
      return sendJson(res, 200, { ok: true, ...result });
    }

    if (req.method === 'POST' && url.pathname === '/api/mark') {
      const body = await readBody(req);
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
      writeHistoryEntry(show, show.lastWatched);
      return sendJson(res, 200, { show: presentShow(show) });
    }

    if (req.method === 'POST' && url.pathname === '/api/mark-range') {
      const body = await readBody(req);
      const state = readState();
      const existing = state.shows[body.id] || {};
      const mode = normalizeMode(body.mode || existing.mode || state.settings.mode);
      const target = episodeKey(body.episode);
      if (!body.id) throw new Error('Missing show id');
      if (!target) throw new Error('Missing episode');
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
        writeHistoryEntry(show, '');
        return sendJson(res, 200, { show: presentShow(show) });
      }

      let details = {};
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
      writeHistoryEntry(show, target);
      return sendJson(res, 200, { show: presentShow(show) });
    }

    if (req.method === 'POST' && url.pathname === '/api/download') {
      const body = await readBody(req);
      const state = readState();
      const mode = normalizeMode(body.mode || state.settings.mode);
      if (!body.id) throw new Error('Missing show id');
      if (!body.episode) throw new Error('Missing episode');

      const details = await getShowDetails(body.id, mode);
      if (!details.episodes.includes(normalizeEpisode(body.episode))) {
        return sendError(res, 422, `Episode ${body.episode} is not available yet`, {
          latestEpisode: details.latestEpisode,
          episodeCount: details.episodeCount,
        });
      }
      touchShow(state, body.id, details);

      const quality = body.quality || state.settings.quality;
      const record = await queueDownload(state, details, body.episode, mode, quality);
      saveState(state);
      return sendJson(res, 200, { job: record.job, download: record });
    }

    if (req.method === 'POST' && url.pathname === '/api/download-season') {
      const body = await readBody(req);
      const state = readState();
      const mode = normalizeMode(body.mode || state.settings.mode);
      if (!body.id) throw new Error('Missing show id');

      const details = await getShowDetails(body.id, mode);
      if (!details.episodes.length) throw new Error('No episodes found');
      touchShow(state, body.id, details);

      refreshDownloadRecords(state);
      const quality = body.quality || state.settings.quality;
      const queued = [];
      for (const episode of details.episodes.sort(compareEpisodes)) {
        const existing = downloadStatus(state.downloads[downloadKey(body.id, episode)]);
        if (existing && ['queued', 'running', 'done'].includes(existing.status)) continue;
        queued.push(await queueDownload(state, details, episode, mode, quality));
      }
      saveState(state);
      return sendJson(res, 200, { queued, concurrency: DOWNLOAD_CONCURRENCY });
    }

    const downloadPlaybackMatch = url.pathname.match(/^\/api\/downloads\/([^/]+)\/([^/]+)\/playback$/);
    if (req.method === 'GET' && downloadPlaybackMatch) {
      const showId = decodeURIComponent(downloadPlaybackMatch[1]);
      const episode = decodeURIComponent(downloadPlaybackMatch[2]);
      const state = readState();
      const { record, error } = resolveDoneDownload(state, showId, episode, { reconcile: true });
      if (error) return sendError(res, ...error);
      return sendJson(res, 200, {
        playback: {
          local: true,
          url: `/api/downloads/${encodeURIComponent(showId)}/${encodeURIComponent(episode)}/file`,
          title: `${record.showName || 'Video'} ep ${record.episode}`,
        },
      });
    }

    const downloadFileMatch = url.pathname.match(/^\/api\/downloads\/([^/]+)\/([^/]+)\/file$/);
    if (req.method === 'GET' && downloadFileMatch) {
      const showId = decodeURIComponent(downloadFileMatch[1]);
      const episode = decodeURIComponent(downloadFileMatch[2]);
      const state = readState();
      const { record, error } = resolveDoneDownload(state, showId, episode);
      if (error) return sendError(res, ...error);
      return streamDownloadFile(req, res, record.file.path);
    }

    const downloadMatch = url.pathname.match(/^\/api\/downloads\/([^/]+)\/([^/]+)$/);
    if (req.method === 'DELETE' && downloadMatch) {
      const showId = decodeURIComponent(downloadMatch[1]);
      const episode = decodeURIComponent(downloadMatch[2]);
      const key = downloadKey(showId, episode);
      const state = readState();
      const existing = downloadStatus(state.downloads?.[key]);
      if (!existing) return sendError(res, 404, 'Download not found');
      cancelQueuedDownload(existing.jobId);
      cancelRunningDownload(existing.jobId);
      removeDownloadFiles(existing);
      state.downloads[key] = markRecordDeleted(existing);
      saveState(state);
      return sendJson(res, 200, { download: state.downloads[key] });
    }

    const downloadsShowMatch = url.pathname.match(/^\/api\/downloads\/([^/]+)$/);
    if (req.method === 'DELETE' && downloadsShowMatch) {
      const showId = decodeURIComponent(downloadsShowMatch[1]);
      const state = readState();
      refreshDownloadRecords(state);
      let deleted = 0;
      let cancelled = 0;
      for (const [key, record] of Object.entries(state.downloads || {})) {
        if (record.showId !== showId || record.status === 'deleted') continue;
        if (isDownloadBusy(record.status)) {
          if (cancelQueuedDownload(record.jobId) || cancelRunningDownload(record.jobId)) cancelled += 1;
        }
        removeDownloadFiles(record);
        state.downloads[key] = markRecordDeleted(record);
        deleted += 1;
      }
      saveState(state);
      return sendJson(res, 200, { deleted, cancelled });
    }

    if (req.method === 'GET' && url.pathname === '/api/proxy') {
      return proxyStream(req, res, url);
    }

    if (req.method === 'POST' && url.pathname === '/api/play') {
      const body = await readBody(req);
      const state = readState();
      const mode = normalizeMode(body.mode || state.settings.mode);
      let details = null;

      if (body.id && body.episode) {
        details = await getShowDetails(body.id, mode);
        if (!details.episodes.includes(normalizeEpisode(body.episode))) {
          return sendError(res, 422, `Episode ${body.episode} is not available yet`, {
            latestEpisode: details.latestEpisode,
            episodeCount: details.episodeCount,
          });
        }
        if (touchShow(state, body.id, details)) saveState(state);
      }

      const playPayload = {
        id: body.id,
        episode: body.episode,
        mode: body.mode,
        quality: body.quality,
        player: body.player,
        skipIntro: body.skipIntro,
        resolveOnly: body.resolveOnly,
        clientPlayback: body.clientPlayback,
        ...(details || {}),
      };
      let args = await buildAniCliArgs(playPayload);
      const env = {};
      const { useBrowserPlayback, usePtyAniCli } = resolvePlaybackMode(body);
      if (body.player && body.player !== 'default' && body.player !== 'vlc') env.ANI_CLI_PLAYER = body.player;

      let job;
      let playback = null;
      if (useBrowserPlayback) {
        args = await buildAniCliArgs({ ...playPayload, player: 'default' });
        job = await runJobAndWait(`Play ${body.title}`, args, { ANI_CLI_PLAYER: 'debug' });
        if (job.status !== 'done') {
          return sendError(res, 422, 'ani-cli could not fetch the video link', job.output || job.error || job);
        }
        try {
          playback = parseDebugPlayback(job.output || '');
          job.output = `${job.output || ''}\nPlayback URL sent to browser`;
        } catch (err) {
          job.status = 'failed';
          job.error = err.message;
          return sendError(res, 422, 'Could not fetch a playable link', err.message);
        }
      } else if (usePtyAniCli) {
        job = startPtyJob(`Play ${body.title}`, args, env);
      } else {
        job = await runJobAndWait(body.download ? `Download ${body.title}` : `Play ${body.title}`, args, env);
        if (job.status !== 'done') {
          return sendError(res, 422, 'ani-cli could not start the episode', job.output || job.error || job);
        }

        if (/failed to open \/dev\/tty/i.test(job.output || '')) {
          return sendError(res, 422, 'ani-cli got stuck in interactive mode without a terminal', job.output || job);
        }
        if (!/Links Fetched|Playing episode/i.test(job.output || '')) {
          return sendError(res, 422, 'ani-cli exited without clear playback confirmation', job.output || job);
        }
      }

      return sendJson(res, 200, { job, playback });
    }

    if (req.method === 'GET' && url.pathname === '/api/jobs') {
      const state = readState();
      return sendJson(res, 200, { jobs: recentJobs(Array.from(registry.jobs.values()), state.jobs || []).map(hydrateJobLog) });
    }

    if (req.method === 'DELETE' && url.pathname === '/api/jobs') {
      registry.jobs.clear();
      const state = readState();
      state.jobs = [];
      saveState(state);
      clearJobLogs();
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === 'POST' && url.pathname === '/api/command') {
      const body = await readBody(req);
      const args = Array.isArray(body.args) ? body.args.map(String) : parseArgsLine(body.command);
      const job = startJob(`ani-cli ${args.join(' ')}`, args, {}, true);
      return sendJson(res, 200, { job });
    }

    sendError(res, 404, 'API endpoint missing');
  } catch (err) {
    if (!res.headersSent) {
      sendError(res, 500, err.message, process.env.NODE_ENV === 'development' ? err.stack : undefined);
    } else {
      res.destroy();
    }
  }
}

module.exports = {
  handleApi,
  cachedEpisodeDetails,
};
