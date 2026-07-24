'use strict';

const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.ANIMANGA_DATA_DIR = path.join(os.tmpdir(), `animanga-manga-jobs-${process.pid}`);

const registry = require('../../lib/registry');
const {
  MAX_BATCH_CHAPTERS,
  startMangaDownloadBatch,
  listMangaDownloadJobs,
  cancelMangaDownloadJob,
} = require('../../lib/manga-download-jobs');

test.beforeEach(() => {
  registry.jobs.clear();
  registry.mangaDownloadQueue.length = 0;
  registry.activeMangaDownloads = 0;
});

test('rejects manga download batches larger than the safety limit', () => {
  const chapters = Array.from({ length: MAX_BATCH_CHAPTERS + 1 }, (_, index) => String(index + 1));
  assert.throws(
    () => startMangaDownloadBatch({ mangaId: 'm1', mangaName: 'Story', chapters }),
    /at most 50 chapters/
  );
});

test('queues and cancels a manga chapter batch without starting new downloads', async () => {
  const created = startMangaDownloadBatch({
    mangaId: 'm1',
    mangaName: 'Story',
    chapters: ['1', '1.5', '2'],
  });
  assert.equal(created.status, 'queued');
  assert.equal(created.total, 3);

  const cancelling = cancelMangaDownloadJob('m1', created.id);
  assert.equal(cancelling.status, 'cancelling');
  await new Promise((resolve) => setTimeout(resolve, 20));

  const [job] = listMangaDownloadJobs('m1');
  assert.equal(job.status, 'cancelled');
  assert.equal(job.cancelled, 3);
});
