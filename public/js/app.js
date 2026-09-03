import { reportBackgroundError, toast } from './api.js';
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
import { switchMediaMode, switchView } from './discover.js';
import { els } from './dom.js';
import { state } from './state.js';
import { applyUiPrefsToState, syncLibraryControls } from './ui-prefs.js';

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js')
    .then((registration) => registration.update())
    .catch((error) => reportBackgroundError('Service worker registration failed', error));
}

const savedUiPrefs = applyUiPrefsToState(state);
const LOCAL_LIBRARY_RELOAD_MS = 5 * 60_000;
let lastLocalLibraryReload = 0;

async function reloadLocalLibraries() {
  if (document.hidden || Date.now() - lastLocalLibraryReload < LOCAL_LIBRARY_RELOAD_MS) return;
  lastLocalLibraryReload = Date.now();
  await Promise.all([loadStatus(), loadLibrary(false), loadMangaLibrary(false)]);
}

setInterval(() => reloadLocalLibraries().catch((error) => {
  reportBackgroundError('Library reload failed', error);
}), LOCAL_LIBRARY_RELOAD_MS);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) reloadLocalLibraries().catch((error) => {
    reportBackgroundError('Library reload failed', error);
  });
});
bindEvents();
bindSyncControls();
bindMangaControls();
bindMangaReleaseWatches();
syncLibraryControls(els, state);
switchMediaMode(state.mediaMode);
if (savedUiPrefs.nav === 'settings') switchView('settingsView');
startAutoSync();

(async function init() {
  try {
    await Promise.all([loadStatus(), loadSettings(), loadSyncConfig()]);
    await loadProgress();
    await loadLibrary(false);
    await loadMangaLibrary(false);
    lastLocalLibraryReload = Date.now();
    await loadDownloads();
    await loadReleaseWatches();
    await loadMangaReleaseWatches();
    checkReleaseWatches({ silent: true })
      .catch((error) => reportBackgroundError('Anime release check failed', error));
    checkMangaReleaseWatches({ silent: true })
      .catch((error) => reportBackgroundError('Manga release check failed', error));
    await loadJobs();
    if (new URLSearchParams(window.location.search).get('sync') === 'connected') {
      toast('Google Drive connected');
      history.replaceState({}, '', window.location.pathname);
    }
  } catch (err) {
    toast(err.message);
  }
}());
