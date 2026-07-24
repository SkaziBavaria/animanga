'use strict';

const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.ANIMANGA_DATA_DIR = path.join(os.tmpdir(), `animanga-playback-unit-${process.pid}`);

const { clientPlaybackEnabled } = require('../../lib/playback-mode');
const { downloadConcurrencyLimit, startBackgroundTask } = require('../../lib/jobs');
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
