'use strict';

const crypto = require('crypto');
const registry = require('./registry');
const { getChapterPages } = require('./allmanga');
const { readManifest, downloadChapter } = require('./manga-cache');

const MAX_BATCH_CHAPTERS = 50;
const MANGA_DOWNLOAD_CONCURRENCY = 2;

function presentMangaDownloadJob(job) {
  return {
    id: job.id,
    type: job.type,
    mangaId: job.mangaId,
    label: job.label,
    status: job.status,
    chapters: job.chapters,
    total: job.total,
    completed: job.completed,
    failed: job.failed,
    cancelled: job.cancelled,
    skipped: job.skipped,
    errors: job.errors,
    queuedAt: job.queuedAt,
    startedAt: job.startedAt || null,
    finishedAt: job.finishedAt || null,
    output: job.output,
  };
}

function updateJobOutput(job) {
  const processed = job.completed + job.failed + job.cancelled;
  job.output = `${processed}/${job.total} chapters processed`;
  if (job.skipped) job.output += ` · ${job.skipped} already downloaded`;
}

function finalizeJob(job) {
  if (job.completed + job.failed + job.cancelled < job.total) return;
  if (job.cancelRequested) job.status = 'cancelled';
  else if (job.failed && job.completed) job.status = 'partial';
  else if (job.failed) job.status = 'failed';
  else job.status = 'done';
  job.finishedAt = new Date().toISOString();
  updateJobOutput(job);
}

async function runMangaDownloadTask(item) {
  const { job, chapter } = item;
  registry.activeMangaDownloads += 1;
  try {
    if (job.cancelRequested) {
      job.cancelled += 1;
      return;
    }
    if (job.status === 'queued') {
      job.status = 'running';
      job.startedAt = new Date().toISOString();
    }
    let result = readManifest(job.mangaId, 'sub', chapter);
    if (!result) result = await getChapterPages(job.mangaId, chapter);
    await downloadChapter(job.mangaId, 'sub', chapter, result);
    job.completed += 1;
  } catch (err) {
    job.failed += 1;
    job.errors.push({ chapter, message: err.message });
  } finally {
    updateJobOutput(job);
    finalizeJob(job);
    registry.activeMangaDownloads -= 1;
    processMangaDownloadQueue();
  }
}

function processMangaDownloadQueue() {
  while (registry.activeMangaDownloads < MANGA_DOWNLOAD_CONCURRENCY && registry.mangaDownloadQueue.length) {
    const item = registry.mangaDownloadQueue.shift();
    runMangaDownloadTask(item);
  }
}

function startMangaDownloadBatch({ mangaId, mangaName, chapters }) {
  const requested = Array.from(new Set((chapters || []).map(String).filter(Boolean)));
  if (!mangaId || !requested.length) throw new Error('Missing manga id or chapters');
  if (requested.length > MAX_BATCH_CHAPTERS) throw new Error(`A batch can contain at most ${MAX_BATCH_CHAPTERS} chapters`);
  const pending = requested.filter((chapter) => !readManifest(mangaId, 'sub', chapter)?.downloaded);
  const now = new Date().toISOString();
  const job = {
    id: crypto.randomUUID(),
    type: 'manga-download-batch',
    mangaId,
    label: `Download ${requested.length} chapters · ${mangaName || 'Manga'}`,
    status: pending.length ? 'queued' : 'done',
    chapters: requested,
    total: pending.length,
    completed: 0,
    failed: 0,
    cancelled: 0,
    skipped: requested.length - pending.length,
    errors: [],
    output: pending.length ? 'Queued for download' : `${requested.length} chapters already downloaded`,
    queuedAt: now,
    finishedAt: pending.length ? null : now,
    cancelRequested: false,
  };
  registry.jobs.set(job.id, job);
  pending.forEach((chapter) => registry.mangaDownloadQueue.push({ job, chapter }));
  setImmediate(processMangaDownloadQueue);
  return presentMangaDownloadJob(job);
}

function listMangaDownloadJobs(mangaId) {
  return Array.from(registry.jobs.values())
    .filter((job) => job.type === 'manga-download-batch' && job.mangaId === mangaId)
    .sort((a, b) => String(b.queuedAt).localeCompare(String(a.queuedAt)))
    .map(presentMangaDownloadJob);
}

function cancelMangaDownloadJob(mangaId, jobId) {
  const job = registry.jobs.get(jobId);
  if (!job || job.type !== 'manga-download-batch' || job.mangaId !== mangaId) return null;
  if (['done', 'failed', 'partial', 'cancelled'].includes(job.status)) return presentMangaDownloadJob(job);
  job.cancelRequested = true;
  job.status = 'cancelling';
  job.output = `${job.completed + job.failed}/${job.total} chapters processed · cancelling`;
  return presentMangaDownloadJob(job);
}

module.exports = {
  MAX_BATCH_CHAPTERS,
  startMangaDownloadBatch,
  listMangaDownloadJobs,
  cancelMangaDownloadJob,
};
