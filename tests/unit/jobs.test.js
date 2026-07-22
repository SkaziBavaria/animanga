'use strict';

const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

// Isolate state to a throwaway dir before the app modules read config.
process.env.ANI_WEB_DATA_DIR = path.join(os.tmpdir(), `ani-web-unit-${process.pid}`);

const {
  parseDebugPlayback,
  parseArgsLine,
  buildAniCliArgs,
  clientPlaybackEnabled,
  startBackgroundTask,
} = require('../../lib/jobs');

test('parseDebugPlayback extracts the selected link and default referrer', () => {
  const output = [
    'Searching...',
    'Selected link:',
    'https://cdn.example.com/video.m3u8',
    'Playing episode',
  ].join('\n');
  const result = parseDebugPlayback(output);
  assert.equal(result.url, 'https://cdn.example.com/video.m3u8');
  assert.ok(result.referrer);
});

test('parseDebugPlayback picks mp4upload referrer', () => {
  const output = [
    'line >https://www.mp4upload.com/embed/file mp4upload',
    'Selected link:',
    'https://www.mp4upload.com/embed/file',
  ].join('\n');
  const result = parseDebugPlayback(output);
  assert.equal(result.referrer, 'https://www.mp4upload.com');
});

test('parseDebugPlayback throws when no link found', () => {
  assert.throws(() => parseDebugPlayback('nothing to see here'));
});

test('parseArgsLine handles quotes and escapes', () => {
  assert.deepEqual(parseArgsLine('-q 720 -e 1 "one piece"'), ['-q', '720', '-e', '1', 'one piece']);
  assert.deepEqual(parseArgsLine("--dub 'attack on titan'"), ['--dub', 'attack on titan']);
  assert.throws(() => parseArgsLine('"unterminated'));
});

test('buildAniCliArgs builds args from a payload without id', async () => {
  const args = await buildAniCliArgs({
    name: 'One Piece',
    episode: '5',
    mode: 'sub',
    quality: '720',
    index: 3,
  });
  assert.deepEqual(args, ['-q', '720', '-S', '3', '-e', '5', 'One Piece']);
});

test('buildAniCliArgs adds dub and download flags', async () => {
  const args = await buildAniCliArgs({
    name: 'Bleach',
    episode: '1',
    mode: 'dub',
    download: true,
    index: 1,
  });
  assert.ok(args.includes('--dub'));
  assert.ok(args.includes('--download'));
  assert.deepEqual(args.slice(-3), ['-e', '1', 'Bleach']);
});

test('buildAniCliArgs rejects payloads without a title', async () => {
  await assert.rejects(() => buildAniCliArgs({ episode: '1' }));
});

test('clientPlaybackEnabled respects the explicit env flag', () => {
  const prev = process.env.ANI_WEB_CLIENT_PLAYBACK;
  process.env.ANI_WEB_CLIENT_PLAYBACK = '1';
  assert.equal(clientPlaybackEnabled(), true);
  process.env.ANI_WEB_CLIENT_PLAYBACK = '0';
  assert.equal(clientPlaybackEnabled(), false);
  if (prev === undefined) delete process.env.ANI_WEB_CLIENT_PLAYBACK;
  else process.env.ANI_WEB_CLIENT_PLAYBACK = prev;
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
  assert.ok(job.finishedAt);
});
