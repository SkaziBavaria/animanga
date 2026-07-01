import { api } from './api.js';
import { els } from './dom.js';
import { state } from './state.js';
import { noSearchResultsHtml, showCard } from './shows.js';
import { escapeHtml } from './util.js';

function currentMode() {
  return state.settings?.mode || 'sub';
}

function renderSearchResults(results, emptyHtml) {
  state.searchResults = results;
  els.searchResults.innerHTML = results.length
    ? results.map((show) => showCard(show, 'search')).join('')
    : emptyHtml;
}

export async function search(q) {
  document.querySelectorAll('.browse-button').forEach((button) => button.classList.remove('active'));
  state.discoverLoaded = true;
  state.lastSearchQuery = q;
  els.searchResults.innerHTML = '<div class="empty">Searching...</div>';
  const data = await api(`/api/search?q=${encodeURIComponent(q)}&mode=${encodeURIComponent(currentMode())}`);
  renderSearchResults(data.results || [], noSearchResultsHtml(q));
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
