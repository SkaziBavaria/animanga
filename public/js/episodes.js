import { api, toast } from './api.js';
import { els } from './dom.js';
import { state } from './state.js';
import {
  downloadButtonText,
  downloadClass,
  downloadFor,
  episodeStatusText,
  isDownloadBusy,
  isDownloadLocked,
} from './download-helpers.js';
import { loadLibrary, syncAnimeShow, refreshAnimeCards } from './library.js';
import {
  openPlayback,
  resolveLocalPlayback,
  resolveMpvPlayback,
} from './playback.js';
import { usesBrowserPlayer } from './status.js';
import { formatClock, positionFor } from './progress.js';
import {
  cacheStatusLabel,
  escapeHtml,
  episodeReleaseLabel,
  episodeTitle,
  nextEpisode,
  presentAnimeCard,
  releasePills,
} from './util.js';

export async function playShow(show, episode) {
  const localPlayback = await resolveLocalPlayback(show, episode);
  if (localPlayback) {
    toast(`Opening downloaded ep ${episode}...`);
    openPlayback(show, episode, localPlayback);
    await loadLibrary(false);
    return;
  }
  toast(usesBrowserPlayer() ? `Fetching stream for ep ${episode}...` : `Fetching MPV link for ep ${episode}...`);
  const playback = await resolveMpvPlayback(show, episode);
  toast(usesBrowserPlayer() ? 'Opening player...' : 'Opening MPV...');
  openPlayback(show, episode, playback);
  await loadLibrary(false);
}

export async function openEpisodes(show) {
  state.activeShow = show;
  els.dialogTitle.textContent = show.name || show.title;
  els.dialogMeta.textContent = 'Fetching episodes...';
  els.episodeGrid.innerHTML = '';
  els.dialog.showModal();

  const mode = show.mode || state.settings.mode;
  const data = await api(`/api/shows/${encodeURIComponent(show.id)}/episodes?mode=${encodeURIComponent(mode)}`);
  show.episodes = data.episodes || [];
  show.latestEpisode = data.latestEpisode;
  show.episodeTitles = data.episodeTitles || {};
  show.episodeDates = data.episodeDates || {};
  show.name = data.name || show.name;
  show.sourceName = data.sourceName || show.sourceName;
  show.englishName = data.englishName || show.englishName;
  show.airedStart = data.airedStart || show.airedStart;
  show.airedEnd = data.airedEnd || show.airedEnd;
  show.season = data.season || show.season;
  show.nextAiringEpisode = data.nextAiringEpisode || show.nextAiringEpisode;
  show.lastEpisodeDate = data.lastEpisodeDate || show.lastEpisodeDate;
  show.lastEpisodeTimestamp = data.lastEpisodeTimestamp || show.lastEpisodeTimestamp;
  show.offline = Boolean(data.offline);
  show.cacheStatus = cacheStatusLabel(data);
  syncAnimeShow(presentAnimeCard(show));
  refreshAnimeCards();
  renderEpisodeGrid(show);
}

