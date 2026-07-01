import { api, toast } from './api.js';
import { els } from './dom.js';
import { state } from './state.js';
import { escapeHtml } from './util.js';

async function requestNotificationPermission() {
  if (!('Notification' in window)) return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission !== 'default') return false;
  return (await Notification.requestPermission()) === 'granted';
}

function notifyReleaseWatch(watch) {
  const title = watch.matchedShow?.name || watch.matchedShow?.title || watch.query;
  const key = `ani-web-release-watch-${watch.id}-${watch.foundAt || ''}`;
  if (localStorage.getItem(key)) return;
  localStorage.setItem(key, '1');
  if ('Notification' in window && Notification.permission === 'granted') {
    new Notification('Release found', {
      body: title,
      tag: `release-watch-${watch.id}`,
    });
    return;
  }
  toast(`Release found: ${title}`);
}

export async function loadReleaseWatches() {
  if (!els.releaseWatchesList) return;
  const data = await api('/api/release-watches');
  state.releaseWatches = data.watches || [];
  renderReleaseWatches();
}

export function renderReleaseWatches() {
  if (!els.releaseWatchesList) return;
  const count = state.releaseWatches.length;
  const foundCount = state.releaseWatches.filter((watch) => watch.status === 'found').length;
  if (els.releaseWatchesCount) {
    els.releaseWatchesCount.textContent = foundCount ? `${foundCount}/${count}` : String(count);
    els.releaseWatchesCount.classList.toggle('hot', foundCount > 0);
  }
  if (els.releaseWatchesToggleBtn) {
    els.releaseWatchesToggleBtn.textContent = state.releaseWatchesOpen ? 'Hide' : 'Show';
    els.releaseWatchesToggleBtn.disabled = count === 0;
  }
  if (!count) state.releaseWatchesOpen = false;
  if (!state.releaseWatchesOpen) {
    els.releaseWatchesList.hidden = true;
    els.releaseWatchesList.innerHTML = '';
    return;
  }
  els.releaseWatchesList.hidden = false;
  els.releaseWatchesList.innerHTML = state.releaseWatches.length ? state.releaseWatches.map((watch) => {
    const found = watch.status === 'found';
    const title = watch.matchedShow?.name || watch.matchedShow?.title || '';
    const checked = watch.lastCheckedAt ? new Date(watch.lastCheckedAt).toLocaleString() : 'Not checked yet';
    return `
      <article class="watch-card ${found ? 'found' : ''}" data-watch-id="${escapeHtml(watch.id)}">
        <div>
          <strong>${escapeHtml(watch.query)}</strong>
          <span>${escapeHtml(found ? `Found: ${title}` : `Watching · ${watch.mode}`)}</span>
          <span>${escapeHtml(`Last check: ${checked}`)}</span>
        </div>
        <div class="watch-actions">
          ${found && watch.matchedShow?.id ? '<button class="small-button secondary" data-action="watch-track" type="button">Track</button>' : ''}
          <button class="small-button danger" data-action="delete-watch" type="button">Remove</button>
        </div>
      </article>
    `;
  }).join('') : '<div class="empty">No watches yet.</div>';
}

export async function watchRelease(query) {
  const cleanQuery = String(query || '').trim();
  if (!cleanQuery) return;
  await requestNotificationPermission();
  await api('/api/release-watches', {
    method: 'POST',
    body: JSON.stringify({ query: cleanQuery, mode: state.settings?.mode || 'sub' }),
  });
  state.releaseWatchesOpen = true;
  toast(`Watching "${cleanQuery}"`);
  await loadReleaseWatches();
}

export async function checkReleaseWatches({ silent = false } = {}) {
  const data = await api('/api/release-watches/check', { method: 'POST' });
  state.releaseWatches = data.watches || [];
  if (!silent && (data.found || []).length) state.releaseWatchesOpen = true;
  renderReleaseWatches();
  const found = data.found || [];
  found.forEach(notifyReleaseWatch);
  if (!silent) toast(found.length ? `${found.length} release watch found` : 'No releases found yet');
}

export async function deleteReleaseWatch(id) {
  await api(`/api/release-watches/${encodeURIComponent(id)}`, { method: 'DELETE' });
  state.releaseWatches = state.releaseWatches.filter((watch) => watch.id !== id);
  if (!state.releaseWatches.length) state.releaseWatchesOpen = false;
  renderReleaseWatches();
  toast('Release watch removed');
}
