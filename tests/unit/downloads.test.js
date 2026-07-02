'use strict';

const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.ANI_WEB_DATA_DIR = path.join(os.tmpdir(), `ani-web-dl-unit-${process.pid}`);

const { downloadKey, downloadStatus, isDownloadBusy } = require('../../lib/downloads');

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
