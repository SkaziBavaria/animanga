'use strict';

const { readState, saveState } = require('./state');
const { refreshShow } = require('./library');
const { refreshManga } = require('./manga-library');
const { recordProviderFailure } = require('./provider-health');

const CHECK_INTERVAL_MS = 15 * 60_000;
const ACTIVE_REFRESH_MS = 4 * 60 * 60_000;
const FINISHED_REFRESH_MS = 24 * 60 * 60_000;
const ERROR_BACKOFF_MS = 60 * 60_000;
const BATCH_SIZE = 6;

let initialTimer = null;
let intervalTimer = null;
let running = null;
const blockedUntil = { anime: 0, manga: 0 };

function refreshAgeMs(item) {
  const status = String(item?.status || '').toLowerCase();
  return status.includes('finished') || status.includes('cancelled')
    ? FINISHED_REFRESH_MS
    : ACTIVE_REFRESH_MS;
}

function dueAt(item) {
  const checked = Date.parse(item?.lastCheckedAt || 0);
  return (Number.isFinite(checked) ? checked : 0) + refreshAgeMs(item);
}

function pickDue(items, now = Date.now(), limit = BATCH_SIZE) {
  return (items || [])
    .filter((item) => item?.tracked !== false && dueAt(item) <= now)
    .sort((left, right) => dueAt(left) - dueAt(right))
    .slice(0, limit);
}

async function refreshKind(kind, now, dependencies = {}) {
  if (blockedUntil[kind] > now) return { kind, skipped: 'backoff', refreshed: 0 };
  const load = dependencies.readState || readState;
  const save = dependencies.saveState || saveState;
  const refresh = kind === 'anime'
    ? (dependencies.refreshShow || refreshShow)
    : (dependencies.refreshManga || refreshManga);
  const state = load();
  const collection = kind === 'anime' ? Object.values(state.shows || {}) : Object.values(state.mangas || {});
  const due = pickDue(collection, now, dependencies.batchSize || BATCH_SIZE);
  let refreshed = 0;
  for (const item of due) {
    try {
      await refresh(state, item);
      save(state);
      refreshed += 1;
    } catch (error) {
      blockedUntil[kind] = now + ERROR_BACKOFF_MS;
      recordProviderFailure(kind === 'anime' ? 'anidb' : 'comick', error, { retryAt: blockedUntil[kind], now });
      console.warn(`[auto-refresh] ${kind} paused for 1h:`, error.message || error);
      return { kind, refreshed, failed: true };
    }
  }
  return { kind, refreshed };
}

async function runLibraryRefresh(dependencies = {}) {
  if (running) return running;
  running = (async () => {
    const now = dependencies.now || Date.now();
    const results = [];
    for (const kind of ['anime', 'manga']) results.push(await refreshKind(kind, now, dependencies));
    const changed = results.reduce((sum, result) => sum + result.refreshed, 0);
    if (changed) console.log(`[auto-refresh] updated ${changed} library item(s)`);
    return results;
  })().finally(() => { running = null; });
  return running;
}

function startLibraryRefreshSchedule() {
  if (intervalTimer) return;
  initialTimer = setTimeout(() => runLibraryRefresh().catch((error) => {
    console.warn('[auto-refresh] initial run failed:', error.message || error);
  }), 60_000);
  intervalTimer = setInterval(() => runLibraryRefresh().catch((error) => {
    console.warn('[auto-refresh] scheduled run failed:', error.message || error);
  }), CHECK_INTERVAL_MS);
  initialTimer.unref();
  intervalTimer.unref();
}

async function stopLibraryRefreshSchedule() {
  if (initialTimer) clearTimeout(initialTimer);
  if (intervalTimer) clearInterval(intervalTimer);
  initialTimer = null;
  intervalTimer = null;
  if (running) await running.catch(() => {});
}

module.exports = {
  ACTIVE_REFRESH_MS,
  FINISHED_REFRESH_MS,
  ERROR_BACKOFF_MS,
  BATCH_SIZE,
  refreshAgeMs,
  dueAt,
  pickDue,
  refreshKind,
  runLibraryRefresh,
  startLibraryRefreshSchedule,
  stopLibraryRefreshSchedule,
};
