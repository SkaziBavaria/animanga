import { api } from './api.js';
import { els } from './dom.js';
import { state } from './state.js';
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

function renderProviderHealth(providers = {}) {
  if (!els.providerBanner) return;
  const labels = { anidb: 'AniDB', comick: 'ComicK', mangadex: 'MangaDex', weebcentral: 'WeebCentral', mangapill: 'MangaPill', mangatown: 'MangaTown' };
  const relevant = state.mediaMode === 'manga'
    ? new Set(['comick', 'mangadex', 'weebcentral', 'mangapill', 'mangatown'])
    : new Set(['anidb']);
  const failures = Object.values(providers)
    .filter((provider) => provider && provider.ok === false && relevant.has(provider.provider));
  if (!failures.length) {
    els.providerBanner.hidden = true;
    els.providerBanner.textContent = '';
    return;
  }
  els.providerBanner.hidden = false;
  els.providerBanner.textContent = failures.map((provider) => {
    const retry = provider.retryAt ? ` · retry ${new Date(provider.retryAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : '';
    return `${labels[provider.provider] || provider.provider}: ${provider.reason}${retry}`;
  }).join(' · ');
}

window.addEventListener('animanga:media-mode', () => renderProviderHealth(statusCache?.providers));

export async function loadStatus() {
  statusCache = await api('/api/status');
  const version = statusCache.version ? `v${statusCache.version}` : 'AniManga';
  els.statusText.textContent = statusCache.offline
    ? `Offline · cached ${formatCacheAge(statusCache.offlineAgeSeconds)} · ${version}`
    : version;
  renderUpdateNotice(statusCache.update);
  renderProviderHealth(statusCache.providers);

  if (!statusCache.offline && !statusCache.update) {
    window.setTimeout(() => {
      api('/api/status')
        .then((fresh) => {
          statusCache = { ...statusCache, ...fresh };
          if (fresh?.update) renderUpdateNotice(fresh.update);
          renderProviderHealth(fresh.providers);
        })
        .catch(() => {});
    }, 2000);
  }
}
