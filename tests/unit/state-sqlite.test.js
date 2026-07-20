'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ani-web-sqlite-'));
const historyDir = path.join(testDir, 'history');
const downloadDir = path.join(testDir, 'downloads');
fs.mkdirSync(historyDir, { recursive: true });
fs.mkdirSync(downloadDir, { recursive: true });
process.env.ANI_WEB_DATA_DIR = testDir;
process.env.ANI_CLI_HIST_DIR = historyDir;
process.env.ANI_CLI_DOWNLOAD_DIR = downloadDir;

fs.writeFileSync(path.join(testDir, 'state.json'), JSON.stringify({
  shows: { legacy: { id: 'legacy', name: 'Imported show', watchedEpisodes: ['1'] } },
  positions: { 'legacy:2': { showId: 'legacy', episode: '2', position: 60, duration: 1200 } },
  settings: { mode: 'dub' },
  cache: { details: { legacy: { value: { name: 'Cached' }, createdAt: '2026-01-01T00:00:00.000Z' } } },
}));

const {
  ensureDataDir,
  readState,
  saveState,
  deviceId,
  syncBundle,
  mergeSyncBundles,
  updateShowWatched,
  savePositionAtomic,
  createDatabaseBackup,
} = require('../../lib/state');
const { DATABASE_FILE, BACKUP_DIR } = require('../../lib/config');

test('imports legacy JSON into SQLite on first startup', () => {
  ensureDataDir();
  const state = readState();
  assert.equal(state.shows.legacy.name, 'Imported show');
  assert.equal(state.positions['legacy:2'].position, 60);
  assert.equal(state.settings.mode, 'dub');
  assert.equal(state.cache.details.legacy.value.name, 'Cached');
  assert.equal(fs.existsSync(DATABASE_FILE), true);
});

test('concurrent state snapshots preserve unrelated row updates', () => {
  const first = readState();
  const second = readState();
  first.positions['legacy:2'].position = 90;
  second.shows.new = { id: 'new', name: 'Another show', watchedEpisodes: [] };

  saveState(first);
  saveState(second);

  const stored = readState();
  assert.equal(stored.positions['legacy:2'].position, 90);
  assert.equal(stored.shows.new.name, 'Another show');
});

test('deletes only rows removed by the current snapshot', () => {
  const state = readState();
  delete state.positions['legacy:2'];
  saveState(state);
  assert.equal(readState().positions['legacy:2'], undefined);
});

test('merges newer per-episode and progress records from another device', () => {
  const future = '2099-01-01T00:00:00.000Z';
  const result = mergeSyncBundles([{
    version: 1,
    deviceId: 'phone',
    records: [
      { kind: 'watch', key: 'legacy:3', value: { showId: 'legacy', episode: '3', watched: true }, updatedAt: future, deviceId: 'phone' },
      { kind: 'position', key: 'legacy:3', value: { showId: 'legacy', episode: '3', position: 240, duration: 1200, updatedAt: future }, updatedAt: future, deviceId: 'phone' },
    ],
  }]);
  const state = readState();
  assert.equal(result.applied, 2);
  assert.equal(state.shows.legacy.watchedEpisodes.includes('3'), true);
  assert.equal(state.positions['legacy:3'].position, 240);
});

test('exports a versioned bundle with a stable device id', () => {
  const bundle = syncBundle();
  assert.equal(bundle.version, 1);
  assert.equal(bundle.deviceId, deviceId());
  assert.equal(bundle.records.some((record) => record.kind === 'watch'), true);
});

test('metadata records cannot overwrite a separate tracking decision', () => {
  mergeSyncBundles([{
    version: 1,
    deviceId: 'phone',
    records: [
      { kind: 'tracking', key: 'legacy', value: { tracked: false }, updatedAt: '2099-02-01T00:00:00.000Z', deviceId: 'phone' },
      { kind: 'show', key: 'legacy', value: { id: 'legacy', name: 'New metadata', tracked: true }, updatedAt: '2099-03-01T00:00:00.000Z', deviceId: 'phone' },
    ],
  }]);
  const show = readState().shows.legacy;
  assert.equal(show.name, 'New metadata');
  assert.equal(show.tracked, false);
});

test('a stale metadata save cannot overwrite an atomic watched update', () => {
  const staleRefresh = readState();
  updateShowWatched('legacy', (watched) => watched.add('9'));

  staleRefresh.shows.legacy.thumbnail = 'fresh-cover.jpg';
  saveState(staleRefresh);

  const show = readState().shows.legacy;
  assert.equal(show.thumbnail, 'fresh-cover.jpg');
  assert.equal(show.watchedEpisodes.includes('9'), true);
});

test('progress cannot be recreated for an episode already marked watched', () => {
  updateShowWatched('legacy', (watched) => watched.add('10'));
  const result = savePositionAtomic({ id: 'legacy', episode: '10', position: 300, duration: 1200 });
  assert.equal(result.cleared, true);
  assert.equal(readState().positions['legacy:10'], undefined);
});

test('creates a consistent SQLite backup', async () => {
  const result = await createDatabaseBackup({ force: true });
  const backupFile = path.join(BACKUP_DIR, result.file);
  assert.equal(fs.existsSync(backupFile), true);
  const backupDb = new (require('node:sqlite').DatabaseSync)(backupFile, { readOnly: true });
  assert.equal(backupDb.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  backupDb.close();
});
