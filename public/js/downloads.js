import { api, reportBackgroundError, toast, withBusy } from './api.js';
import { els } from './dom.js';
import { state } from './state.js';
import {
  downloadClass,
  isDownloadBusy,
} from './download-helpers.js';
import { escapeHtml } from './util.js';

function pokeJobsSoon() {
  setTimeout(() => import('./jobs.js')
    .then(({ loadJobs }) => loadJobs())
    .catch((error) => reportBackgroundError('Could not refresh download jobs', error)), 1200);
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
  pokeJobsSoon();
}

export async function deleteAllEpisodeDownloads(show) {
  const ok = window.confirm(`Delete all downloaded episodes for "${show.name || show.title}"? Running downloads will be skipped.`);
  if (!ok) return;
  const data = await api(`/api/downloads/${encodeURIComponent(show.id)}`, { method: 'DELETE' });
  toast(`${data.deleted || 0} downloads removed${data.cancelled ? `, ${data.cancelled} cancelled` : ''}`);
  await loadDownloads();
  pokeJobsSoon();
}

export async function deleteDownload(showId, episode) {
  const ok = window.confirm(`Delete downloaded episode ${episode}?`);
  if (!ok) return;
  await api(`/api/downloads/${encodeURIComponent(showId)}/${encodeURIComponent(episode)}`, { method: 'DELETE' });
  toast('Download deleted');
  await loadDownloads();
  pokeJobsSoon();
}

export function renderDownloads() {
  const downloads = Object.values(state.downloads || {})
    .filter((item) => item.status !== 'deleted')
    .sort((a, b) => String(b.updatedAt || b.startedAt || '').localeCompare(String(a.updatedAt || a.startedAt || '')));
  const animeCards = downloads.map((item) => {
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
  });
  const mangaCards = (state.offlineMangaDownloads || []).map((item) => `
    <article class="download-card downloaded" data-kind="manga" data-manga-id="${escapeHtml(item.mangaId)}" data-chapter="${escapeHtml(item.chapter)}">
      <div>
        <strong>${escapeHtml(item.mangaName)}</strong>
        <span>Downloaded · Chapter ${escapeHtml(item.chapter)} · ${escapeHtml(item.pages)} pages</span>
      </div>
      <button class="small-button danger" data-action="delete-download" type="button">Delete</button>
    </article>
  `);
  const cards = [...animeCards, ...mangaCards];
  els.downloadsList.innerHTML = cards.length ? cards.join('') : '<div class="empty">No downloads.</div>';
}

function scheduleDownloadsPoll(delay = 1200) {
  clearTimeout(loadDownloads.timer);
  const hasActive = Object.values(state.downloads || {}).some((item) => isDownloadBusy(item.status));
  if (hasActive) {
    loadDownloads.timer = setTimeout(() => loadDownloads().catch((error) => {
      reportBackgroundError('Download polling failed', error);
      scheduleDownloadsPoll(3000);
    }), delay);
  }
}

async function refreshDownloadViews() {
  const { refreshAnimeCards } = await import('./library.js');
  const { renderEpisodeGrid } = await import('./episodes.js');
  renderDownloads();
  refreshAnimeCards();
  if (state.activeShow) renderEpisodeGrid(state.activeShow);
}

export async function loadDownloads() {
  const data = await api('/api/downloads');
  state.downloads = data.downloads || {};
  state.offlineMangaDownloads = data.mangaDownloads || [];
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
      if (card.dataset.kind === 'manga') {
        const ok = window.confirm(`Delete downloaded chapter ${card.dataset.chapter}?`);
        if (!ok) return;
        await withBusy(button, 'Deleting...', () => api(`/api/manga/${encodeURIComponent(card.dataset.mangaId)}/chapters/${encodeURIComponent(card.dataset.chapter)}/download`, { method: 'DELETE' }));
        toast('Downloaded chapter deleted');
        await loadDownloads();
        return;
      }
      await withBusy(button, 'Deleting...', () => deleteDownload(card.dataset.showId, card.dataset.episode));
    } catch (err) {
      toast(err.message);
    }
  });
  els.downloadsBtn.addEventListener('click', () => loadDownloads().catch((err) => toast(err.message)));
}
