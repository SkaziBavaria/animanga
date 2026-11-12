import { api, toast, withBusy } from './api.js';
import { els } from './dom.js';
import { trackShow, removeShow, renderLibrary } from './library.js';
import { refreshSearchResults } from './discover.js';
import { state } from './state.js';
import { relatedSeasonSection } from './shows.js';
import { anilistAiredYearRange, cacheStatusLabel, escapeHtml, showInitials, stripDescription, thumbnailUrl } from './util.js';

function isShowTracked(show) {
  return Boolean(show?.id) && state.library.some((item) => item.id === show.id);
}

function renderDetailsActions(show) {
  if (!els.detailsActions) return;
  if (!show?.id) {
    els.detailsActions.hidden = true;
    els.detailsActions.innerHTML = '';
    return;
  }
  const tracked = isShowTracked(show);
  els.detailsActions.hidden = false;
  els.detailsActions.innerHTML = tracked
    ? '<button class="danger" data-action="details-untrack" type="button">Remove from library</button>'
    : '<button class="primary" data-action="details-track" type="button">Add to library</button>';
}

export async function openDetails(show) {
  state.detailsRelations = [];
  state.activeDetailsShow = show;
  els.detailsTitle.textContent = show.name || show.title || 'About';
  els.detailsMeta.textContent = 'Fetching details...';
  els.detailsBody.innerHTML = '';
  renderDetailsActions(show);
  if (!els.detailsDialog.open) els.detailsDialog.showModal();

  const mode = show.mode || state.settings.mode;
  const data = await api(`/api/shows/${encodeURIComponent(show.id)}/details?mode=${encodeURIComponent(mode)}&provider=${encodeURIComponent(show.provider || '')}`);
  const item = { ...show, ...(data.show || {}) };
  state.activeDetailsShow = item;
  state.detailsRelations = item.relations || [];
  const apply = (list) => {
    const index = list.findIndex((entry) => entry.id === item.id);
    if (index >= 0) list[index] = { ...list[index], ...item };
  };
  apply(state.library);
  apply(state.searchResults);
  renderLibrary();
  refreshSearchResults();
  const thumb = thumbnailUrl({ ...item, thumbnail: item.anilistCoverImage || item.thumbnail });
  const description = stripDescription(item.anilistDescription ?? item.description) || 'No description available.';
  const airedYears = anilistAiredYearRange(item);
  const anilistStatusLabel = ({ FINISHED: 'Finished', RELEASING: 'Ongoing', NOT_YET_RELEASED: 'Announced', CANCELLED: 'Cancelled', HIATUS: 'Hiatus' })[item.anilistStatus] || '';
  const meta = [item.anilistFormat || item.type, airedYears ? `Aired ${airedYears}` : '', item.rating, item.sourceQuality, anilistStatusLabel, item.score ? `Score ${item.score}` : '', cacheStatusLabel(data)]
    .filter(Boolean)
    .join(' · ');
  els.detailsTitle.textContent = item.name || item.title || 'About';
  els.detailsMeta.textContent = meta || `${item.episodeCount || item.latestEpisode || '?'} episodes`;
  els.detailsBody.innerHTML = `
    <div class="details-layout">
      ${thumb
        ? `<img class="details-cover" src="${escapeHtml(thumb)}" alt="" loading="lazy" decoding="async">`
        : `<div class="details-cover placeholder" aria-hidden="true">${escapeHtml(showInitials(item))}</div>`}
      <div class="details-copy">
        <p>${escapeHtml(description)}</p>
        <div class="details-pills">
          ${(item.anilistGenres ?? item.genres ?? []).map((genre) => `<span class="pill">${escapeHtml(genre)}</span>`).join('')}
        </div>
      </div>
    </div>
    ${relatedSeasonSection(state.detailsRelations)}
  `;
  renderDetailsActions(item);
}

export function bindDetailsDialog() {
  els.closeDetailsBtn.addEventListener('click', () => els.detailsDialog.close());
  els.detailsDialog.addEventListener('click', (event) => {
    if (event.target === els.detailsDialog) els.detailsDialog.close();
  });
  els.detailsActions?.addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button || !state.activeDetailsShow) return;
    const show = state.activeDetailsShow;
    if (button.dataset.action === 'details-track') {
      await withBusy(button, 'Saving...', async () => {
        await trackShow(show);
        renderDetailsActions(show);
      }).catch((err) => toast(err.message));
      return;
    }
    if (button.dataset.action === 'details-untrack') {
      await withBusy(button, 'Removing...', async () => {
        await removeShow(show);
        if (!isShowTracked(show)) renderDetailsActions(show);
      }).catch((err) => toast(err.message));
    }
  });
}
