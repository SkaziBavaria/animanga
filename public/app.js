'use strict';

const state = {
  settings: null,
  library: [],
  searchResults: [],
  libraryFilter: 'all',
  librarySort: 'new',
  activeShow: null,
  detailsRelations: [],
  discoverLoaded: false,
};

const $ = (selector) => document.querySelector(selector);
const els = {
  statusText: $('#statusText'),
  refreshBtn: $('#refreshBtn'),
  libraryList: $('#libraryList'),
  libraryCount: $('#libraryCount'),
  libraryFilter: $('#libraryFilter'),
  librarySort: $('#librarySort'),
  searchForm: $('#searchForm'),
  searchInput: $('#searchInput'),
  searchResults: $('#searchResults'),
  settingsForm: $('#settingsForm'),
  commandForm: $('#commandForm'),
  commandInput: $('#commandInput'),
  jobsBtn: $('#jobsBtn'),
  clearJobsBtn: $('#clearJobsBtn'),
  jobsList: $('#jobsList'),
  dialog: $('#showDialog'),
  dialogTitle: $('#dialogTitle'),
  dialogMeta: $('#dialogMeta'),
  episodeGrid: $('#episodeGrid'),
  closeDialogBtn: $('#closeDialogBtn'),
  detailsDialog: $('#detailsDialog'),
  detailsTitle: $('#detailsTitle'),
  detailsMeta: $('#detailsMeta'),
  detailsBody: $('#detailsBody'),
  closeDetailsBtn: $('#closeDetailsBtn'),
  toast: $('#toast'),
};

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) {
    const detail = typeof json.details === 'string'
      ? json.details.replace(/\x1b\[[0-9;]*m/g, '').trim().split('\n').filter(Boolean).slice(-3).join(' · ')
      : '';
    throw new Error(detail ? `${json.error}: ${detail}` : json.error || `HTTP ${res.status}`);
  }
  return json;
}

function toast(message) {
  els.toast.textContent = message;
  els.toast.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => els.toast.classList.remove('show'), 2600);
}

async function withBusy(button, label, task) {
  if (!button) return task();
  const previous = button.textContent;
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  button.classList.add('busy');
  if (label) button.textContent = label;
  try {
    return await task();
  } finally {
    button.disabled = false;
    button.removeAttribute('aria-busy');
    button.classList.remove('busy');
    button.textContent = previous;
  }
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;',
  }[char]));
}

function stripDescription(value) {
  const withBreaks = String(value || '').replace(/<br\s*\/?>/gi, '\n');
  const withoutTags = withBreaks.replace(/<[^>]+>/g, '');
  const textarea = document.createElement('textarea');
  textarea.innerHTML = withoutTags;
  return textarea.value.replace(/\n{3,}/g, '\n\n').trim();
}

function intentUrl(url, player, title) {
  const parsed = new URL(url);
  const extras = [
    'action=android.intent.action.VIEW',
    'type=video/mp4',
    `S.title=${encodeURIComponent(title || 'Ani Web')}`,
  ];
  if (player === 'android_mpv') extras.push('package=is.xyz.mpv');
  if (player === 'vlc') extras.push('package=org.videolan.vlc');
  return `intent://${parsed.host}${parsed.pathname}${parsed.search}#Intent;scheme=${parsed.protocol.replace(':', '')};${extras.join(';')};end`;
}

function trackStarted(show, episode) {
  const body = JSON.stringify({ id: show.id, episode, watched: true });
  const blob = new Blob([body], { type: 'application/json' });
  if (navigator.sendBeacon?.('/api/mark', blob)) return;
  fetch('/api/mark', {
    method: 'POST',
    body,
    headers: { 'content-type': 'application/json' },
    keepalive: true,
  }).catch(() => {});
}

async function resolveMpvPlayback(show, episode) {
  const payload = {
    ...show,
    episode,
    resolveOnly: true,
    mode: show.mode || state.settings.mode,
    quality: state.settings.quality,
    player: 'android_mpv',
    skipIntro: state.settings.skipIntro,
  };
  const data = await api('/api/play', { method: 'POST', body: JSON.stringify(payload) });
  if (!data.playback?.url) throw new Error('No MPV link found');
  return {
    url: data.playback.url,
    title: `${show.name || show.title || 'Video'} ep ${episode}`,
  };
}

