'use strict';

const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const DATA_DIR = path.join(os.tmpdir(), `ani-web-dl-unit-${process.pid}`);
const DOWNLOAD_DIR = path.join(DATA_DIR, 'downloads');
process.env.ANI_WEB_DATA_DIR = DATA_DIR;
process.env.ANI_CLI_DOWNLOAD_DIR = DOWNLOAD_DIR;

const fs = require('node:fs');
const { downloadKey, downloadStatus, isDownloadBusy, resolveDownloadPath } = require('../../lib/downloads');

test('downloadKey combines show id and episode', () => {
  assert.equal(downloadKey('abc', '1'), 'abc:1');
  assert.equal(downloadKey('abc', ' 2 '), 'abc:2');
});

test('downloadStatus returns null for missing records', () => {
  assert.equal(downloadStatus(null), null);
  assert.equal(downloadStatus(undefined), null);
});

test('downloadStatus short-circuits deleted records', () => {
  const result = downloadStatus({ key: 'a:1', status: 'deleted', filePath: '/x/a.mp4' });
  assert.equal(result.status, 'deleted');
  assert.equal(result.file, null);
  assert.equal(result.job, null);
});

test('downloadStatus marks a queued record without a file as unknown', () => {
  const result = downloadStatus({ key: 'a:2', status: 'queued', filePath: '/does/not/exist.mp4' });
  assert.equal(result.status, 'unknown');
  assert.equal(result.file, null);
});

test('isDownloadBusy reflects active states', () => {
  assert.equal(isDownloadBusy('queued'), true);
  assert.equal(isDownloadBusy('running'), true);
  assert.equal(isDownloadBusy('done'), false);
  assert.equal(isDownloadBusy('deleted'), false);
});

test('resolveDownloadPath reads completed paths with spaces from logs', () => {
  const showDir = path.join(DOWNLOAD_DIR, 'A Show With Spaces');
  const filePath = path.join(showDir, 'A Show With Spaces Episode 1.mp4');
  const logFile = path.join(DATA_DIR, 'job.log');
  fs.mkdirSync(showDir, { recursive: true });
  fs.writeFileSync(filePath, '');
  fs.writeFileSync(logFile, `Download complete: ${filePath}\n`);

  assert.equal(resolveDownloadPath({ episode: '1', logFile }), filePath);
});
