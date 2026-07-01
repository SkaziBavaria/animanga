'use strict';

const fs = require('fs');
const {
  DATA_DIR,
  JOB_LOG_DIR,
  STATE_FILE,
  HISTORY_DIR,
  HISTORY_FILE,
  DOWNLOAD_DIR,
} = require('./config');
const registry = require('./registry');

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

function readState() {
  const state = readJson(STATE_FILE, {});
  state.shows ||= {};
  state.settings = { ...defaultSettings(), ...(state.settings || {}) };
  state.jobs ||= [];
  state.downloads ||= {};
  state.positions ||= {};
  state.releaseWatches ||= {};
  state.cache ||= {};
  state.cache.details ||= {};
  state.cache.recommendations ||= {};
  return state;
}

function saveState(state) {
  state.jobs = recentJobs(Array.from(registry.jobs.values()), state.jobs || []);
  writeJson(STATE_FILE, state);
}

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(JOB_LOG_DIR, { recursive: true });
  fs.mkdirSync(HISTORY_DIR, { recursive: true });
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
  if (!fs.existsSync(HISTORY_FILE)) fs.writeFileSync(HISTORY_FILE, '');
  if (!fs.existsSync(STATE_FILE)) {
    writeJson(STATE_FILE, { shows: {}, settings: defaultSettings(), jobs: [] });
  }
}

function cacheEntryFresh(entry, ttlMs) {
  return entry?.createdAt && Date.now() - Date.parse(entry.createdAt) < ttlMs;
}

function cacheGet(state, namespace, key, ttlMs) {
  const entry = state.cache?.[namespace]?.[key];
  return cacheEntryFresh(entry, ttlMs) ? entry.value : null;
}

function cacheSet(state, namespace, key, value) {
  state.cache ||= {};
  state.cache[namespace] ||= {};
  state.cache[namespace][key] = {
    value,
    createdAt: new Date().toISOString(),
  };
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
};
