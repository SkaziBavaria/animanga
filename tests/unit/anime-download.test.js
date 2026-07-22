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
  assert.ok(args.includes('copy'));
  assert.equal(args.at(-1), '/tmp/episode.part.mp4');
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
