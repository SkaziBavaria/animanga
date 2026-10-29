'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.ANIMANGA_DATA_DIR = path.join(os.tmpdir(), `animanga-download-unit-${process.pid}`);

const { ffmpegDownloadArgs, createEpisodeDownloadTask } = require('../../lib/anime-download');

test('ffmpeg arguments preserve the provider headers and remux into mp4', () => {
  const args = ffmpegDownloadArgs({
    url: 'https://cdn.example/video/master.m3u8',
    referrer: 'https://provider.example/',
  }, '/tmp/episode.part.mp4');

  assert.equal(args[args.indexOf('-i') + 1], 'https://cdn.example/video/master.m3u8');
  assert.match(args[args.indexOf('-headers') + 1], /Referer: https:\/\/provider\.example\//);
  assert.deepEqual(args.slice(args.indexOf('-extension_picky'), args.indexOf('-extension_picky') + 2), [
    '-extension_picky', '0',
  ]);
  assert.ok(args.indexOf('-extension_picky') < args.indexOf('-i'));
  assert.deepEqual(args.slice(args.indexOf('-rw_timeout'), args.indexOf('-rw_timeout') + 2), ['-rw_timeout', '20000000']);
  assert.ok(args.includes('-reconnect_on_network_error'));
  assert.ok(args.includes('408,429,5xx'));
  assert.ok(args.includes('copy'));
  assert.equal(args.at(-1), '/tmp/episode.part.mp4');
});

test('ffmpeg downloads separate HLS audio with the matching referrer and maps it with video', () => {
  const args = ffmpegDownloadArgs({
    url: 'https://cdn.example/video/720/index.m3u8',
    audioUrl: 'https://cdn.example/audio/ja/index.m3u8',
    referrer: 'https://player.example/',
  }, '/tmp/episode.part.mp4');
  const inputs = args.reduce((items, value, index) => value === '-i' ? [...items, args[index + 1]] : items, []);

  assert.deepEqual(inputs, [
    'https://cdn.example/video/720/index.m3u8',
    'https://cdn.example/audio/ja/index.m3u8',
  ]);
  assert.equal(args.filter((value) => value === '-headers').length, 2);
  assert.ok(args.includes('1:a:0?'));
  assert.ok(!args.includes('0:a:0?'));
});

test('episode task resolves, downloads, and atomically publishes the final file', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'animanga-episode-'));
  const outputPath = path.join(dir, 'Show Episode 1.mp4');
  const logFile = path.join(dir, 'job.log');
  fs.writeFileSync(logFile, '');
  let resolvedWith;
  let processCall;
  const task = createEpisodeDownloadTask({
    showId: 'show-id',
    episode: '1',
    mode: 'sub',
    quality: '720',
    outputPath,
  }, {
    resolvePlayback: async (options) => {
      resolvedWith = options;
      return { url: 'https://cdn.example/video.mp4', referrer: '', provider: 'test', quality: 720 };
    },
    runProcess: async (job, command, args) => {
      processCall = { job, command, args };
      fs.writeFileSync(args.at(-1), 'video bytes');
    },
  });

  const job = { status: 'running', logFile, output: '' };
  await task(job);

  assert.deepEqual(resolvedWith, { showId: 'show-id', episode: '1', mode: 'sub', quality: '720' });
  assert.equal(processCall.command, 'ffmpeg');
  assert.equal(fs.readFileSync(outputPath, 'utf8'), 'video bytes');
  assert.equal(fs.existsSync(`${outputPath}.part.mp4`), false);
  assert.match(fs.readFileSync(logFile, 'utf8'), /Download complete:/);
});

test('episode task removes partial files after a failed ffmpeg run', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'animanga-episode-fail-'));
  const outputPath = path.join(dir, 'Show Episode 2.mp4');
  const logFile = path.join(dir, 'job.log');
  fs.writeFileSync(logFile, '');
  const task = createEpisodeDownloadTask({
    showId: 'show-id', episode: '2', mode: 'sub', quality: 'best', outputPath,
  }, {
    resolvePlayback: async () => ({ url: 'https://cdn.example/video.mp4', referrer: '' }),
    runProcess: async (job, command, args) => {
      fs.writeFileSync(args.at(-1), 'partial');
      throw new Error('network failed');
    },
  });

  await assert.rejects(() => task({ status: 'running', logFile }), /network failed/);
  assert.equal(fs.existsSync(outputPath), false);
  assert.equal(fs.existsSync(`${outputPath}.part.mp4`), false);
});

test('episode task resolves a fresh source once after a failed ffmpeg attempt', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'animanga-episode-retry-'));
  const outputPath = path.join(dir, 'Show Episode 3.mp4');
  const logFile = path.join(dir, 'job.log');
  fs.writeFileSync(logFile, '');
  let resolves = 0;
  let attempts = 0;
  const task = createEpisodeDownloadTask({
    showId: 'show-id', episode: '3', mode: 'sub', quality: 'best', outputPath,
  }, {
    resolvePlayback: async () => ({ url: `https://cdn.example/video-${++resolves}.mp4`, referrer: '' }),
    runProcess: async (job, command, args) => {
      attempts += 1;
      if (attempts === 1) {
        fs.writeFileSync(args.at(-1), 'partial');
        throw new Error('network failed');
      }
      fs.writeFileSync(args.at(-1), 'complete video');
    },
  });

  const job = { status: 'running', logFile, output: '' };
  await task(job);

  assert.equal(resolves, 2);
  assert.equal(attempts, 2);
  assert.equal(fs.readFileSync(outputPath, 'utf8'), 'complete video');
  assert.match(fs.readFileSync(logFile, 'utf8'), /resolving a fresh source for one retry/);
});
