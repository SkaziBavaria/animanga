import { api } from './api.js';
import { els } from './dom.js';
import { formatCacheAge } from './util.js';

let statusCache = null;

export function isAndroid() {
  return /Android/i.test(navigator.userAgent);
}

export function usesBrowserPlayer() {
  if (statusCache?.deps?.clientPlayback) return true;
  return !isAndroid() && !statusCache?.deps?.androidActivityManager;
}

export async function loadStatus() {
  statusCache = await api('/api/status');
  const mode = statusCache.deps?.clientPlayback ? 'browser play' : 'MPV';
  const resolver = statusCache.deps?.animeResolver === 'node'
    ? 'AniManga resolver'
    : `ani-cli ${statusCache.aniCliVersion || ''}`.trim();
  els.statusText.textContent = statusCache.offline
    ? `Offline · cached ${formatCacheAge(statusCache.offlineAgeSeconds)} · ${mode}`
    : `${resolver} · ${mode}`;
}
