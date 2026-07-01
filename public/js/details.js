import { api } from './api.js';
import { els } from './dom.js';
import { state } from './state.js';
import { relatedSeasonSection } from './shows.js';
import { escapeHtml, showInitials, stripDescription, thumbnailUrl } from './util.js';

export async function openDetails(show) {
  state.detailsRelations = [];
  els.detailsTitle.textContent = show.name || show.title || 'About';
  els.detailsMeta.textContent = 'Fetching details...';
  els.detailsBody.innerHTML = '';
  if (!els.detailsDialog.open) els.detailsDialog.showModal();

  const mode = show.mode || state.settings.mode;
  const data = await api(`/api/shows/${encodeURIComponent(show.id)}/details?mode=${encodeURIComponent(mode)}`);
  const item = { ...show, ...(data.show || {}) };
  state.detailsRelations = item.relations || [];
  const thumb = thumbnailUrl(item);
  const description = stripDescription(item.description) || 'No description available.';
  const meta = [item.type, item.status, item.score ? `Score ${item.score}` : '']
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
}

export function bindDetailsDialog() {
  els.closeDetailsBtn.addEventListener('click', () => els.detailsDialog.close());
}