function openMpvPlayback(show, episode, playback) {
  window.location.href = intentUrl(playback.url, 'android_mpv', playback.title);
  trackStarted(show, episode);
}

function nextEpisode(show) {
  const list = show.episodes || [];
  const watched = new Set(show.watchedEpisodes || []);
  const last = episodeNumber(show.lastWatched);
  if (list.length) {
    if (Number.isFinite(last)) {
      return list.find((ep) => Number(ep) > last) || list.at(-1);
    }
    return list.find((ep) => !watched.has(String(ep))) || list.at(-1);
  }

  const latest = episodeNumber(show.latestEpisode || show.episodeCount);
  if (Number.isFinite(last) && Number.isFinite(latest) && last < latest) return String(last + 1);
  if (!Number.isFinite(last)) return '1';
  if (Number.isFinite(latest)) return String(latest);
  return show.lastWatched || '1';
}

function episodeNumber(value) {
  if (value === null || value === undefined || value === '') return NaN;
  return Number(value);
}

function hasStarted(show) {
  return Number.isFinite(episodeNumber(show.lastWatched));
}

function latestEpisodeNumber(show) {
  const latest = episodeNumber(show.latestEpisode || show.episodeCount);
  return Number.isFinite(latest) ? latest : null;
}

function hasNewEpisodeToContinue(show) {
  if (Number(show.newCount) > 0) return true;
  const last = episodeNumber(show.lastWatched);
  if (!Number.isFinite(last)) return false;
  const latest = latestEpisodeNumber(show);
  if (latest !== null) return last < latest;
  return (show.episodes || []).some((ep) => Number(ep) > last);
}

function isCompleted(show) {
  const latest = latestEpisodeNumber(show);
  const last = episodeNumber(show.lastWatched);
  return Number.isFinite(last) && latest !== null && last >= latest;
}

function playActionLabel(show, source) {
  if (source === 'library' && hasStarted(show) && hasNewEpisodeToContinue(show)) return 'Continue';
  return 'Play';
}

function thumbnailUrl(show) {
  return show.thumbnail || show.thumbnails?.[0] || '';
}

function showInitials(show) {
  const title = show.name || show.title || '?';
  return title
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase();
}

function progressLabel(show, source) {
  const latest = show.latestEpisode || show.episodeCount || '';
  if (source !== 'library') return latest ? `Episodes ${latest}` : 'Episodes ?';
  const watched = show.lastWatched || highestWatchedEpisode(show) || '0';
  return latest ? `Progress ${watched} / ${latest}` : `Progress ${watched}`;
}

function highestWatchedEpisode(show) {
  return [...(show.watchedEpisodes || [])]
    .filter((episode) => Number.isFinite(Number(episode)))
    .sort((a, b) => Number(a) - Number(b))
    .at(-1);
}

function nextSeasonPill(show) {
  if (!show.hasNextSeason) return '';
  const next = show.nextSeason || {};
  const status = String(next.status || '').toLowerCase();
  const episodeCount = Number(next.episodeCount || next.latestEpisode || 0);
  if (status.includes('not yet') || status.includes('upcoming')) {
    return '<span class="pill sequel upcoming">Next: upcoming</span>';
  }
  if (episodeCount > 0 || status.includes('finished') || status.includes('releasing')) {
    return '<span class="pill sequel released">Next: released</span>';
  }
  return '<span class="pill sequel">Next season</span>';
}