export function renderEpisodeGrid(show) {
  const watched = new Set((show.watchedEpisodes || []).map(String));
  const next = nextEpisode(show);
  const mode = show.mode || state.settings?.mode || 'sub';
  const schedule = releasePills(show);
  els.dialogMeta.textContent = [`${show.episodes.length} episodes`, mode, show.cacheStatus || '', ...schedule].filter(Boolean).join(' / ');
  els.episodeGrid.innerHTML = show.episodes.map((ep) => {
    const epText = String(ep);
    const classes = ['episode'];
    const download = downloadFor(show, epText);
    const status = download?.status || '';
    const busy = isDownloadBusy(status);
    const locked = isDownloadLocked(status);
    if (watched.has(epText)) classes.push('watched');
    if (epText === String(next)) classes.push('next');
    const canDelete = status === 'done' || status === 'failed' || status === 'unknown';
    const resume = positionFor(show.id, epText);
    const validResume = resume && Number(resume.position) >= 5;
    const resumePercent = validResume && Number(resume.duration) > 0
      ? Math.max(1, Math.min(99, Math.round((resume.position / resume.duration) * 100)))
      : 0;
    const watchedPercent = watched.has(epText) ? 100 : resumePercent;
    if (validResume && !watched.has(epText)) classes.push('in-progress');
    const stateLabels = [];
    if (watched.has(epText)) stateLabels.push('Watched');
    else if (validResume) {
      stateLabels.push(Number(resume.duration) > 0
        ? `Resume ${formatClock(resume.position)} / ${formatClock(resume.duration)} · ${resumePercent}%`
        : `Resume ${formatClock(resume.position)}`);
    } else if (epText === String(next)) stateLabels.push('Up next');
    if (status === 'done') stateLabels.push('Downloaded');
    const episodeState = stateLabels.join(' · ') || episodeStatusText(show, epText, watched, next);
    const releaseLabel = episodeReleaseLabel(show, epText);
    const downloadLabel = downloadButtonText(status);
    const downloadIcon = status === 'done' ? '✓' : (status === 'failed' || status === 'unknown') ? '↻' : '↓';
    return `
      <article class="episode-row-wrap ${status ? `has-download ${escapeHtml(downloadClass(status))}` : ''}" data-episode="${escapeHtml(epText)}">
        <div class="episode-row">
          <div class="episode-number" aria-hidden="true">${escapeHtml(epText)}</div>
          <button class="episode episode-play ${classes.join(' ')}" data-episode="${escapeHtml(epText)}" data-action="episode-play" type="button">
            <span class="episode-name">${escapeHtml(episodeTitle(show, epText))}</span>
            ${episodeState ? `<small class="episode-state">${escapeHtml(episodeState)}</small>` : ''}
            ${releaseLabel ? `<small class="episode-state episode-release">${escapeHtml(releaseLabel)}</small>` : ''}
          </button>
          <div class="episode-actions">
            <button class="episode-watch episode-action${watched.has(epText) ? ' active' : ''}" data-episode="${escapeHtml(epText)}" data-action="episode-watched" type="button" title="${watched.has(epText) ? 'Mark as unwatched' : 'Mark as watched'}" aria-label="${watched.has(epText) ? 'Mark episode ' + escapeHtml(epText) + ' as unwatched' : 'Mark episode ' + escapeHtml(epText) + ' as watched'}" aria-pressed="${watched.has(epText)}">
              <span class="watch-icon" aria-hidden="true">${watched.has(epText) ? '✓' : '👁'}</span>
            </button>
            <button class="episode-download episode-action ${downloadClass(status)}" data-episode="${escapeHtml(epText)}" data-action="episode-download" type="button" title="${escapeHtml(downloadLabel)} episode ${escapeHtml(epText)}" aria-label="${escapeHtml(downloadLabel)} episode ${escapeHtml(epText)}" ${locked ? 'disabled' : ''}>
              <span class="download-icon" aria-hidden="true">${downloadIcon}</span>
            </button>
            ${canDelete ? `<button class="episode-delete episode-action danger" data-episode="${escapeHtml(epText)}" data-action="episode-delete" type="button" title="Delete download" aria-label="Delete episode ${escapeHtml(epText)} download">×</button>` : ''}
          </div>
        </div>
        <div class="episode-view-progress${watched.has(epText) ? ' complete' : ''}" role="progressbar" aria-label="Episode ${escapeHtml(epText)} watched progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${watchedPercent}" aria-valuetext="${watched.has(epText) ? 'Watched' : watchedPercent + '% watched'}">
            <span style="width:${watchedPercent}%"></span>
        </div>
        ${busy ? `
          <div class="episode-progress" aria-hidden="true">
            <span></span>
          </div>
        ` : ''}
      </article>
    `;
  }).join('');
}

export async function toggleEpisodeWatched(show, episode) {
  const epText = String(episode);
  const watched = new Set((show.watchedEpisodes || []).map(String));
  const shouldWatch = !watched.has(epText);
  const data = await api('/api/mark', {
    method: 'POST',
    body: JSON.stringify({ id: show.id, episode: epText, watched: shouldWatch }),
  });
  if (shouldWatch) delete state.positions[`${show.id}:${epText}`];
  const preservedEpisodes = show.episodes;
  const presented = syncAnimeShow(presentAnimeCard({
    ...show,
    ...(data.show || {}),
    episodes: preservedEpisodes,
  }));
  if (presented) presented.episodes = preservedEpisodes;
  show.episodes = preservedEpisodes;
  renderEpisodeGrid(show);
  refreshAnimeCards();
  toast(shouldWatch ? `Episode ${epText} marked watched` : `Episode ${epText} marked unwatched`);
}

export function bindEpisodeDialog() {
  els.closeDialogBtn.addEventListener('click', () => els.dialog.close());
}
