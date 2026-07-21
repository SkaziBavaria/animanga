import { toast } from './api.js';
import { bindEvents } from './events.js';
import { loadDownloads } from './downloads.js';
import { loadJobs } from './jobs.js';
import { loadLibrary, loadSettings } from './library.js';
import { checkReleaseWatches, loadReleaseWatches } from './release-watches.js';
import { loadProgress } from './progress.js';
import { loadStatus } from './status.js';
import { bindSyncControls, loadSyncConfig, startAutoSync } from './sync.js';
import { bindMangaControls, loadMangaLibrary } from './manga.js';
import { bindMangaReleaseWatches, checkMangaReleaseWatches, loadMangaReleaseWatches } from './manga-release-watches.js';
import { switchMediaMode } from './discover.js';
import { state } from './state.js';

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').then((registration) => registration.update()).catch(() => {});
}

bindEvents();
bindSyncControls();
bindMangaControls();
bindMangaReleaseWatches();
switchMediaMode(state.mediaMode);
startAutoSync();

(async function init() {
  try {
    await Promise.all([loadStatus(), loadSettings(), loadSyncConfig()]);
    await loadProgress();
    await loadLibrary(false);
    await loadMangaLibrary(false);
    await loadDownloads();
    await loadReleaseWatches();
    await loadMangaReleaseWatches();
    checkReleaseWatches({ silent: true }).catch(() => {});
    checkMangaReleaseWatches({ silent: true }).catch(() => {});
    await loadJobs();
    if (new URLSearchParams(window.location.search).get('sync') === 'connected') {
      toast('Google Drive connected');
      history.replaceState({}, '', window.location.pathname);
    }
  } catch (err) {
    toast(err.message);
  }
}());
