import { api, toast, withBusy, runAction } from './api.js';
import { els } from './dom.js';
import { state } from './state.js';
import { applyDiscoverFilters, browsePopular, browseRecommended, search, switchMediaMode, switchSection, switchView } from './discover.js';
import { openDetails, bindDetailsDialog } from './details.js';
import {
  deleteEpisodeDownload,
  downloadEpisode,
  bindDownloadControls,
} from './downloads.js';
import { openEpisodes, playShow, bindEpisodeDialog, toggleEpisodeWatched } from './episodes.js';
import { loadJobs, clearJobs } from './jobs.js';
import { loadLibrary, renderLibrary, trackShow, removeShow, updateShowMode } from './library.js';
import { loadMangaLibrary } from './manga.js';
import { bindPlayerDialog } from './playback.js';
import {
  checkReleaseWatches,
  deleteReleaseWatch,
  renderReleaseWatches,
  watchRelease,
} from './release-watches.js';
import { findShow } from './shows.js';
import { busyLabel, nextEpisode } from './util.js';

function bindGlobalClicks() {
  document.addEventListener('click', async (event) => {
    const tab = event.target.closest('.tab');
    if (tab?.dataset.section) switchSection(tab.dataset.section);
    else if (tab?.dataset.view) switchView(tab.dataset.view);

    const releaseWatchButton = event.target.closest('button[data-action="watch-release"]');
    if (releaseWatchButton) {
      await runAction(releaseWatchButton, 'Saving...', () => watchRelease(releaseWatchButton.dataset.query || state.lastSearchQuery));
      return;
    }

    const browseButton = event.target.closest('.browse-button[data-recommended], .browse-button[data-popular-range]');
    if (browseButton) {
      state.discoverGenres = [];
      state.discoverYear = null;
      els.genreFilter.querySelectorAll('input[type="checkbox"]').forEach((input) => { input.checked = false; });
      els.discoverYearFilter.value = '';
      els.genreFilterSummary.textContent = 'Filters · All';
      document.querySelectorAll('.browse-button').forEach((button) => button.classList.toggle('active', button === browseButton));
      const task = browseButton.dataset.recommended
        ? () => browseRecommended()
        : () => browsePopular(browseButton.dataset.popularRange, browseButton.textContent.trim());
      await runAction(browseButton, 'Loading...', task);
    }

    const cardButton = event.target.closest('.show-card button');
    if (cardButton) {
      const card = cardButton.closest('.show-card');
      const show = findShow(card);
      const action = cardButton.dataset.action;
      await runAction(cardButton, busyLabel(action), async () => {
        if (action === 'play') await playShow(show, cardButton.dataset.ep || nextEpisode(show) || '1');
        if (action === 'track') await trackShow(show);
        if (action === 'tracked') toast('Already in library');
        if (action === 'remove') await removeShow(show);
        if (action === 'episodes') await openEpisodes(show);
        if (action === 'details') await openDetails(show);
      });
    }
  });
}

function bindCardModeChanges() {
  document.addEventListener('change', async (event) => {
    const select = event.target.closest('.show-card select[data-action="mode"]');
    if (!select) return;
    const card = select.closest('.show-card');
    const show = findShow(card);
    const previous = show.mode || state.settings?.mode || 'sub';
    const mode = select.value;
    select.disabled = true;
    try {
      if (card.dataset.source === 'library') await updateShowMode(show, mode);
      else {
        show.mode = mode;
        const count = Number(show.episodeCounts?.[mode] || 0);
        if (count > 0) {
          show.episodeCount = count;
          show.latestEpisode = count;
        }
        toast(`Using ${mode.toUpperCase()} for ${show.name || show.title}`);
      }
    } catch (err) {
      show.mode = previous;
      select.value = previous;
      toast(err.message);
    } finally {
      select.disabled = false;
    }
  });
}

function bindEpisodeGrid() {
  els.episodeGrid.addEventListener('click', async (event) => {
    const watchedButton = event.target.closest('.episode-watch');
    if (watchedButton && state.activeShow) {
      await runAction(watchedButton, '…', () => toggleEpisodeWatched(state.activeShow, watchedButton.dataset.episode));
      return;
    }

    const deleteButton = event.target.closest('.episode-delete');
    if (deleteButton && state.activeShow) {
      await runAction(deleteButton, 'Deleting...', () => deleteEpisodeDownload(state.activeShow, deleteButton.dataset.episode));
      return;
    }

    const downloadButton = event.target.closest('.episode-download');
    if (downloadButton && state.activeShow) {
      await runAction(downloadButton, '…', () => downloadEpisode(state.activeShow, downloadButton.dataset.episode));
      return;
    }

    const button = event.target.closest('.episode');
    if (!button || !state.activeShow) return;
    const episode = button.dataset.episode;
    try {
      // Watched state now updates once playback actually finishes (see markEpisodeFinished in playback.js),
      // not the moment the player opens.
      await playShow(state.activeShow, episode);
    } catch (err) {
      toast(err.message);
    }
  });
}

