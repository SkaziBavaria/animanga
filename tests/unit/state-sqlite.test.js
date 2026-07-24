'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'animanga-sqlite-'));
const downloadDir = path.join(testDir, 'downloads');
fs.mkdirSync(downloadDir, { recursive: true });
process.env.ANIMANGA_DATA_DIR = testDir;
process.env.ANIMANGA_DOWNLOAD_DIR = downloadDir;

const {
  ensureDataDir,
  readState,
  saveState,
  deviceId,
  syncBundle,
  mergeSyncBundles,
  updateShowWatched,
  savePositionAtomic,
  saveMangaPositionAtomic,
  updateMangaRead,
  updateMangaReadBatch,
  createDatabaseBackup,
} = require('../../lib/state');
const { DATABASE_FILE, BACKUP_DIR } = require('../../lib/config');

test('starts with SQLite and can seed application state', () => {
  ensureDataDir();
  const state = readState();
  state.shows.legacy = { id: 'legacy', name: 'Imported show', watchedEpisodes: ['1'] };
  state.positions['legacy:2'] = { showId: 'legacy', episode: '2', position: 60, duration: 1200 };
  state.settings.mode = 'dub';
  state.cache.details.legacy = { value: { name: 'Cached' }, createdAt: '2026-01-01T00:00:00.000Z' };
  saveState(state);

  const stored = readState();
  assert.equal(stored.shows.legacy.name, 'Imported show');
  assert.equal(stored.positions['legacy:2'].position, 60);
  assert.equal(stored.settings.mode, 'dub');
  assert.equal(stored.cache.details.legacy.value.name, 'Cached');
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

test('archive preference survives newer show metadata sync', () => {
  mergeSyncBundles([{
    version: 1,
    deviceId: 'phone',
    records: [
      { kind: 'archive', key: 'shelf', value: { archived: true }, updatedAt: '2099-02-01T00:00:00.000Z', deviceId: 'phone' },
      { kind: 'show', key: 'shelf', value: { id: 'shelf', name: 'Shelf title', archived: false }, updatedAt: '2099-03-01T00:00:00.000Z', deviceId: 'phone' },
    ],
  }]);
  const show = readState().shows.shelf;
  assert.equal(show.name, 'Shelf title');
  assert.equal(show.archived, true);
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

test('manga tracking and per-chapter read state are syncable', () => {
  const state = readState();
  state.mangas.m1 = { id: 'm1', name: 'Story', tracked: true, chapters: ['1', '2'], readChapters: [] };
  saveState(state);
  updateMangaRead('m1', '1', true);
  assert.deepEqual(readState().mangas.m1.readChapters, ['1']);
  const records = syncBundle().records;
  assert.equal(records.some((record) => record.kind === 'manga' && record.key === 'm1'), true);
  assert.equal(records.some((record) => record.kind === 'manga_read' && record.key === 'm1:1'), true);
});

test('manga archive preference survives newer manga metadata sync', () => {
  mergeSyncBundles([{
    version: 1,
    deviceId: 'phone',
    records: [
      { kind: 'manga_archive', key: 'shelf-manga', value: { archived: true }, updatedAt: '2099-02-01T00:00:00.000Z', deviceId: 'phone' },
      { kind: 'manga', key: 'shelf-manga', value: { id: 'shelf-manga', name: 'Shelf manga', archived: false }, updatedAt: '2099-03-01T00:00:00.000Z', deviceId: 'phone' },
    ],
  }]);
  const manga = readState().mangas['shelf-manga'];
  assert.equal(manga.name, 'Shelf manga');
  assert.equal(manga.archived, true);
});

test('manga page progress persists, syncs, and clears when read', () => {
  const state = readState();
  state.mangas.m2 = { id: 'm2', name: 'Reader', language: 'sub', readChapters: [] };
  saveState(state);

  const saved = saveMangaPositionAtomic({ mangaId: 'm2', language: 'sub', chapter: '4', page: 7, pageCount: 12 });
  assert.equal(saved.position.page, 7);
  assert.equal(readState().mangaPositions['m2:sub:4'].pageCount, 12);
  assert.equal(syncBundle().records.some((record) => record.kind === 'manga_position' && record.key === 'm2:sub:4'), true);

  updateMangaRead('m2', '4', true);
  assert.equal(readState().mangaPositions['m2:sub:4'], undefined);
  assert.equal(saveMangaPositionAtomic({ mangaId: 'm2', language: 'sub', chapter: '4', page: 8 }).cleared, true);
});

test('merges manga page progress from another device', () => {
  mergeSyncBundles([{
    version: 1,
    deviceId: 'tablet',
    records: [
      { kind: 'manga', key: 'm3', value: { id: 'm3', name: 'Synced reader' }, updatedAt: '2099-04-01T00:00:00.000Z', deviceId: 'tablet' },
      { kind: 'manga_position', key: 'm3:raw:1.5', value: { mangaId: 'm3', language: 'raw', chapter: '1.5', page: 3, pageCount: 9 }, updatedAt: '2099-04-01T00:00:01.000Z', deviceId: 'tablet' },
    ],
  }]);
  assert.equal(readState().mangaPositions['m3:raw:1.5'].page, 3);
});

test('marks multiple manga chapters read in one atomic update', () => {
  const manga = updateMangaReadBatch('m1', ['1', '1.5', '2'], true);
  assert.deepEqual(manga.readChapters, ['1', '1.5', '2']);
  assert.deepEqual(readState().mangas.m1.readChapters, ['1', '1.5', '2']);
  const records = syncBundle().records;
  assert.equal(records.some((record) => record.kind === 'manga_read' && record.key === 'm1:1.5'), true);
  assert.equal(records.some((record) => record.kind === 'manga_read' && record.key === 'm1:2'), true);
});

test('persists manga release watches separately from anime watches', () => {
  const state = readState();
  state.mangaReleaseWatches.mw1 = { id: 'mw1', query: 'Future Story', language: 'sub', status: 'watching' };
  saveState(state);
  assert.equal(readState().mangaReleaseWatches.mw1.query, 'Future Story');
  assert.equal(readState().releaseWatches.mw1, undefined);
});

test('release watches sync across devices for anime and manga', () => {
  const state = readState();
  state.releaseWatches.aw1 = {
    id: 'aw1',
    query: 'Upcoming Anime',
    mode: 'sub',
    status: 'watching',
    updatedAt: '2099-05-01T00:00:00.000Z',
  };
  state.mangaReleaseWatches.mw2 = {
    id: 'mw2',
    query: 'Upcoming Manga',
    language: 'sub',
    status: 'watching',
    updatedAt: '2099-05-01T00:00:00.000Z',
  };
  saveState(state);

  const records = syncBundle().records;
  assert.equal(records.some((record) => record.kind === 'release_watch' && record.key === 'aw1'), true);
  assert.equal(records.some((record) => record.kind === 'manga_release_watch' && record.key === 'mw2'), true);

  mergeSyncBundles([{
    version: 1,
    deviceId: 'phone',
    records: [
      {
        kind: 'release_watch',
        key: 'aw-remote',
        value: { id: 'aw-remote', query: 'Remote Anime', mode: 'dub', status: 'found', matchedShow: { id: 's9', name: 'Remote Show' } },
        updatedAt: '2099-05-02T00:00:00.000Z',
        deviceId: 'phone',
      },
      {
        kind: 'manga_release_watch',
        key: 'mw-remote',
        value: { id: 'mw-remote', query: 'Remote Manga', language: 'raw', status: 'watching' },
        updatedAt: '2099-05-02T00:00:00.000Z',
        deviceId: 'phone',
      },
      {
        kind: 'release_watch',
        key: 'aw1',
        value: null,
        updatedAt: '2099-05-03T00:00:00.000Z',
        deviceId: 'phone',
      },
    ],
  }]);

  const next = readState();
  assert.equal(next.releaseWatches.aw1, undefined);
  assert.equal(next.releaseWatches['aw-remote'].query, 'Remote Anime');
  assert.equal(next.releaseWatches['aw-remote'].matchedShow.name, 'Remote Show');
  assert.equal(next.mangaReleaseWatches['mw-remote'].language, 'raw');
  assert.equal(next.mangaReleaseWatches.mw2.query, 'Upcoming Manga');
});

test('creates a consistent SQLite backup', async () => {
  const result = await createDatabaseBackup({ force: true });
  const backupFile = path.join(BACKUP_DIR, result.file);
  assert.equal(fs.existsSync(backupFile), true);
  const backupDb = new (require('node:sqlite').DatabaseSync)(backupFile, { readOnly: true });
  assert.equal(backupDb.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  backupDb.close();
});
