import { api, toast } from './api.js';
import { els } from './dom.js';
import { state } from './state.js';
import { noSearchResultsHtml, showCard } from './shows.js';
import { escapeHtml } from './util.js';

function currentMode() {
  return state.settings?.mode || 'sub';
}

function discoverFilterParams() {
  const params = new URLSearchParams();
  for (const genre of state.discoverGenres || []) params.append('genre', genre);
  if (state.discoverYear) params.set('year', String(state.discoverYear));
  return params;
}

function renderSearchResults(results, emptyHtml) {
  state.searchResults = results;
  els.searchResults.innerHTML = results.length
    ? results.map((show) => showCard(show, 'search')).join('')
    : emptyHtml;
}

export function refreshSearchResults() {
  if (!state.searchResults.length) return;
  els.searchResults.innerHTML = state.searchResults.map((show) => showCard(show, 'search')).join('');
}

export async function search(q) {
  document.querySelectorAll('.browse-button').forEach((button) => button.classList.remove('active'));
  state.discoverLoaded = true;
  state.lastSearchQuery = q;
  els.searchResults.innerHTML = '<div class="empty">Searching...</div>';
  const params = discoverFilterParams();
  params.set('q', q);
  params.set('mode', currentMode());
  const data = await api(`/api/search?${params.toString()}`);
  renderSearchResults(data.results || [], noSearchResultsHtml(q));
}

export async function applyDiscoverFilters({ genres, year }) {
  state.discoverGenres = [...genres];
  state.discoverYear = year || null;
  document.querySelectorAll('.browse-button').forEach((button) => button.classList.remove('active'));
  const query = els.searchInput.value.trim();
  state.discoverLoaded = true;
  state.lastSearchQuery = query;
  const label = [genres.length ? genres.join(' + ') : '', year || ''].filter(Boolean).join(' · ') || 'all titles';
  els.searchResults.innerHTML = `<div class="empty">Loading ${escapeHtml(label)}...</div>`;
  const params = discoverFilterParams();
  params.set('q', query);
  params.set('mode', currentMode());
  const data = await api(`/api/search?${params.toString()}`);
  renderSearchResults(data.results || [], '<div class="empty">No results for this genre.</div>');
}

export async function browsePopular(range, label) {
  state.discoverLoaded = true;
  els.searchResults.innerHTML = `<div class="empty">Loading ${escapeHtml(label)}...</div>`;
  const data = await api(`/api/popular?range=${encodeURIComponent(range)}&mode=${encodeURIComponent(currentMode())}`);
  renderSearchResults(data.results || [], '<div class="empty">No results.</div>');
}

export async function browseRecommended() {
  state.discoverLoaded = true;
  els.searchResults.innerHTML = '<div class="empty">Finding recommendations...</div>';
  const data = await api(`/api/recommendations?mode=${encodeURIComponent(currentMode())}`);
  renderSearchResults(
    data.results || [],
    '<div class="empty">No recommendations yet. Track a few shows and refresh your library.</div>'
  );
}

export function loadDefaultDiscover() {
  if (state.discoverLoaded) return;
  const popularButton = document.querySelector('.browse-button[data-popular-range="0"]');
  if (popularButton) popularButton.classList.add('active');
  browsePopular('0', 'Popular').catch((err) => toast(err.message));
}

export function switchView(id) {
  document.querySelectorAll('.view').forEach((view) => view.classList.toggle('active', view.id === id));
  document.querySelectorAll('.tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.view === id));
  if (id === 'searchView') loadDefaultDiscover();
}

function viewFor(section) {
  if (state.mediaMode === 'manga') return section === 'discover' ? 'mangaDiscoverView' : 'mangaLibraryView';
  return section === 'discover' ? 'searchView' : 'libraryView';
}

export function switchSection(section) {
  state.activeSection = section === 'discover' ? 'discover' : 'library';
  const id = viewFor(state.activeSection);
  switchView(id);
  document.querySelectorAll('.tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.section === state.activeSection));
}

export function switchMediaMode(mode = state.mediaMode === 'anime' ? 'manga' : 'anime') {
  if (document.querySelector('#settingsView.active')) state.activeSection = 'library';
  state.mediaMode = mode === 'manga' ? 'manga' : 'anime';
  localStorage.setItem('animanga-media-mode', state.mediaMode);
  els.mediaModeLabel.textContent = state.mediaMode === 'manga' ? 'Manga' : 'Anime';
  const nextMode = state.mediaMode === 'manga' ? 'anime' : 'manga';
  els.mediaSwitchBtn.title = `Switch to ${nextMode}`;
  els.mediaSwitchBtn.setAttribute('aria-label', `Currently showing ${state.mediaMode}. Switch to ${nextMode}`);
  els.refreshBtn.title = `Refresh ${state.mediaMode} library`;
  els.refreshBtn.setAttribute('aria-label', `Refresh ${state.mediaMode} library`);
  switchSection(state.activeSection);
}
