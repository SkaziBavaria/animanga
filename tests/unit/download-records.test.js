'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const source = fs.readFileSync(path.join(__dirname, '../../public/js/download-records.js'), 'utf8');
const helperModule = import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));

test('download list includes cancelled and failed jobs so bulk delete can remove them', async () => {
  const { isDownloadListed } = await helperModule;
  assert.equal(isDownloadListed({ status: 'cancelled' }), true);
  assert.equal(isDownloadListed({ status: 'failed' }), true);
});

test('download list and bulk delete include active jobs and completed files', async () => {
  const { isDownloadListed } = await helperModule;
  assert.equal(isDownloadListed({ status: 'queued' }), true);
  assert.equal(isDownloadListed({ status: 'running' }), true);
  assert.equal(isDownloadListed({ status: 'done', file: { path: '/episode.mp4' } }), true);
});

test('download list excludes deleted, unknown, and completed records without a file', async () => {
  const { isDownloadListed } = await helperModule;
  assert.equal(isDownloadListed({ status: 'deleted' }), false);
  assert.equal(isDownloadListed({ status: 'unknown' }), false);
  assert.equal(isDownloadListed({ status: 'done', file: null }), false);
  assert.equal(isDownloadListed(null), false);
});
