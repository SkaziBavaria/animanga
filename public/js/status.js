import { api } from './api.js';
import { els } from './dom.js';
import { formatCacheAge } from './util.js';

let statusCache = null;

export function isAndroid() {
  return /Android/i.test(navigator.userAgent);
}

export function usesBrowserPlayer() {
  if (statusCache?.deps && 'clientPlayback' in statusCache.deps) {
    return Boolean(statusCache.deps.clientPlayback);
  }
  return true;
}

function renderUpdateNotice(update) {
  if (!els.updateNotice) return;
  if (!update?.latest || !update?.url) {
    els.updateNotice.hidden = true;
    els.updateNotice.removeAttribute('href');
    els.updateNotice.removeAttribute('title');
    els.updateNotice.textContent = '';
    return;
  }
  els.updateNotice.hidden = false;
  els.updateNotice.href = update.url;
  els.updateNotice.title = update.hint || `Update available: ${update.latest}`;
  els.updateNotice.textContent = `Update ${update.latest}`;
}

export async function loadStatus() {
  statusCache = await api('/api/status');
  const version = statusCache.version ? `v${statusCache.version}` : 'AniManga';
  els.statusText.textContent = statusCache.offline
    ? `Offline · cached ${formatCacheAge(statusCache.offlineAgeSeconds)} · ${version}`
    : version;
  renderUpdateNotice(statusCache.update);

  if (!statusCache.offline && !statusCache.update) {
    window.setTimeout(() => {
      api('/api/status')
        .then((fresh) => {
          if (!fresh?.update) return;
          statusCache = { ...statusCache, ...fresh };
          renderUpdateNotice(fresh.update);
        })
        .catch(() => {});
    }, 2000);
  }
}
