'use strict';

const { spawnSync } = require('child_process');
const {
  ANI_CLI,
  HISTORY_FILE,
  HOST,
  PORT,
  DOWNLOAD_DIR,
  DOWNLOAD_CONCURRENCY,
} = require('./config');
const registry = require('./registry');
const { sendJson, sendError, readBody } = require('./http');
const { readState, saveState, recentJobs } = require('./state');
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
const { setPosition, presentPositions } = require('./progress');
const { getSkipTimesForTitle } = require('./aniskip');

function touchShow(state, id, details) {
  if (!state.shows[id]) return false;
  mergeShow(state, { ...state.shows[id], ...details, lastCheckedAt: new Date().toISOString() });
  return true;
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

async function handleApi(req, res, url) {
  try {
    if (req.method === 'GET' && url.pathname === '/api/status') {
      const version = spawnSync(ANI_CLI, ['--version'], { encoding: 'utf8' });
      return sendJson(res, 200, {
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
      });
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
      const results = await searchAnime(url.searchParams.get('q'), url.searchParams.get('mode') || readState().settings.mode);
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
      });
    }

    const episodeMatch = url.pathname.match(/^\/api\/shows\/([^/]+)\/episodes$/);
    if (req.method === 'GET' && episodeMatch) {
      const id = decodeURIComponent(episodeMatch[1]);
      const mode = url.searchParams.get('mode') || readState().settings.mode;
      const details = await getShowDetails(id, mode);
      const episodes = details.episodes;
      const state = readState();
      if (touchShow(state, id, details)) saveState(state);
      return sendJson(res, 200, { ...details, episodes, latestEpisode: highestEpisode(episodes) });
    }

    const detailsMatch = url.pathname.match(/^\/api\/shows\/([^/]+)\/details$/);
    if (req.method === 'GET' && detailsMatch) {
      const id = decodeURIComponent(detailsMatch[1]);
      const mode = url.searchParams.get('mode') || readState().settings.mode;
      const state = readState();
      const details = await getCachedShowDetails(state, id, mode, { includeRelations: true });
      if (touchShow(state, id, details)) saveState(state);
      return sendJson(res, 200, { show: presentShow(details) });
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
      const show = mergeShow(state, {
        ...existing,
        customName: body.name ? cleanTitle(body.name) : '',
      });
      saveState(state);
      return sendJson(res, 200, { show: presentShow(show) });
    }

    if (req.method === 'GET' && url.pathname === '/api/progress') {
      const state = readState();
      return sendJson(res, 200, { positions: presentPositions(state) });
    }

    if (req.method === 'POST' && url.pathname === '/api/progress') {
      const body = await readBody(req);
      const state = readState();
      const result = setPosition(state, body);
      saveState(state);
      return sendJson(res, 200, { ok: true, ...result });
    }

    if (req.method === 'POST' && url.pathname === '/api/mark') {
      const body = await readBody(req);
      const state = readState();
      const existing = state.shows[body.id] || {};
      const watched = new Set(existing.watchedEpisodes || []);
      const ep = episodeKey(body.episode);
      if (!ep) throw new Error('Missing episode');
      if (body.watched === false) watched.delete(ep);
      else watched.add(ep);
      const lastWatched = highestEpisode(Array.from(watched)) || '';
      const show = mergeShow(state, {
        ...existing,
        ...body,
        watchedEpisodes: Array.from(watched),
        lastWatched,
        tracked: true,
      }, { replaceWatchedEpisodes: true });
      writeHistoryEntry(show, lastWatched);
      saveState(state);
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
        const watched = (existing.watchedEpisodes || []).filter((episode) => !Number.isFinite(Number(episode)));
        const show = mergeShow(state, {
          ...existing,
          ...body,
          mode,
          watchedEpisodes: watched,
          lastWatched: '',
          tracked: true,
        }, { replaceWatchedEpisodes: true });
        writeHistoryEntry(show, '');
        saveState(state);
        return sendJson(res, 200, { show: presentShow(show) });
      }

      let details = {};
      try {
        details = await getShowDetails(body.id, mode);
      } catch {
        details = { episodes: existing.episodes || [] };
      }

      const watched = new Set(
        (existing.watchedEpisodes || []).filter((episode) => !Number.isFinite(Number(episode)))
      );
      for (const episode of episodesThrough(details.episodes || existing.episodes || [], target)) {
        watched.add(episodeKey(episode));
      }

      const show = mergeShow(state, {
        ...existing,
        ...details,
        ...body,
        mode,
        watchedEpisodes: Array.from(watched),
        lastWatched: target,
        tracked: true,
      }, { replaceWatchedEpisodes: true });
      writeHistoryEntry(show, target);
      saveState(state);
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

      if (state.settings.autoTrackPlayed !== false && !body.resolveOnly && body.id && body.episode) {
        const existing = state.shows[body.id] || {};
        const watched = new Set(existing.watchedEpisodes || []);
        watched.add(episodeKey(body.episode));
        const show = mergeShow(state, {
          ...existing,
          ...(details || {}),
          ...body,
          mode,
          watchedEpisodes: Array.from(watched),
          lastWatched: body.episode,
          tracked: true,
        });
        writeHistoryEntry(show, body.episode);
        saveState(state);
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
};
