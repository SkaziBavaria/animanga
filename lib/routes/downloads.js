'use strict';

const { DOWNLOAD_DIR, DOWNLOAD_CONCURRENCY } = require('../config');
const { sendJson, sendError, readBody } = require('../http');
const { readState, saveState } = require('../state');
const { normalizeMode, normalizeEpisode, compareEpisodes } = require('../episodes');
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
  expectedDownloadPath,
} = require('../downloads');
const { getShowDetails } = require('../allanime');
const { createEpisodeDownloadTask } = require('../anime-download');
const { listDownloads: listMangaDownloads } = require('../manga-cache');
const { startBackgroundTask } = require('../jobs');
const { touchShow } = require('./shared');
const { requiredString } = require('../validation');

async function queueDownload(state, details, episode, mode, quality) {
  const key = downloadKey(details.id, episode);
  const task = createEpisodeDownloadTask({
    showId: details.id,
    episode,
    mode,
    quality,
    outputPath: expectedDownloadPath(details, episode),
  });
  const label = `Download ${details.name || details.title} ep ${episode}`;
  const job = startBackgroundTask(label, task, (updatedJob) => updateDownloadRecord(key, updatedJob));
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


async function handleDownloadRoutes(req, res, url) {
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

  if (req.method === 'POST' && url.pathname === '/api/download') {
    const body = await readBody(req);
    const state = readState();
    const mode = normalizeMode(body.mode || state.settings.mode);
    requiredString(body, 'id', { label: 'show id' });
    requiredString(body, 'episode');

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
    requiredString(body, 'id', { label: 'show id' });

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

  return sendError(res, 404, 'Download endpoint missing');
}

module.exports = { handleDownloadRoutes };