function showCard(show, source) {
  const next = nextEpisode(show);
  const hasNews = Number(show.newCount) > 0;
  const thumb = thumbnailUrl(show);
  const playLabel = playActionLabel(show, source);
  const isTracked = source !== 'library' && state.library.some((item) => item.id === show.id);
  const extraActions = source === 'library'
    ? '<button class="danger" data-action="remove">Remove</button>'
    : isTracked
      ? '<button class="tracked" data-action="tracked" disabled>Tracked</button>'
      : '<button class="secondary" data-action="track">Track</button>';
  return `
    <article class="show-card" data-id="${escapeHtml(show.id)}" data-source="${source}">
      ${thumb
        ? `<img class="show-thumb" src="${escapeHtml(thumb)}" alt="" loading="lazy" decoding="async">`
        : `<div class="show-thumb placeholder" aria-hidden="true">${escapeHtml(showInitials(show))}</div>`}
      <div class="show-main">
        <div class="show-title">${escapeHtml(show.name || show.title)}</div>
        <div class="show-meta">
          <span class="pill">${escapeHtml(progressLabel(show, source))}</span>
          <span class="pill">${escapeHtml(show.mode || state.settings?.mode || 'sub')}</span>
          ${hasNews ? `<span class="pill hot">${show.newCount} new</span>` : ''}
          ${nextSeasonPill(show)}
          ${show.recommendationReason ? `<span class="pill reason">${escapeHtml(show.recommendationReason)}</span>` : ''}
          ${show.refreshError ? `<span class="pill danger">Refresh failed</span>` : ''}
        </div>
      </div>
      <div class="card-actions four">
        <button class="primary" data-action="play" data-ep="${escapeHtml(next)}">${escapeHtml(playLabel)}</button>
        <button class="secondary" data-action="download" data-ep="${escapeHtml(next)}">Download</button>
        <button class="secondary" data-action="episodes">Episodes</button>
        <button class="secondary" data-action="details">About</button>
        ${extraActions}
      </div>
    </article>
  `;
}

function renderLibrary() {
  els.libraryCount.textContent = state.library.length;
  if (!state.library.length) {
    els.libraryList.innerHTML = '<div class="empty">Your library is empty. Search for an anime and press Track.</div>';
    return;
  }

  const shows = filterLibrary(state.library).sort(sortShows(state.librarySort));
  els.libraryList.innerHTML = shows.length
    ? shows.map((show) => showCard(show, 'library')).join('')
    : '<div class="empty">No shows match this filter.</div>';
}

function filterLibrary(shows) {
  return shows.filter((show) => {
    if (state.libraryFilter === 'continue') return hasStarted(show) && hasNewEpisodeToContinue(show);
    if (state.libraryFilter === 'caughtup') return isCompleted(show);
    if (state.libraryFilter === 'notstarted') return !hasStarted(show);
    return true;
  });
}

function sortShows(sort) {
  return (a, b) => {
    if (sort === 'az') return String(a.name || a.title).localeCompare(String(b.name || b.title));
    if (sort === 'recent') return String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
    if (sort === 'progress') {
      const diff = progressRatio(b) - progressRatio(a);
      return diff || String(a.name || a.title).localeCompare(String(b.name || b.title));
    }
    return (b.newCount - a.newCount) || String(a.name || a.title).localeCompare(String(b.name || b.title));
  };
}

function progressRatio(show) {
  const latest = latestEpisodeNumber(show);
  const last = episodeNumber(show.lastWatched);
  if (!Number.isFinite(last) || latest === null || latest <= 0) return 0;
  return Math.min(1, last / latest);
}

function relationLabel(relation) {
  return {
    sequel: 'Next season',
    prequel: 'Previous season',
    summary: 'Summary',
    side_story: 'Side story',
    alternative: 'Alternative',
    other: 'Related',
  }[String(relation || '').toLowerCase()] || 'Related';
}

function relationSortValue(item) {
  return {
    sequel: 0,
    prequel: 1,
    side_story: 2,
    summary: 3,
    alternative: 4,
    other: 5,
  }[String(item.relation || '').toLowerCase()] ?? 9;
}

