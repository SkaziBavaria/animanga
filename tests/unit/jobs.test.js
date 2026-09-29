'use strict';

const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.ANIMANGA_DATA_DIR = path.join(os.tmpdir(), `animanga-playback-unit-${process.pid}`);

const { clientPlaybackEnabled } = require('../../lib/playback-mode');
const { downloadConcurrencyLimit, readFfmpegProgress, runLoggedProcess, startBackgroundTask } = require('../../lib/jobs');
const { readState, saveState } = require('../../lib/state');
const { settingsPatch } = require('../../lib/validation');

test('clientPlaybackEnabled follows live settings', () => {
  const state = readState();
  state.settings.clientPlayback = true;
  saveState(state);
  assert.equal(clientPlaybackEnabled(), true);

  state.settings.clientPlayback = false;
  saveState(state);
  assert.equal(clientPlaybackEnabled(), false);

  state.settings.clientPlayback = true;
  saveState(state);
});

test('downloadConcurrencyLimit follows live settings', () => {
  const state = readState();
  state.settings.downloadConcurrency = 4;
  saveState(state);
  assert.equal(downloadConcurrencyLimit(), 4);

  state.settings.downloadConcurrency = 1;
  saveState(state);
  assert.equal(downloadConcurrencyLimit(), 1);
});

test('settingsPatch accepts playback and concurrency fields', () => {
  assert.deepEqual(settingsPatch({ clientPlayback: false, downloadConcurrency: 3 }), {
    clientPlayback: false,
    downloadConcurrency: 3,
  });
  assert.throws(() => settingsPatch({ downloadConcurrency: 0 }), /1 to 8/);
  assert.throws(() => settingsPatch({ clientPlayback: 'yes' }), /boolean/);
});

test('background download tasks use the shared queue and report completion', async () => {
  let ran = false;
  const completed = new Promise((resolve) => {
    const job = startBackgroundTask('Node download', async (current) => {
      assert.equal(current.status, 'running');
      ran = true;
    }, (current) => {
      if (current.status === 'done') resolve(current);
    });
    assert.equal(job.status, 'queued');
  });

  const job = await completed;
  assert.equal(ran, true);
  assert.equal(job.status, 'done');
});

test('readFfmpegProgress reads the latest progress block without requiring percentage output', () => {
  const file = path.join(os.tmpdir(), `animanga-ffmpeg-progress-${process.pid}.log`);
  require('node:fs').writeFileSync(file, 'frame=1\nout_time_us=58000000\ntotal_size=7340032\nspeed=0.88x\nprogress=continue\n');
  assert.deepEqual(readFfmpegProgress(file), { outTimeUs: 58000000, totalBytes: 7340032, speed: 0.88 });
});

test('ffmpeg process watchdog stops a process when media progress stays idle', async () => {
  const file = path.join(os.tmpdir(), `animanga-ffmpeg-idle-${process.pid}.log`);
  require('node:fs').writeFileSync(file, '');
  const job = { logFile: file, status: 'running' };
  await assert.rejects(
    runLoggedProcess(job, process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {}, {
      idleTimeoutMs: 150,
      monitorProgress: true,
    }),
    (error) => error.code === 'DOWNLOAD_STALLED',
  );
  assert.equal(job.downloadProgress.phase, 'downloading');
});
