'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync, backup } = require('node:sqlite');
const {
  DATA_DIR,
  JOB_LOG_DIR,
  STATE_FILE,
  DATABASE_FILE,
  BACKUP_DIR,
  BACKUP_INTERVAL_MS,
  BACKUP_RETENTION,
  HISTORY_DIR,
  HISTORY_FILE,
  DOWNLOAD_DIR,
} = require('./config');
const { mangaPositionKey, setMangaPosition } = require('./progress');
const registry = require('./registry');

const SNAPSHOT = Symbol('sqliteSnapshot');
const ENTITY_GROUPS = ['shows', 'mangas', 'downloads', 'positions', 'mangaPositions', 'releaseWatches', 'mangaReleaseWatches'];
let database = null;
let backupTimer = null;
let backupRunning = null;

function defaultSettings() {
  return {
    mode: 'sub',
    quality: 'best',
    player: 'android_mpv',
    skipIntro: false,
    autoTrackPlayed: true,
  };
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.writeFileSync(`${file}.tmp`, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(`${file}.tmp`, file);
}

function json(value) {
  return JSON.stringify(value ?? null);
}

function clone(value) {
  return JSON.parse(json(value));
}

function recentJobs(...groups) {
  const byId = new Map();
  for (const job of groups.flat()) {
    if (!job?.id || byId.has(job.id)) continue;
    byId.set(job.id, job);
  }
  return Array.from(byId.values())
    .sort((a, b) => Date.parse(b.startedAt || b.finishedAt || 0) - Date.parse(a.startedAt || a.finishedAt || 0))
    .slice(0, 30);
}

function openDatabase() {
  if (database) return database;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  database = new DatabaseSync(DATABASE_FILE, { timeout: 5000 });
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS app_state (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS entities (
      kind TEXT NOT NULL,
      key TEXT NOT NULL,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (kind, key)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS entities_kind_idx ON entities(kind);
    CREATE TABLE IF NOT EXISTS api_cache (
      namespace TEXT NOT NULL,
      key TEXT NOT NULL,
      value_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (namespace, key)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS api_cache_expiry_idx ON api_cache(namespace, created_at);
    CREATE TABLE IF NOT EXISTS sync_records (
      kind TEXT NOT NULL,
      key TEXT NOT NULL,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      device_id TEXT NOT NULL,
      PRIMARY KEY (kind, key)
    ) STRICT;
  `);
  migrateLegacyState(database);
  ensureSyncIdentity(database);
  seedSyncRecords(database);
  upgradeSyncRecordsV2(database);
  cleanupLegacySyncRecords(database);
  return database;
}

function metadataGet(db, key) {
  return db.prepare('SELECT value FROM metadata WHERE key = ?').get(key)?.value || null;
}

function metadataSet(db, key, value) {
  db.prepare('INSERT OR REPLACE INTO metadata(key, value) VALUES (?, ?)').run(key, String(value));
}

function ensureSyncIdentity(db) {
  if (!metadataGet(db, 'device_id')) metadataSet(db, 'device_id', crypto.randomUUID());
}

function syncShowValue(show) {
  const fields = [
    'id', 'name', 'sourceName', 'englishName', 'nativeName', 'title',
    'thumbnail', 'mode', 'episodeCount', 'episodeCounts', 'latestEpisode',
  ];
  return Object.fromEntries(fields.filter((key) => show[key] !== undefined).map((key) => [key, show[key]]));
}

function syncMangaValue(manga) {
  const fields = [
    'id', 'name', 'sourceName', 'englishName', 'nativeName', 'title', 'thumbnail',
    'language', 'chapterCount', 'chapterCounts', 'latestChapter', 'latestChapters', 'lastChapterDates',
    'status', 'airedStart', 'countryOfOrigin',
  ];
  return Object.fromEntries(fields.filter((key) => manga[key] !== undefined).map((key) => [key, manga[key]]));
}

function syncRecordPut(db, kind, key, value, updatedAt, deviceId) {
  db.prepare(`
    INSERT INTO sync_records(kind, key, value_json, updated_at, device_id) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(kind, key) DO UPDATE SET
      value_json = excluded.value_json,
      updated_at = excluded.updated_at,
      device_id = excluded.device_id
  `).run(kind, key, json(value), updatedAt, deviceId);
}

function seedSyncRecords(db) {
  if (metadataGet(db, 'sync_seeded')) return;
  const deviceId = metadataGet(db, 'device_id');
  const now = new Date().toISOString();
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const row of db.prepare("SELECT key, value_json FROM entities WHERE kind = 'shows'").all()) {
      const show = JSON.parse(row.value_json);
      const updatedAt = show.updatedAt || now;
      syncRecordPut(db, 'show', row.key, syncShowValue(show), updatedAt, deviceId);
      syncRecordPut(db, 'tracking', row.key, { tracked: show.tracked !== false }, updatedAt, deviceId);
      if (show.customName !== undefined) syncRecordPut(db, 'custom_name', row.key, { customName: show.customName || '' }, updatedAt, deviceId);
      for (const episode of show.watchedEpisodes || []) {
        syncRecordPut(db, 'watch', `${row.key}:${episode}`, { showId: row.key, episode: String(episode), watched: true }, updatedAt, deviceId);
      }
    }
    for (const row of db.prepare("SELECT key, value_json FROM entities WHERE kind = 'positions'").all()) {
      const position = JSON.parse(row.value_json);
      syncRecordPut(db, 'position', row.key, position, position.updatedAt || now, deviceId);
    }
    for (const row of db.prepare("SELECT key, value_json FROM entities WHERE kind = 'mangaPositions'").all()) {
      const position = JSON.parse(row.value_json);
      syncRecordPut(db, 'manga_position', row.key, position, position.updatedAt || now, deviceId);
    }
    const settings = db.prepare("SELECT value_json FROM app_state WHERE key = 'settings'").get();
    if (settings) {
      for (const [key, value] of Object.entries(JSON.parse(settings.value_json))) {
        syncRecordPut(db, 'setting', key, value, now, deviceId);
      }
    }
    metadataSet(db, 'sync_seeded', now);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function upgradeSyncRecordsV2(db) {
  if (metadataGet(db, 'sync_records_v2')) return;
  const deviceId = metadataGet(db, 'device_id');
  const now = new Date().toISOString();
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const row of db.prepare("SELECT key, value_json, updated_at FROM sync_records WHERE kind = 'show'").all()) {
      const value = JSON.parse(row.value_json);
      const showRow = db.prepare("SELECT value_json FROM entities WHERE kind = 'shows' AND key = ?").get(row.key);
      const show = showRow ? JSON.parse(showRow.value_json) : value;
      syncRecordPut(db, 'show', row.key, syncShowValue(value), row.updated_at, deviceId);
      syncRecordPut(db, 'tracking', row.key, { tracked: show.tracked !== false }, show.updatedAt || row.updated_at || now, deviceId);
      if (show.customName !== undefined) syncRecordPut(db, 'custom_name', row.key, { customName: show.customName || '' }, show.updatedAt || row.updated_at || now, deviceId);
    }
    const settings = db.prepare("SELECT value_json, updated_at FROM app_state WHERE key = 'settings'").get();
    if (settings) {
      for (const [key, value] of Object.entries(JSON.parse(settings.value_json))) {
        syncRecordPut(db, 'setting', key, value, settings.updated_at || now, deviceId);
      }
    }
    metadataSet(db, 'sync_records_v2', now);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function cleanupLegacySyncRecords(db) {
  if (metadataGet(db, 'sync_records_v3')) return;
  db.prepare("DELETE FROM sync_records WHERE kind = 'settings'").run();
  metadataSet(db, 'sync_records_v3', new Date().toISOString());
}

function normalizeState(value = {}) {
  const state = {
    shows: value.shows || {},
    mangas: value.mangas || {},
    settings: { ...defaultSettings(), ...(value.settings || {}) },
    jobs: value.jobs || [],
    downloads: value.downloads || {},
    positions: value.positions || {},
    mangaPositions: value.mangaPositions || {},
    releaseWatches: value.releaseWatches || {},
    mangaReleaseWatches: value.mangaReleaseWatches || {},
    cache: value.cache || {},
  };
  state.cache.details ||= {};
  state.cache.recommendations ||= {};
  return state;
}

function importState(db, value) {
  const state = normalizeState(value);
  const now = new Date().toISOString();
  const putApp = db.prepare(`
    INSERT INTO app_state(key, value_json, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
  `);
  const putEntity = db.prepare(`
    INSERT INTO entities(kind, key, value_json, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(kind, key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
  `);
  const putCache = db.prepare(`
    INSERT INTO api_cache(namespace, key, value_json, created_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(namespace, key) DO UPDATE SET value_json = excluded.value_json, created_at = excluded.created_at
  `);
  db.exec('BEGIN IMMEDIATE');
  try {
    putApp.run('settings', json(state.settings), now);
    putApp.run('jobs', json(state.jobs), now);
    for (const kind of ENTITY_GROUPS) {
      for (const [key, entry] of Object.entries(state[kind])) putEntity.run(kind, key, json(entry), now);
    }
    for (const [namespace, entries] of Object.entries(state.cache)) {
      for (const [key, entry] of Object.entries(entries || {})) {
        putCache.run(namespace, key, json(entry.value), entry.createdAt || now);
      }
    }
    db.prepare('INSERT OR REPLACE INTO metadata(key, value) VALUES (?, ?)').run('legacy_imported', now);
    db.prepare('INSERT OR REPLACE INTO metadata(key, value) VALUES (?, ?)').run('schema_version', '1');
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function migrateLegacyState(db) {
  const imported = db.prepare('SELECT value FROM metadata WHERE key = ?').get('legacy_imported');
  if (imported) return;
  importState(db, readJson(STATE_FILE, {}));
}

function readState() {
  const db = openDatabase();
  const state = normalizeState();
  for (const row of db.prepare('SELECT key, value_json FROM app_state').all()) {
    if (row.key === 'settings' || row.key === 'jobs') state[row.key] = JSON.parse(row.value_json);
  }
  state.settings = { ...defaultSettings(), ...(state.settings || {}) };
  for (const row of db.prepare('SELECT kind, key, value_json FROM entities').all()) {
    if (state[row.kind]) state[row.kind][row.key] = JSON.parse(row.value_json);
  }
  for (const row of db.prepare('SELECT namespace, key, value_json, created_at FROM api_cache').all()) {
    state.cache[row.namespace] ||= {};
    state.cache[row.namespace][row.key] = { value: JSON.parse(row.value_json), createdAt: row.created_at };
  }
  Object.defineProperty(state, SNAPSHOT, { value: clone(state), writable: true, enumerable: false });
  return state;
}

function syncMap(db, state, before, kind, now) {
  const current = state[kind] || {};
  const previous = before[kind] || {};
  const put = db.prepare(`
    INSERT INTO entities(kind, key, value_json, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(kind, key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
  `);
  const remove = db.prepare('DELETE FROM entities WHERE kind = ? AND key = ?');
  for (const [key, value] of Object.entries(current)) {
    if (json(value) !== json(previous[key])) {
      let resolvedValue = value;
      if (kind === 'shows') {
        const watchedChanged = json(value.watchedEpisodes || []) !== json(previous[key]?.watchedEpisodes || []);
        if (!watchedChanged) {
          const stored = db.prepare("SELECT value_json FROM entities WHERE kind = 'shows' AND key = ?").get(key);
          if (stored) {
            const latest = JSON.parse(stored.value_json);
            resolvedValue = {
              ...value,
              watchedEpisodes: latest.watchedEpisodes || [],
              lastWatched: latest.lastWatched || '',
            };
            current[key] = resolvedValue;
          }
        }
      }
      if (kind === 'mangas') {
        const readChanged = json(value.readChapters || []) !== json(previous[key]?.readChapters || []);
        if (!readChanged) {
          const stored = db.prepare("SELECT value_json FROM entities WHERE kind = 'mangas' AND key = ?").get(key);
          if (stored) {
            const latest = JSON.parse(stored.value_json);
            resolvedValue = { ...value, readChapters: latest.readChapters || [] };
            current[key] = resolvedValue;
          }
        }
      }
      if (kind === 'mangas') {
        const deviceId = metadataGet(db, 'device_id');
        if (json(syncMangaValue(resolvedValue)) !== json(syncMangaValue(previous[key] || {}))) {
          syncRecordPut(db, 'manga', key, syncMangaValue(resolvedValue), now, deviceId);
        }
        if ((resolvedValue.tracked !== false) !== (previous[key]?.tracked !== false)) {
          syncRecordPut(db, 'manga_tracking', key, { tracked: resolvedValue.tracked !== false }, now, deviceId);
        }
      }
      put.run(kind, key, json(resolvedValue), now);
      if (kind === 'shows') {
        const deviceId = metadataGet(db, 'device_id');
        if (json(syncShowValue(resolvedValue)) !== json(syncShowValue(previous[key] || {}))) {
          syncRecordPut(db, 'show', key, syncShowValue(resolvedValue), now, deviceId);
        }
        if ((resolvedValue.tracked !== false) !== (previous[key]?.tracked !== false)) {
          syncRecordPut(db, 'tracking', key, { tracked: resolvedValue.tracked !== false }, now, deviceId);
        }
        if (String(resolvedValue.customName || '') !== String(previous[key]?.customName || '')) {
          syncRecordPut(db, 'custom_name', key, { customName: resolvedValue.customName || '' }, now, deviceId);
        }
      }
      if (kind === 'positions') syncRecordPut(db, 'position', key, resolvedValue, now, metadataGet(db, 'device_id'));
      if (kind === 'mangaPositions') syncRecordPut(db, 'manga_position', key, resolvedValue, now, metadataGet(db, 'device_id'));
    }
  }
  for (const key of Object.keys(previous)) {
    if (!(key in current)) {
      remove.run(kind, key);
      if (kind === 'positions') syncRecordPut(db, 'position', key, null, now, metadataGet(db, 'device_id'));
      if (kind === 'mangaPositions') syncRecordPut(db, 'manga_position', key, null, now, metadataGet(db, 'device_id'));
    }
  }
  if (kind === 'shows') {
    const deviceId = metadataGet(db, 'device_id');
    for (const key of new Set([...Object.keys(current), ...Object.keys(previous)])) {
      const currentWatched = new Set(current[key]?.watchedEpisodes || []);
      const previousWatched = new Set(previous[key]?.watchedEpisodes || []);
      for (const episode of new Set([...currentWatched, ...previousWatched])) {
        if (currentWatched.has(episode) === previousWatched.has(episode)) continue;
        syncRecordPut(db, 'watch', `${key}:${episode}`, {
          showId: key,
          episode: String(episode),
          watched: currentWatched.has(episode),
        }, now, deviceId);
      }
    }
  }
  if (kind === 'mangas') {
    const deviceId = metadataGet(db, 'device_id');
    for (const key of new Set([...Object.keys(current), ...Object.keys(previous)])) {
      const currentRead = new Set((current[key]?.readChapters || []).map(String));
      const previousRead = new Set((previous[key]?.readChapters || []).map(String));
      for (const chapter of new Set([...currentRead, ...previousRead])) {
        if (currentRead.has(chapter) === previousRead.has(chapter)) continue;
        syncRecordPut(db, 'manga_read', `${key}:${chapter}`, {
          mangaId: key,
          chapter,
          read: currentRead.has(chapter),
        }, now, deviceId);
      }
    }
  }
}

function syncCache(db, state, before) {
  const current = state.cache || {};
  const previous = before.cache || {};
  const put = db.prepare(`
    INSERT INTO api_cache(namespace, key, value_json, created_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(namespace, key) DO UPDATE SET value_json = excluded.value_json, created_at = excluded.created_at
  `);
  const remove = db.prepare('DELETE FROM api_cache WHERE namespace = ? AND key = ?');
  const namespaces = new Set([...Object.keys(current), ...Object.keys(previous)]);
  for (const namespace of namespaces) {
    for (const [key, entry] of Object.entries(current[namespace] || {})) {
      if (json(entry) !== json(previous[namespace]?.[key])) {
        put.run(namespace, key, json(entry.value), entry.createdAt || new Date().toISOString());
      }
    }
    for (const key of Object.keys(previous[namespace] || {})) {
      if (!(key in (current[namespace] || {}))) remove.run(namespace, key);
    }
  }
}

function saveState(state) {
  const db = openDatabase();
  state.jobs = recentJobs(Array.from(registry.jobs.values()), state.jobs || []);
  const before = state[SNAPSHOT] || normalizeState();
  const now = new Date().toISOString();
  const putApp = db.prepare(`
    INSERT INTO app_state(key, value_json, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
  `);
  db.exec('BEGIN IMMEDIATE');
  try {
    if (json(state.settings) !== json(before.settings)) {
      putApp.run('settings', json(state.settings), now);
      const deviceId = metadataGet(db, 'device_id');
      for (const key of new Set([...Object.keys(state.settings || {}), ...Object.keys(before.settings || {})])) {
        if (json(state.settings?.[key]) !== json(before.settings?.[key])) {
          syncRecordPut(db, 'setting', key, state.settings?.[key] ?? null, now, deviceId);
        }
      }
    }
    if (json(state.jobs) !== json(before.jobs)) putApp.run('jobs', json(state.jobs), now);
    for (const kind of ENTITY_GROUPS) syncMap(db, state, before, kind, now);
    syncCache(db, state, before);
    db.exec('COMMIT');
    state[SNAPSHOT] = clone(state);
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function sortedEpisodes(episodes) {
  return Array.from(new Set(episodes.map(String)))
    .sort((a, b) => Number(a) - Number(b) || a.localeCompare(b));
}

function updateShowWatched(showId, updateWatched, patch = {}) {
  const db = openDatabase();
  const now = new Date().toISOString();
  const device = metadataGet(db, 'device_id');
  const getShow = db.prepare("SELECT value_json FROM entities WHERE kind = 'shows' AND key = ?");
  const putShow = db.prepare(`
    INSERT INTO entities(kind, key, value_json, updated_at) VALUES ('shows', ?, ?, ?)
    ON CONFLICT(kind, key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
  `);
  let result;
  db.exec('BEGIN IMMEDIATE');
  try {
    const row = getShow.get(showId);
    const existing = row ? JSON.parse(row.value_json) : { id: showId, watchedEpisodes: [] };
    const previousWatched = new Set((existing.watchedEpisodes || []).map(String));
    const nextWatched = new Set(previousWatched);
    updateWatched(nextWatched, existing);
    const watchedEpisodes = sortedEpisodes(Array.from(nextWatched));
    const { watchedEpisodes: _ignoredWatched, lastWatched: _ignoredLast, episode: _ignoredEpisode, watched: _ignoredFlag, updatedAt: _ignoredUpdated, ...safePatch } = patch || {};
    result = {
      ...existing,
      ...safePatch,
      id: showId,
      watchedEpisodes,
      lastWatched: watchedEpisodes.at(-1) || '',
      tracked: safePatch.tracked ?? existing.tracked ?? true,
      updatedAt: now,
    };
    putShow.run(showId, json(result), now);
    if (json(syncShowValue(result)) !== json(syncShowValue(existing))) {
      syncRecordPut(db, 'show', showId, syncShowValue(result), now, device);
    }
    if ((result.tracked !== false) !== (existing.tracked !== false)) {
      syncRecordPut(db, 'tracking', showId, { tracked: result.tracked !== false }, now, device);
    }
    for (const episode of new Set([...previousWatched, ...nextWatched])) {
      if (previousWatched.has(episode) === nextWatched.has(episode)) continue;
      syncRecordPut(db, 'watch', `${showId}:${episode}`, {
        showId,
        episode,
        watched: nextWatched.has(episode),
      }, now, device);
      if (nextWatched.has(episode)) {
        db.prepare("DELETE FROM entities WHERE kind = 'positions' AND key = ?").run(`${showId}:${episode}`);
        syncRecordPut(db, 'position', `${showId}:${episode}`, null, now, device);
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return result;
}

function clearMangaPositions(db, mangaId, chapterList, now, device) {
  const chapters = new Set((chapterList || []).map(String));
  for (const row of db.prepare("SELECT key, value_json FROM entities WHERE kind = 'mangaPositions'").all()) {
    const position = JSON.parse(row.value_json);
    if (position.mangaId !== mangaId || !chapters.has(String(position.chapter))) continue;
    db.prepare("DELETE FROM entities WHERE kind = 'mangaPositions' AND key = ?").run(row.key);
    syncRecordPut(db, 'manga_position', row.key, null, now, device);
  }
}

function updateMangaReadBatch(mangaId, chapterList, read, patch = {}) {
  const db = openDatabase();
  const normalizedChapters = Array.from(new Set((chapterList || [])
    .map((chapter) => String(chapter ?? '').trim())
    .filter(Boolean)));
  if (!mangaId || !normalizedChapters.length) throw new Error('Missing manga id or chapters');
  const now = new Date().toISOString();
  const device = metadataGet(db, 'device_id');
  let result;
  db.exec('BEGIN IMMEDIATE');
  try {
    const row = db.prepare("SELECT value_json FROM entities WHERE kind = 'mangas' AND key = ?").get(mangaId);
    const existing = row ? JSON.parse(row.value_json) : { id: mangaId, readChapters: [] };
    const previousChapters = new Set((existing.readChapters || []).map(String));
    const chapters = new Set((existing.readChapters || []).map(String));
    for (const chapter of normalizedChapters) {
      if (read) chapters.add(chapter); else chapters.delete(chapter);
    }
    const readChapters = Array.from(chapters).sort((a, b) => Number(a) - Number(b) || a.localeCompare(b));
    result = { ...existing, ...patch, id: mangaId, tracked: patch.tracked ?? existing.tracked ?? true, readChapters, updatedAt: now };
    db.prepare(`
      INSERT INTO entities(kind, key, value_json, updated_at) VALUES ('mangas', ?, ?, ?)
      ON CONFLICT(kind, key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
    `).run(mangaId, json(result), now);
    if (json(syncMangaValue(result)) !== json(syncMangaValue(existing))) {
      syncRecordPut(db, 'manga', mangaId, syncMangaValue(result), now, device);
    }
    for (const chapter of normalizedChapters) {
      if (previousChapters.has(chapter) === chapters.has(chapter)) continue;
      syncRecordPut(db, 'manga_read', `${mangaId}:${chapter}`, {
        mangaId,
        chapter,
        read: Boolean(read),
      }, now, device);
    }
    if (read) clearMangaPositions(db, mangaId, normalizedChapters, now, device);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return result;
}

function updateMangaRead(mangaId, chapter, read, patch = {}) {
  return updateMangaReadBatch(mangaId, [chapter], read, patch);
}

function savePositionAtomic({ id, episode, position, duration }) {
  const db = openDatabase();
  const normalizedEpisode = String(episode || '').trim();
  if (!id || !normalizedEpisode) return { cleared: true };
  const key = `${id}:${normalizedEpisode}`;
  const now = new Date().toISOString();
  const device = metadataGet(db, 'device_id');
  let result = { cleared: true };
  db.exec('BEGIN IMMEDIATE');
  try {
    const showRow = db.prepare("SELECT value_json FROM entities WHERE kind = 'shows' AND key = ?").get(id);
    const show = showRow ? JSON.parse(showRow.value_json) : null;
    const watched = new Set((show?.watchedEpisodes || []).map(String));
    const pos = Number(position);
    const dur = Number(duration);
    const nearEnd = Number.isFinite(dur) && dur > 0 && (pos >= dur - 15 || pos / dur >= 0.95);
    if (!watched.has(normalizedEpisode) && Number.isFinite(pos) && pos >= 5 && !nearEnd) {
      const value = {
        showId: id,
        episode: normalizedEpisode,
        position: pos,
        duration: Number.isFinite(dur) && dur > 0 ? dur : null,
        updatedAt: now,
      };
      db.prepare(`
        INSERT INTO entities(kind, key, value_json, updated_at) VALUES ('positions', ?, ?, ?)
        ON CONFLICT(kind, key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
      `).run(key, json(value), now);
      syncRecordPut(db, 'position', key, value, now, device);
      result = { position: value };
    } else {
      db.prepare("DELETE FROM entities WHERE kind = 'positions' AND key = ?").run(key);
      syncRecordPut(db, 'position', key, null, now, device);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return result;
}

function saveMangaPositionAtomic(payload) {
  const db = openDatabase();
  const mangaId = payload.mangaId || payload.id;
  const language = payload.language === 'raw' ? 'raw' : 'sub';
  const chapter = String(payload.chapter || '').trim();
  if (!mangaId || !chapter) return { cleared: true };
  const key = mangaPositionKey(mangaId, language, chapter);
  const now = new Date().toISOString();
  const device = metadataGet(db, 'device_id');
  let result = { cleared: true };
  db.exec('BEGIN IMMEDIATE');
  try {
    const mangaRow = db.prepare("SELECT value_json FROM entities WHERE kind = 'mangas' AND key = ?").get(mangaId);
    const manga = mangaRow ? JSON.parse(mangaRow.value_json) : null;
    const read = new Set((manga?.readChapters || []).map(String));
    const state = { mangaPositions: {} };
    const candidate = setMangaPosition(state, { ...payload, mangaId, language, chapter });
    if (!read.has(chapter) && candidate.position) {
      const value = { ...candidate.position, updatedAt: now };
      db.prepare(`
        INSERT INTO entities(kind, key, value_json, updated_at) VALUES ('mangaPositions', ?, ?, ?)
        ON CONFLICT(kind, key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
      `).run(key, json(value), now);
      syncRecordPut(db, 'manga_position', key, value, now, device);
      result = { position: value };
    } else {
      db.prepare("DELETE FROM entities WHERE kind = 'mangaPositions' AND key = ?").run(key);
      syncRecordPut(db, 'manga_position', key, null, now, device);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return result;
}

function backupFiles() {
  try {
    return fs.readdirSync(BACKUP_DIR)
      .filter((name) => /^(?:animanga|ani-web)-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.sqlite$/.test(name))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

async function createDatabaseBackup({ force = false } = {}) {
  if (backupRunning) return backupRunning;
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const latest = backupFiles()[0];
  if (!force && latest) {
    const age = Date.now() - fs.statSync(path.join(BACKUP_DIR, latest)).mtimeMs;
    if (age < BACKUP_INTERVAL_MS) return { skipped: true, file: latest };
  }
  backupRunning = (async () => {
    const stamp = new Date().toISOString().replace(/:/g, '-').replace(/\.\d{3}Z$/, '');
    const name = `animanga-${stamp}.sqlite`;
    const target = path.join(BACKUP_DIR, name);
    await backup(openDatabase(), target);
    for (const old of backupFiles().slice(BACKUP_RETENTION)) fs.unlinkSync(path.join(BACKUP_DIR, old));
    metadataSet(openDatabase(), 'last_backup_at', new Date().toISOString());
    metadataSet(openDatabase(), 'last_backup_file', name);
    return { created: true, file: name };
  })().finally(() => { backupRunning = null; });
  return backupRunning;
}

function backupStatus() {
  const db = openDatabase();
  return {
    lastBackupAt: metadataGet(db, 'last_backup_at'),
    lastBackupFile: metadataGet(db, 'last_backup_file'),
    retained: backupFiles().length,
  };
}

function startBackupSchedule() {
  if (backupTimer) return;
  createDatabaseBackup().catch((err) => console.error('Database backup failed:', err.message));
  backupTimer = setInterval(() => {
    createDatabaseBackup().catch((err) => console.error('Database backup failed:', err.message));
  }, BACKUP_INTERVAL_MS);
  backupTimer.unref();
}

function getAppValue(key, fallback = null) {
  const row = openDatabase().prepare('SELECT value_json FROM app_state WHERE key = ?').get(key);
  return row ? JSON.parse(row.value_json) : fallback;
}

function setAppValue(key, value) {
  openDatabase().prepare(`
    INSERT INTO app_state(key, value_json, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
  `).run(key, json(value), new Date().toISOString());
  return value;
}

function deviceId() {
  const db = openDatabase();
  return metadataGet(db, 'device_id');
}

function syncBundle() {
  const db = openDatabase();
  return {
    version: 1,
    deviceId: deviceId(),
    generatedAt: new Date().toISOString(),
    records: db.prepare('SELECT kind, key, value_json, updated_at, device_id FROM sync_records ORDER BY kind, key').all()
      .map((row) => ({
        kind: row.kind,
        key: row.key,
        value: JSON.parse(row.value_json),
        updatedAt: row.updated_at,
        deviceId: row.device_id,
      })),
  };
}

function newerSyncRecord(incoming, local) {
  if (!local) return true;
  const timeCompare = String(incoming.updatedAt).localeCompare(String(local.updated_at));
  return timeCompare > 0 || (timeCompare === 0 && String(incoming.deviceId).localeCompare(String(local.device_id)) > 0);
}

function mergeSyncBundles(bundles) {
  const db = openDatabase();
  const getRecord = db.prepare('SELECT updated_at, device_id FROM sync_records WHERE kind = ? AND key = ?');
  const getEntity = db.prepare('SELECT value_json FROM entities WHERE kind = ? AND key = ?');
  const putEntity = db.prepare(`
    INSERT INTO entities(kind, key, value_json, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(kind, key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
  `);
  let applied = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const bundle of bundles || []) {
      if (!bundle || bundle.version !== 1 || !Array.isArray(bundle.records)) continue;
      for (const record of bundle.records) {
        if (!['show', 'tracking', 'custom_name', 'watch', 'position', 'setting', 'settings', 'manga', 'manga_tracking', 'manga_read', 'manga_position'].includes(record.kind) || !record.key || !record.updatedAt || !record.deviceId) continue;
        if (!newerSyncRecord(record, getRecord.get(record.kind, record.key))) continue;
        if (record.kind === 'show') {
          const existing = getEntity.get('shows', record.key);
          const show = existing ? JSON.parse(existing.value_json) : { id: record.key, watchedEpisodes: [] };
          putEntity.run('shows', record.key, json({ ...show, ...syncShowValue(record.value || {}), updatedAt: record.updatedAt }), record.updatedAt);
        } else if (record.kind === 'tracking' || record.kind === 'custom_name') {
          const existing = getEntity.get('shows', record.key);
          const show = existing ? JSON.parse(existing.value_json) : { id: record.key, watchedEpisodes: [] };
          putEntity.run('shows', record.key, json({ ...show, ...(record.value || {}), updatedAt: record.updatedAt }), record.updatedAt);
        } else if (record.kind === 'watch') {
          const showId = record.value?.showId;
          const episode = String(record.value?.episode || '');
          if (!showId || !episode) continue;
          const existing = getEntity.get('shows', showId);
          const show = existing ? JSON.parse(existing.value_json) : { id: showId, watchedEpisodes: [] };
          const watched = new Set(show.watchedEpisodes || []);
          if (record.value.watched) watched.add(episode); else watched.delete(episode);
          const sorted = Array.from(watched).sort((a, b) => Number(a) - Number(b) || String(a).localeCompare(String(b)));
          putEntity.run('shows', showId, json({ ...show, watchedEpisodes: sorted, lastWatched: sorted.at(-1) || '', updatedAt: record.updatedAt }), record.updatedAt);
        } else if (record.kind === 'position') {
          if (record.value === null) db.prepare("DELETE FROM entities WHERE kind = 'positions' AND key = ?").run(record.key);
          else putEntity.run('positions', record.key, json(record.value), record.updatedAt);
        } else if (record.kind === 'manga_position') {
          const mangaId = record.value?.mangaId;
          const chapter = String(record.value?.chapter || '');
          const existing = mangaId ? getEntity.get('mangas', mangaId) : null;
          const manga = existing ? JSON.parse(existing.value_json) : null;
          const alreadyRead = new Set((manga?.readChapters || []).map(String)).has(chapter);
          if (record.value === null || alreadyRead) db.prepare("DELETE FROM entities WHERE kind = 'mangaPositions' AND key = ?").run(record.key);
          else putEntity.run('mangaPositions', record.key, json(record.value), record.updatedAt);
        } else if (record.kind === 'manga') {
          const existing = getEntity.get('mangas', record.key);
          const manga = existing ? JSON.parse(existing.value_json) : { id: record.key, readChapters: [] };
          putEntity.run('mangas', record.key, json({ ...manga, ...syncMangaValue(record.value || {}), updatedAt: record.updatedAt }), record.updatedAt);
        } else if (record.kind === 'manga_tracking') {
          const existing = getEntity.get('mangas', record.key);
          const manga = existing ? JSON.parse(existing.value_json) : { id: record.key, readChapters: [] };
          putEntity.run('mangas', record.key, json({ ...manga, ...(record.value || {}), updatedAt: record.updatedAt }), record.updatedAt);
        } else if (record.kind === 'manga_read') {
          const mangaId = record.value?.mangaId;
          const chapter = String(record.value?.chapter || '');
          if (!mangaId || !chapter) continue;
          const existing = getEntity.get('mangas', mangaId);
          const manga = existing ? JSON.parse(existing.value_json) : { id: mangaId, readChapters: [] };
          const chapters = new Set((manga.readChapters || []).map(String));
          if (record.value.read) chapters.add(chapter); else chapters.delete(chapter);
          const readChapters = Array.from(chapters).sort((a, b) => Number(a) - Number(b) || a.localeCompare(b));
          putEntity.run('mangas', mangaId, json({ ...manga, readChapters, updatedAt: record.updatedAt }), record.updatedAt);
          if (record.value.read) clearMangaPositions(db, mangaId, [chapter], record.updatedAt, record.deviceId);
        } else if (record.kind === 'setting') {
          const existing = getAppValue('settings', defaultSettings());
          existing[record.key] = record.value;
          db.prepare(`
            INSERT INTO app_state(key, value_json, updated_at) VALUES ('settings', ?, ?)
            ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
          `).run(json(existing), record.updatedAt);
        } else if (record.kind === 'settings') {
          const existing = getAppValue('settings', defaultSettings());
          db.prepare(`
            INSERT INTO app_state(key, value_json, updated_at) VALUES ('settings', ?, ?)
            ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
          `).run(json({ ...existing, ...(record.value || {}) }), record.updatedAt);
        }
        syncRecordPut(db, record.kind, record.key, record.value, record.updatedAt, record.deviceId);
        applied += 1;
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return { applied };
}

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(JOB_LOG_DIR, { recursive: true });
  fs.mkdirSync(HISTORY_DIR, { recursive: true });
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
  if (!fs.existsSync(HISTORY_FILE)) fs.writeFileSync(HISTORY_FILE, '');
  openDatabase();
}

function cacheEntryFresh(entry, ttlMs) {
  return entry?.createdAt && Date.now() - Date.parse(entry.createdAt) < ttlMs;
}

function cacheGet(state, namespace, key, ttlMs) {
  const entry = state.cache?.[namespace]?.[key];
  if (cacheEntryFresh(entry, ttlMs)) return entry.value;
  if (entry) delete state.cache[namespace][key];
  return null;
}

function cacheSet(state, namespace, key, value) {
  state.cache ||= {};
  state.cache[namespace] ||= {};
  state.cache[namespace][key] = { value, createdAt: new Date().toISOString() };
  return value;
}

function trimCache(state, namespace, maxEntries = 120) {
  const bucket = state.cache?.[namespace];
  if (!bucket) return;
  const entries = Object.entries(bucket)
    .sort((a, b) => Date.parse(b[1]?.createdAt || 0) - Date.parse(a[1]?.createdAt || 0));
  for (const [key] of entries.slice(maxEntries)) delete bucket[key];
}

module.exports = {
  ensureDataDir,
  defaultSettings,
  readJson,
  writeJson,
  readState,
  saveState,
  recentJobs,
  cacheGet,
  cacheSet,
  trimCache,
  getAppValue,
  setAppValue,
  deviceId,
  syncBundle,
  mergeSyncBundles,
  updateShowWatched,
  savePositionAtomic,
  saveMangaPositionAtomic,
  updateMangaRead,
  updateMangaReadBatch,
  createDatabaseBackup,
  backupStatus,
  startBackupSchedule,
};
