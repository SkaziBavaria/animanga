import { api, toast } from './api.js';
import { refreshSearchResults } from './discover.js';
import { els } from './dom.js';
import { state } from './state.js';
import { showCard } from './shows.js';
import {
  hasNewEpisodeToContinue,
  hasStarted,
  isCompleted,
  presentAnimeCard,
  progressRatio,
} from './util.js';

function isArchived(show) {
  return Boolean(show?.archived);
}

function filterLibrary(shows) {
  return shows.filter((show) => {
    if (state.libraryFilter === 'archived') return isArchived(show);
    if (state.libraryFilter === 'all') return true;
    if (isArchived(show)) return false;
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
  const activeCount = state.library.filter((show) => !isArchived(show)).length;
  els.libraryCount.textContent = state.libraryFilter === 'archived'
    ? state.library.filter(isArchived).length
    : state.libraryFilter === 'all'
      ? state.library.length
      : activeCount;
  if (!state.library.length) {
    els.libraryList.innerHTML = '<div class="empty empty-action"><span>Your library is empty.</span><button class="small-button secondary" data-action="open-discover" type="button">Find anime</button></div>';
    return;
  }

  const shows = filterLibrary(state.library).sort(sortShows(state.librarySort));
  els.libraryList.innerHTML = shows.length
    ? shows.map((show) => showCard(show, 'library')).join('')
    : '<div class="empty">No shows match this filter.</div>';
}

export function refreshAnimeCards() {
  renderLibrary();
  refreshSearchResults();
}

/** Patch every in-memory copy of a show and recompute card fields. */
export function syncAnimeShow(partial) {
  if (!partial?.id) return null;
  const presented = presentAnimeCard(partial);
  for (const show of state.library) {
    if (show.id === presented.id) Object.assign(show, presented);
  }
  for (const show of state.searchResults) {
    if (show.id === presented.id) Object.assign(show, presented);
  }
  if (state.activeShow?.id === presented.id) Object.assign(state.activeShow, presented);
  return presented;
}

export async function loadLibrary(refresh = false) {
  els.refreshBtn.disabled = true;
  els.refreshBtn.textContent = '…';
  try {
    const data = await api(`/api/library${refresh ? '?refresh=1' : ''}`);
    state.library = data.shows || [];
    refreshAnimeCards();
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
}

export async function removeShow(show) {
  const name = show.name || show.title || 'this anime';
  const ok = window.confirm(`Remove "${name}" from your library?\n\nYou can add it again from Search > Track.`);
  if (!ok) return;
  await api(`/api/shows/${encodeURIComponent(show.id)}`, { method: 'DELETE' });
  toast('Removed from library');
  await loadLibrary(false);
}

export async function setShowArchived(show, archived) {
  const data = await api(`/api/shows/${encodeURIComponent(show.id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ archived: Boolean(archived) }),
  });
  syncAnimeShow({ ...show, ...(data.show || {}), id: show.id, archived: Boolean(archived) });
  refreshAnimeCards();
  toast(archived ? 'Archived' : 'Moved back to active library');
}

export async function updateShowMode(show, mode) {
  const data = await api(`/api/shows/${encodeURIComponent(show.id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ mode }),
  });
  // Keep the known id/metadata even if the API returns a partial show payload.
  syncAnimeShow({ ...show, ...(data.show || {}), id: show.id, mode });
  refreshAnimeCards();
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
