import { api, toast } from './api.js';
import { els } from './dom.js';
import { state } from './state.js';
import { showCard } from './shows.js';
import {
  hasNewEpisodeToContinue,
  hasStarted,
  isCompleted,
  progressRatio,
} from './util.js';

function filterLibrary(shows) {
  return shows.filter((show) => {
    if (state.libraryFilter === 'continue') return hasStarted(show) && hasNewEpisodeToContinue(show);
    if (state.libraryFilter === 'caughtup') return isCompleted(show);
    if (state.libraryFilter === 'notstarted') return !hasStarted(show);
    return true;
  });
}

function sortShows(sort) {
  return (a, b) => {
    if (sort === 'az') return String(a.name || a.title).localeCompare(String(b.name || b.title));
    if (sort === 'recent') return String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
    if (sort === 'progress') {
      const diff = progressRatio(b) - progressRatio(a);
      return diff || String(a.name || a.title).localeCompare(String(b.name || b.title));
    }
    return (b.newCount - a.newCount) || String(a.name || a.title).localeCompare(String(b.name || b.title));
  };
}

export function renderLibrary() {
  els.libraryCount.textContent = state.library.length;
  if (!state.library.length) {
    els.libraryList.innerHTML = '<div class="empty">Your library is empty. Search for an anime and press Track.</div>';
    return;
  }

  const shows = filterLibrary(state.library).sort(sortShows(state.librarySort));
  els.libraryList.innerHTML = shows.length
    ? shows.map((show) => showCard(show, 'library')).join('')
    : '<div class="empty">No shows match this filter.</div>';
}

export async function loadLibrary(refresh = false) {
  els.refreshBtn.disabled = true;
  els.refreshBtn.textContent = '…';
  try {
    const data = await api(`/api/library${refresh ? '?refresh=1' : ''}`);
    state.library = data.shows || [];
    renderLibrary();
    if (refresh) toast('Library updated');
  } finally {
    els.refreshBtn.disabled = false;
    els.refreshBtn.textContent = '↻';
  }
}

export async function trackShow(show) {
  toast('Adding to library...');
  await api('/api/track', { method: 'POST', body: JSON.stringify({ ...show, tracked: true }) });
  toast('Anime tracked');
  await loadLibrary(false);
  if (state.searchResults.length) {
    els.searchResults.innerHTML = state.searchResults.map((item) => showCard(item, 'search')).join('');
  }
}

export async function removeShow(show) {
  const name = show.name || show.title || 'this anime';
  const ok = window.confirm(`Remove "${name}" from your library?\n\nThis will not delete ani-cli history. You can add it again from Search > Track.`);
  if (!ok) return;
  await api(`/api/shows/${encodeURIComponent(show.id)}`, { method: 'DELETE' });
  toast('Removed from library');
  await loadLibrary(false);
}

export async function updateShowMode(show, mode) {
  const data = await api(`/api/shows/${encodeURIComponent(show.id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ mode }),
  });
  Object.assign(show, data.show);
  renderLibrary();
  toast(`Using ${String(mode).toUpperCase()} for ${show.name || show.title}`);
}

export async function loadSettings() {
  state.settings = await api('/api/settings');
  for (const [key, value] of Object.entries(state.settings)) {
    const field = els.settingsForm.elements[key];
    if (!field) continue;
    if (field.type === 'checkbox') field.checked = Boolean(value);
    else field.value = value;
  }
}
