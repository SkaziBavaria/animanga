import { api, toast, withBusy } from './api.js';
import { els } from './dom.js';
import { state } from './state.js';
import {
  downloadClass,
  isDownloadBusy,
} from './download-helpers.js';
import { escapeHtml } from './util.js';

function pokeJobsSoon() {
  setTimeout(() => import('./jobs.js').then(({ loadJobs }) => loadJobs()).catch(() => {}), 1200);
}

export async function downloadEpisode(show, episode) {
  toast(`Starting download for ep ${episode}...`);
  await api('/api/download', {
    method: 'POST',
    body: JSON.stringify({
      ...show,
      episode,
      mode: show.mode || state.settings.mode,
      quality: state.settings.quality,
    }),
  });
  toast('Download started. Check Settings > Logs.');
  await loadDownloads();
  pokeJobsSoon();
}

export async function downloadAllEpisodes(show) {
  toast('Queueing season downloads...');
  const data = await api('/api/download-season', {
    method: 'POST',
    body: JSON.stringify({
      ...show,
      mode: show.mode || state.settings.mode,
      quality: state.settings.quality,
    }),
  });
  toast(`${data.queued?.length || 0} episodes queued`);
  await loadDownloads();
  pokeJobsSoon();
}

export async function deleteEpisodeDownload(show, episode) {
  await api(`/api/downloads/${encodeURIComponent(show.id)}/${encodeURIComponent(episode)}`, { method: 'DELETE' });
  toast(`Episode ${episode} deleted`);
  await loadDownloads();
}

export async function deleteAllEpisodeDownloads(show) {
  const ok = window.confirm(`Delete all downloaded episodes for "${show.name || show.title}"? Running downloads will be skipped.`);
  if (!ok) return;
  const data = await api(`/api/downloads/${encodeURIComponent(show.id)}`, { method: 'DELETE' });
  toast(`${data.deleted || 0} downloads removed${data.cancelled ? `, ${data.cancelled} cancelled` : ''}`);
  await loadDownloads();
}

export async function deleteDownload(showId, episode) {
  const ok = window.confirm(`Delete downloaded episode ${episode}?`);
  if (!ok) return;
  await api(`/api/downloads/${encodeURIComponent(showId)}/${encodeURIComponent(episode)}`, { method: 'DELETE' });
  toast('Download deleted');
  await loadDownloads();
}

export function renderDownloads() {
  const downloads = Object.values(state.downloads || {})
    .filter((item) => item.status !== 'deleted')
    .sort((a, b) => String(b.updatedAt || b.startedAt || '').localeCompare(String(a.updatedAt || a.startedAt || '')));
  els.downloadsList.innerHTML = downloads.length ? downloads.map((item) => {
    const size = item.file?.size ? `${Math.round(item.file.size / 1024 / 1024)} MB` : '';
    const meta = [item.status, `Episode ${item.episode}`, size, item.file?.filename].filter(Boolean).join(' · ');
    return `
      <article class="download-card ${escapeHtml(downloadClass(item.status))}" data-show-id="${escapeHtml(item.showId)}" data-episode="${escapeHtml(item.episode)}">
        <div>
          <strong>${escapeHtml(item.showName || 'Download')}</strong>
          <span>${escapeHtml(meta)}</span>
        </div>
        <button class="small-button danger" data-action="delete-download" type="button" ${isDownloadBusy(item.status) ? 'disabled' : ''}>Delete</button>
      </article>
    `;
  }).join('') : '<div class="empty">No downloads.</div>';
}

function scheduleDownloadsPoll() {
  clearTimeout(loadDownloads.timer);
  const hasActive = Object.values(state.downloads || {}).some((item) => isDownloadBusy(item.status));
  if (hasActive) {
    loadDownloads.timer = setTimeout(() => loadDownloads().catch(() => {}), 1200);
  }
}

async function refreshDownloadViews() {
  const { renderLibrary } = await import('./library.js');
  const { renderEpisodeGrid } = await import('./episodes.js');
  renderDownloads();
  renderLibrary();
  if (state.activeShow) renderEpisodeGrid(state.activeShow);
}

export async function loadDownloads() {
  const data = await api('/api/downloads');
  state.downloads = data.downloads || {};
  await refreshDownloadViews();
  scheduleDownloadsPoll();
}

export function bindDownloadControls() {
  els.downloadAllBtn.addEventListener('click', () => {
    if (!state.activeShow) return;
    withBusy(els.downloadAllBtn, 'Queueing...', () => downloadAllEpisodes(state.activeShow)).catch((err) => toast(err.message));
  });
  els.deleteAllDownloadsBtn.addEventListener('click', () => {
    if (!state.activeShow) return;
    withBusy(els.deleteAllDownloadsBtn, 'Deleting...', () => deleteAllEpisodeDownloads(state.activeShow)).catch((err) => toast(err.message));
  });
  els.downloadsList.addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-action="delete-download"]');
    if (!button) return;
    const card = button.closest('.download-card');
    if (!card) return;
    try {
      await withBusy(button, 'Deleting...', () => deleteDownload(card.dataset.showId, card.dataset.episode));
    } catch (err) {
      toast(err.message);
    }
  });
  els.downloadsBtn.addEventListener('click', () => loadDownloads().catch((err) => toast(err.message)));
}