function relatedSeasonSection(relations = []) {
  const items = [...relations].sort((a, b) => relationSortValue(a) - relationSortValue(b));
  if (!items.length) return '';
  return `
    <section class="related-section" aria-label="Related seasons">
      <h3>Related seasons</h3>
      <div class="related-list">
        ${items.map((item) => {
          const tracked = state.library.some((show) => show.id === item.id);
          const thumb = thumbnailUrl(item);
          const episodes = item.episodeCount ? `${item.episodeCount} episodes` : (item.status || 'No episodes yet');
          return `
            <article class="related-item" data-related-id="${escapeHtml(item.id)}">
              ${thumb
                ? `<img class="related-thumb" src="${escapeHtml(thumb)}" alt="" loading="lazy" decoding="async">`
                : `<div class="related-thumb placeholder" aria-hidden="true">${escapeHtml(showInitials(item))}</div>`}
              <div class="related-main">
                <span class="pill hot">${escapeHtml(relationLabel(item.relation))}</span>
                <strong>${escapeHtml(item.name || item.title || item.id)}</strong>
                <span>${escapeHtml([episodes, item.status].filter(Boolean).join(' · '))}</span>
              </div>
              <div class="related-actions">
                <button class="secondary small-button" data-action="related-details" type="button">About</button>
                ${tracked
                  ? '<button class="tracked small-button" data-action="related-tracked" type="button" disabled>Tracked</button>'
                  : '<button class="secondary small-button" data-action="related-track" type="button">Track</button>'}
              </div>
            </article>
          `;
        }).join('')}
      </div>
    </section>
  `;
}

async function loadStatus() {
  const status = await api('/api/status');
  els.statusText.textContent = `ani-cli ${status.aniCliVersion || ''} · ${status.historyFile}`;
}

async function loadSettings() {
  state.settings = await api('/api/settings');
  for (const [key, value] of Object.entries(state.settings)) {
    const field = els.settingsForm.elements[key];
    if (!field) continue;
    if (field.type === 'checkbox') field.checked = Boolean(value);
    else field.value = value;
  }
}

async function loadLibrary(refresh = false) {
  els.refreshBtn.disabled = true;
  els.refreshBtn.textContent = '…';
  try {
    const data = await api(`/api/library${refresh ? '?refresh=1' : ''}`);
    state.library = data.shows || [];
    renderLibrary();
    if (refresh) toast('Library updated');
  } finally {
    els.refreshBtn.disabled = false;
    els.refreshBtn.textContent = '↻';
  }
}

async function search(q) {
  document.querySelectorAll('.browse-button').forEach((button) => button.classList.remove('active'));
  state.discoverLoaded = true;
  els.searchResults.innerHTML = '<div class="empty">Searching...</div>';
  const mode = state.settings?.mode || 'sub';
  const data = await api(`/api/search?q=${encodeURIComponent(q)}&mode=${encodeURIComponent(mode)}`);
  const results = data.results || [];
  state.searchResults = results;
  els.searchResults.innerHTML = results.length
    ? results.map((show) => showCard(show, 'search')).join('')
    : '<div class="empty">No results.</div>';
}

async function browsePopular(range, label) {
  state.discoverLoaded = true;
  els.searchResults.innerHTML = `<div class="empty">Loading ${escapeHtml(label)}...</div>`;
  const mode = state.settings?.mode || 'sub';
  const data = await api(`/api/popular?range=${encodeURIComponent(range)}&mode=${encodeURIComponent(mode)}`);
  const results = data.results || [];
  state.searchResults = results;
  els.searchResults.innerHTML = results.length
    ? results.map((show) => showCard(show, 'search')).join('')
    : '<div class="empty">No results.</div>';
}

async function browseRecommended() {
  state.discoverLoaded = true;
  els.searchResults.innerHTML = '<div class="empty">Finding recommendations...</div>';
  const mode = state.settings?.mode || 'sub';
  const data = await api(`/api/recommendations?mode=${encodeURIComponent(mode)}`);
  const results = data.results || [];
  state.searchResults = results;
  els.searchResults.innerHTML = results.length
    ? results.map((show) => showCard(show, 'search')).join('')
    : '<div class="empty">No recommendations yet. Track a few shows and refresh your library.</div>';
}

function loadDefaultDiscover() {
  if (state.discoverLoaded) return;
  const popularButton = document.querySelector('.browse-button[data-popular-range="0"]');
  if (popularButton) popularButton.classList.add('active');
  browsePopular('0', 'Popular').catch((err) => toast(err.message));
}

