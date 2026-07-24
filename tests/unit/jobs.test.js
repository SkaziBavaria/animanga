'use strict';

const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.ANIMANGA_DATA_DIR = path.join(os.tmpdir(), `animanga-unit-${process.pid}`);

const { clientPlaybackEnabled } = require('../../lib/playback-mode');
const { startBackgroundTask } = require('../../lib/jobs');

test('clientPlaybackEnabled defaults to browser playback', () => {
  const prev = process.env.ANIMANGA_CLIENT_PLAYBACK;
  delete process.env.ANIMANGA_CLIENT_PLAYBACK;
  assert.equal(clientPlaybackEnabled(), true);
  process.env.ANIMANGA_CLIENT_PLAYBACK = '1';
  assert.equal(clientPlaybackEnabled(), true);
  process.env.ANIMANGA_CLIENT_PLAYBACK = '0';
  assert.equal(clientPlaybackEnabled(), false);
  if (prev === undefined) delete process.env.ANIMANGA_CLIENT_PLAYBACK;
  else process.env.ANIMANGA_CLIENT_PLAYBACK = prev;
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
