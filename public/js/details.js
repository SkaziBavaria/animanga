import { api, toast, withBusy } from './api.js';
import { els } from './dom.js';
import { trackShow, removeShow } from './library.js';
import { state } from './state.js';
import { relatedSeasonSection } from './shows.js';
import { cacheStatusLabel, escapeHtml, showInitials, stripDescription, thumbnailUrl } from './util.js';

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
  const data = await api(`/api/shows/${encodeURIComponent(show.id)}/details?mode=${encodeURIComponent(mode)}`);
  const item = { ...show, ...(data.show || {}) };
  state.activeDetailsShow = item;
  state.detailsRelations = item.relations || [];
  const thumb = thumbnailUrl(item);
  const description = stripDescription(item.description) || 'No description available.';
  const meta = [item.type, item.status, item.score ? `Score ${item.score}` : '', cacheStatusLabel(data)]
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
          ${(item.genres || []).map((genre) => `<span class="pill">${escapeHtml(genre)}</span>`).join('')}
        </div>
      </div>
    </div>
    ${relatedSeasonSection(state.detailsRelations)}
  `;
  renderDetailsActions(item);
}

export function bindDetailsDialog() {
  els.closeDetailsBtn.addEventListener('click', () => els.detailsDialog.close());
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