function findShow(card) {
  const id = card.dataset.id;
  const fromLibrary = state.library.find((show) => show.id === id);
  if (fromLibrary) return fromLibrary;
  const fromSearch = state.searchResults.find((show) => show.id === id);
  if (fromSearch) return fromSearch;
  const title = card.querySelector('.show-title')?.textContent || '';
  const episodeCount = Number((card.querySelector('.show-meta .pill:nth-child(2)')?.textContent || '').replace(/\D+/g, '')) || undefined;
  return {
    id,
    name: title,
    title,
    episodeCount,
    mode: state.settings?.mode || 'sub',
  };
}

async function playShow(show, episode) {
  try {
    toast(`Fetching MPV link for ep ${episode}...`);
    const playback = await resolveMpvPlayback(show, episode);
    toast('Opening MPV...');
    openMpvPlayback(show, episode, playback);
    await loadLibrary(false);
  } catch (err) {
    throw err;
  }
}

async function downloadEpisode(show, episode) {
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
  setTimeout(() => loadJobs().catch(() => {}), 1200);
}

async function trackShow(show) {
  toast('Adding to library...');
  await api('/api/track', { method: 'POST', body: JSON.stringify({ ...show, tracked: true }) });
  toast('Anime tracked');
  await loadLibrary(false);
  if (state.searchResults.length) {
    els.searchResults.innerHTML = state.searchResults.map((item) => showCard(item, 'search')).join('');
  }
}

async function removeShow(show) {
  const name = show.name || show.title || 'this anime';
  const ok = window.confirm(`Remove "${name}" from your library?\n\nThis will not delete ani-cli history. You can add it again from Search > Track.`);
  if (!ok) return;
  await api(`/api/shows/${encodeURIComponent(show.id)}`, { method: 'DELETE' });
  toast('Removed from library');
  await loadLibrary(false);
}

