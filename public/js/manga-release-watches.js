import { api, runAction, toast } from './api.js';
import { els } from './dom.js';
import { trackManga } from './manga.js';
import { state } from './state.js';
import { escapeHtml } from './util.js';

async function requestNotificationPermission() {
  if (!('Notification' in window)) return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission !== 'default') return false;
  return (await Notification.requestPermission()) === 'granted';
}

function notifyMangaReleaseWatch(watch) {
  const title = watch.matchedManga?.name || watch.matchedManga?.title || watch.query;
  const key = `animanga-manga-release-watch-${watch.id}-${watch.foundAt || ''}`;
  if (localStorage.getItem(key)) return;
  localStorage.setItem(key, '1');
  if ('Notification' in window && Notification.permission === 'granted') {
    new Notification('Manga release found', {
      body: title,
      tag: `manga-release-watch-${watch.id}`,
    });
    return;
  }
  toast(`Manga release found: ${title}`);
}

export async function loadMangaReleaseWatches() {
  if (!els.mangaReleaseWatchesList) return;
  const data = await api('/api/manga/release-watches');
  state.mangaReleaseWatches = data.watches || [];
  renderMangaReleaseWatches();
}

export function renderMangaReleaseWatches() {
  if (!els.mangaReleaseWatchesList) return;
  const count = state.mangaReleaseWatches.length;
  const foundCount = state.mangaReleaseWatches.filter((watch) => watch.status === 'found').length;
  els.mangaReleaseWatchesCount.textContent = foundCount ? `${foundCount}/${count}` : String(count);
  els.mangaReleaseWatchesCount.classList.toggle('hot', foundCount > 0);
  els.mangaReleaseWatchesToggleBtn.textContent = state.mangaReleaseWatchesOpen ? 'Hide' : 'Show';
  els.mangaReleaseWatchesToggleBtn.disabled = count === 0;
  if (!count) state.mangaReleaseWatchesOpen = false;
  if (!state.mangaReleaseWatchesOpen) {
    els.mangaReleaseWatchesList.hidden = true;
    els.mangaReleaseWatchesList.innerHTML = '';
    return;
  }
  els.mangaReleaseWatchesList.hidden = false;
  els.mangaReleaseWatchesList.innerHTML = state.mangaReleaseWatches.map((watch) => {
    const found = watch.status === 'found';
    const title = watch.matchedManga?.name || watch.matchedManga?.title || '';
    const checked = watch.lastCheckedAt ? new Date(watch.lastCheckedAt).toLocaleString() : 'Not checked yet';
    return `
      <article class="watch-card ${found ? 'found' : ''}" data-watch-id="${escapeHtml(watch.id)}">
        <div>
          <strong>${escapeHtml(watch.query)}</strong>
          <span>${escapeHtml(found ? `Found: ${title}` : 'Watching · manga')}</span>
          <span>${escapeHtml(`Last check: ${checked}`)}</span>
        </div>
        <div class="watch-actions">
          ${found && watch.matchedManga?.id ? '<button class="small-button secondary" data-action="manga-watch-track" type="button">Track</button>' : ''}
          <button class="small-button danger" data-action="delete-manga-watch" type="button">Remove</button>
        </div>
      </article>`;
  }).join('');
}

export async function watchMangaRelease(query) {
  const cleanQuery = String(query || '').trim();
  if (!cleanQuery) return;
  await requestNotificationPermission();
  await api('/api/manga/release-watches', {
    method: 'POST',
    body: JSON.stringify({ query: cleanQuery }),
  });
  state.mangaReleaseWatchesOpen = true;
  toast(`Watching manga "${cleanQuery}"`);
  await loadMangaReleaseWatches();
}

export async function checkMangaReleaseWatches({ silent = false } = {}) {
  const data = await api('/api/manga/release-watches/check', { method: 'POST' });
  state.mangaReleaseWatches = data.watches || [];
  if (!silent && (data.found || []).length) state.mangaReleaseWatchesOpen = true;
  renderMangaReleaseWatches();
  const found = data.found || [];
  found.forEach(notifyMangaReleaseWatch);
  if (!silent) toast(found.length ? `${found.length} manga release found` : 'No manga releases found yet');
}

export async function deleteMangaReleaseWatch(id) {
  await api(`/api/manga/release-watches/${encodeURIComponent(id)}`, { method: 'DELETE' });
  state.mangaReleaseWatches = state.mangaReleaseWatches.filter((watch) => watch.id !== id);
  if (!state.mangaReleaseWatches.length) state.mangaReleaseWatchesOpen = false;
  renderMangaReleaseWatches();
  toast('Manga release watch removed');
}

export function bindMangaReleaseWatches() {
  if (!els.mangaReleaseWatchesList) return;
  document.addEventListener('click', async (event) => {
    const watchButton = event.target.closest('button[data-action="manga-watch-release"]');
    if (!watchButton) return;
    await runAction(watchButton, 'Saving...', () => watchMangaRelease(watchButton.dataset.query || state.lastMangaSearchQuery));
  });
  els.mangaReleaseWatchesList.addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    const card = button.closest('.watch-card');
    const watch = state.mangaReleaseWatches.find((item) => item.id === card?.dataset.watchId);
    if (!watch) return;
    if (button.dataset.action === 'delete-manga-watch') {
      await runAction(button, 'Removing...', () => deleteMangaReleaseWatch(watch.id));
    }
    if (button.dataset.action === 'manga-watch-track' && watch.matchedManga) {
      await runAction(button, 'Saving...', async () => {
        await trackManga(watch.matchedManga);
        await deleteMangaReleaseWatch(watch.id);
      });
    }
  });
  els.mangaReleaseWatchesCheckBtn.addEventListener('click', () => checkMangaReleaseWatches().catch((err) => toast(err.message)));
  els.mangaReleaseWatchesToggleBtn.addEventListener('click', () => {
    state.mangaReleaseWatchesOpen = !state.mangaReleaseWatchesOpen;
    renderMangaReleaseWatches();
  });
}