function bindReleaseWatches() {
  els.releaseWatchesList.addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    const card = button.closest('.watch-card');
    const watch = state.releaseWatches.find((item) => item.id === card?.dataset.watchId);
    if (!watch) return;
    if (button.dataset.action === 'delete-watch') {
      await runAction(button, 'Removing...', () => deleteReleaseWatch(watch.id));
    }
    if (button.dataset.action === 'watch-track' && watch.matchedShow) {
      await runAction(button, 'Saving...', async () => {
        await trackShow(watch.matchedShow);
        await deleteReleaseWatch(watch.id);
      });
    }
  });
  els.releaseWatchesCheckBtn.addEventListener('click', () => checkReleaseWatches().catch((err) => toast(err.message)));
  els.releaseWatchesToggleBtn.addEventListener('click', () => {
    state.releaseWatchesOpen = !state.releaseWatchesOpen;
    renderReleaseWatches();
  });
}

function bindDetailsRelated() {
  els.detailsBody.addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    const item = state.detailsRelations.find((relation) => relation.id === button.closest('.related-item')?.dataset.relatedId);
    if (!item) return;

    try {
      if (button.dataset.action === 'related-details') {
        await withBusy(button, 'Fetching...', () => openDetails(item));
      }
      if (button.dataset.action === 'related-track') {
        await withBusy(button, 'Saving...', () => trackShow(item));
        button.textContent = 'Tracked';
        button.disabled = true;
        button.classList.remove('secondary');
        button.classList.add('tracked');
      }
    } catch (err) {
      toast(err.message);
    }
  });
}

function bindLibraryControls() {
  els.refreshBtn.addEventListener('click', () => {
    const refresh = state.mediaMode === 'manga' ? loadMangaLibrary : loadLibrary;
    refresh(true).catch((err) => toast(err.message));
  });
  els.mediaSwitchBtn.addEventListener('click', () => switchMediaMode());
  els.libraryFilter.addEventListener('change', () => {
    state.libraryFilter = els.libraryFilter.value;
    renderLibrary();
  });
  els.librarySort.addEventListener('change', () => {
    state.librarySort = els.librarySort.value;
    renderLibrary();
  });
}

function bindDiscoverControls() {
  els.genreApplyBtn.addEventListener('click', () => {
    const genres = Array.from(els.genreFilter.querySelectorAll('input[type="checkbox"]:checked')).map((input) => input.value);
    const yearValue = Number(els.discoverYearFilter.value);
    const year = Number.isInteger(yearValue) && yearValue >= 1917 && yearValue <= 2100 ? yearValue : null;
    const summary = [...genres, year].filter(Boolean);
    els.genreFilterSummary.textContent = summary.length ? `Filters · ${summary.join(', ')}` : 'Filters · All';
    els.genreFilter.open = false;
    applyDiscoverFilters({ genres, year }).catch((err) => toast(err.message));
  });
  els.genreClearBtn.addEventListener('click', () => {
    els.genreFilter.querySelectorAll('input[type="checkbox"]').forEach((input) => { input.checked = false; });
    els.discoverYearFilter.value = '';
    els.genreFilterSummary.textContent = 'Filters · All';
    els.genreFilter.open = false;
    applyDiscoverFilters({ genres: [], year: null }).catch((err) => toast(err.message));
  });
}

function bindJobsControls() {
  els.jobsBtn.addEventListener('click', () => loadJobs().catch((err) => toast(err.message)));
  els.clearJobsBtn.addEventListener('click', () => clearJobs().catch((err) => toast(err.message)));
}

function bindForms() {
  els.searchForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const q = els.searchInput.value.trim();
    if (q) search(q).catch((err) => toast(err.message));
  });

  els.settingsForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(els.settingsForm);
    const payload = Object.fromEntries(form.entries());
    payload.skipIntro = els.settingsForm.elements.skipIntro.checked;
    payload.autoTrackPlayed = els.settingsForm.elements.autoTrackPlayed.checked;
    try {
      state.settings = await api('/api/settings', { method: 'POST', body: JSON.stringify(payload) });
      toast('Settings saved');
    } catch (err) {
      toast(err.message);
    }
  });

}

export function bindEvents() {
  bindGlobalClicks();
  bindCardModeChanges();
  bindEpisodeGrid();
  bindEpisodeDialog();
  bindDetailsDialog();
  bindPlayerDialog();
  bindDownloadControls();
  bindReleaseWatches();
  bindDetailsRelated();
  bindLibraryControls();
  bindDiscoverControls();
  bindJobsControls();
  bindForms();
}