async function openDetails(show) {
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

async function openEpisodes(show) {
  state.activeShow = show;
  els.dialogTitle.textContent = show.name || show.title;
  els.dialogMeta.textContent = 'Fetching episodes...';
  els.episodeGrid.innerHTML = '';
  els.dialog.showModal();

  const mode = show.mode || state.settings.mode;
  const data = await api(`/api/shows/${encodeURIComponent(show.id)}/episodes?mode=${encodeURIComponent(mode)}`);
  show.episodes = data.episodes || [];
  show.latestEpisode = data.latestEpisode;
  show.name = data.name || show.name;
  show.sourceName = data.sourceName || show.sourceName;
  show.englishName = data.englishName || show.englishName;
  renderEpisodeGrid(show);
}

function renderEpisodeGrid(show) {
  const watched = new Set(show.watchedEpisodes || []);
  const next = nextEpisode(show);
  const mode = show.mode || state.settings?.mode || 'sub';
  els.dialogMeta.textContent = `${show.episodes.length} episodes · ${mode}`;
  els.episodeGrid.innerHTML = show.episodes.map((ep) => {
    const epText = String(ep);
    const classes = ['episode'];
    if (watched.has(epText)) classes.push('watched');
    if (epText === String(next)) classes.push('next');
    return `
      <div class="episode-cell">
        <button class="${classes.join(' ')}" data-episode="${escapeHtml(epText)}" data-action="episode-play" type="button">${escapeHtml(epText)}</button>
        <button class="episode-download" data-episode="${escapeHtml(epText)}" data-action="episode-download" type="button" title="Download episode ${escapeHtml(epText)}" aria-label="Download episode ${escapeHtml(epText)}">↓</button>
      </div>
    `;
  }).join('');
}

function switchView(id) {
  document.querySelectorAll('.view').forEach((view) => view.classList.toggle('active', view.id === id));
  document.querySelectorAll('.tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.view === id));
  if (id === 'searchView') loadDefaultDiscover();
}

async function loadJobs() {
  const data = await api('/api/jobs');
  const jobs = data.jobs || [];
  els.jobsList.innerHTML = jobs.length ? jobs.map((job) => `
    <article class="job-card">
      <strong>${escapeHtml(job.status)} · ${escapeHtml(job.label)}</strong>
      <span class="show-meta">${escapeHtml(job.startedAt || '')}</span>
      ${job.output ? `<pre>${escapeHtml(job.output)}</pre>` : ''}
      ${job.error ? `<pre>${escapeHtml(job.error)}</pre>` : ''}
    </article>
  `).join('') : '<div class="empty">No jobs.</div>';
}

async function clearJobs() {
  const ok = window.confirm('Clear all job entries and job log files?');
  if (!ok) return;
  await api('/api/jobs', { method: 'DELETE' });
  els.jobsList.innerHTML = '<div class="empty">No jobs.</div>';
  toast('Jobs cleared');
}

document.addEventListener('click', async (event) => {
  const tab = event.target.closest('.tab');
  if (tab) switchView(tab.dataset.view);

  const browseButton = event.target.closest('.browse-button');
  if (browseButton) {
    document.querySelectorAll('.browse-button').forEach((button) => button.classList.toggle('active', button === browseButton));
    try {
      const task = browseButton.dataset.recommended
        ? () => browseRecommended()
        : () => browsePopular(browseButton.dataset.popularRange, browseButton.textContent.trim());
      await withBusy(browseButton, 'Loading...', task);
    } catch (err) {
      toast(err.message);
    }
  }

  const cardButton = event.target.closest('.show-card button');
  if (cardButton) {
    const card = cardButton.closest('.show-card');
    const show = findShow(card);
    const action = cardButton.dataset.action;
    try {
      await withBusy(cardButton, busyLabel(action), async () => {
        if (action === 'play') await playShow(show, cardButton.dataset.ep || nextEpisode(show) || '1');
        if (action === 'download') await downloadEpisode(show, cardButton.dataset.ep || nextEpisode(show) || '1');
        if (action === 'track') await trackShow(show);
        if (action === 'tracked') toast('Already in library');
        if (action === 'remove') await removeShow(show);
        if (action === 'episodes') await openEpisodes(show);
        if (action === 'details') await openDetails(show);
      });
    } catch (err) {
      toast(err.message);
    }
  }
});

function busyLabel(action) {
  return {
    play: 'Starting...',
    download: 'Starting...',
    track: 'Saving...',
    remove: 'Removing...',
    episodes: 'Fetching...',
    details: 'Fetching...',
  }[action] || 'Working...';
}

els.episodeGrid.addEventListener('click', async (event) => {
  const downloadButton = event.target.closest('.episode-download');
  if (downloadButton && state.activeShow) {
    try {
      await withBusy(downloadButton, '…', () => downloadEpisode(state.activeShow, downloadButton.dataset.episode));
    } catch (err) {
      toast(err.message);
    }
    return;
  }

  const button = event.target.closest('.episode');
  if (!button || !state.activeShow) return;
  const episode = button.dataset.episode;
  try {
    await playShow(state.activeShow, episode);
    state.activeShow.lastWatched = episode;
    state.activeShow.watchedEpisodes = Array.from(new Set([...(state.activeShow.watchedEpisodes || []), episode]));
    renderEpisodeGrid(state.activeShow);
    button.classList.add('watched');
  } catch (err) {
    toast(err.message);
  }
});

els.closeDialogBtn.addEventListener('click', () => els.dialog.close());
els.closeDetailsBtn.addEventListener('click', () => els.detailsDialog.close());
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
els.refreshBtn.addEventListener('click', () => loadLibrary(true).catch((err) => toast(err.message)));
els.libraryFilter.addEventListener('change', () => {
  state.libraryFilter = els.libraryFilter.value;
  renderLibrary();
});
els.librarySort.addEventListener('change', () => {
  state.librarySort = els.librarySort.value;
  renderLibrary();
});
els.jobsBtn.addEventListener('click', () => loadJobs().catch((err) => toast(err.message)));
els.clearJobsBtn.addEventListener('click', () => clearJobs().catch((err) => toast(err.message)));

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

els.commandForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const command = els.commandInput.value.trim();
  if (!command) return;
  try {
    await api('/api/command', { method: 'POST', body: JSON.stringify({ command }) });
    els.commandInput.value = '';
    toast('Command started');
    setTimeout(() => loadJobs().catch(() => {}), 1200);
  } catch (err) {
    toast(err.message);
  }
});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').then((registration) => registration.update()).catch(() => {});
}

(async function init() {
  try {
    await Promise.all([loadStatus(), loadSettings()]);
    await loadLibrary(false);
    await loadJobs();
  } catch (err) {
    toast(err.message);
  }
}());
