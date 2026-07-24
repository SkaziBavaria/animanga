import { state } from './state.js';

export function downloadKey(showId, episode) {
  return `${showId}:${String(episode || '').trim()}`;
}

export function downloadFor(show, episode) {
  return state.downloads[downloadKey(show.id, episode)] || null;
}

export function downloadStatus(show, episode) {
  return downloadFor(show, episode)?.status || '';
}

export function downloadedEpisodeCount(showId) {
  return Object.values(state.downloads || {})
    .filter((record) => record.showId === showId && record.status === 'done')
    .length;
}

export function isDownloadBusy(status) {
  return status === 'running' || status === 'queued';
}

export function isDownloadLocked(status) {
  return isDownloadBusy(status) || status === 'done';
}

export function downloadButtonText(status) {
  if (status === 'queued') return 'Queued';
  if (isDownloadBusy(status)) return 'Downloading';
  if (status === 'done') return 'Downloaded';
  if (status === 'failed') return 'Retry download';
  if (status === 'unknown') return 'Check download';
  return 'Download';
}

export function downloadClass(status) {
  if (isDownloadBusy(status)) return 'downloading';
  if (status === 'done') return 'downloaded';
  if (status === 'failed' || status === 'unknown') return 'failed';
  return '';
}

export function episodeStatusText(show, episode, watched, next) {
  if (watched.has(episode)) return 'Watched';
  if (episode === String(next)) return 'Up next';
  if (downloadStatus(show, episode) === 'done') return 'Downloaded';
  return '';
}
