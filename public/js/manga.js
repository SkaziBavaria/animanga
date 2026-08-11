import { api, reportBackgroundError, toast, runAction } from './api.js';
import { els } from './dom.js';
import {
  latestMangaPositionFor,
  mangaPositionFor,
  removeMangaProgress,
  saveMangaProgress,
} from './progress.js';
import { state } from './state.js';
import { writeUiPrefs } from './ui-prefs.js';
import { escapeHtml, hasExactTitleMatch, matchesLibraryQuery, presentMangaCard, stripDescription } from './util.js';

function compareChapters(a, b) {
  return Number(a) - Number(b) || String(a).localeCompare(String(b));
}

function coverUrl(url) {
  if (!url) return '';
  // Server returns signed /api/proxy URLs for remote covers.
  if (url.startsWith('/')) return url;
  return url;
}

function initials(manga) {
  return String(manga.name || '?').split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase();
}

function nextChapter(manga) {
  const chapters = [...(manga.chapters || [])].map(String).sort(compareChapters);
  if (!chapters.length) return '';
  const read = new Set((manga.readChapters || []).map(String));
  const unread = chapters.filter((chapter) => !read.has(chapter));
  if (!unread.length) return '';
  const lastValue = String(manga.lastRead || '').trim();
  const last = lastValue === '' ? NaN : Number(lastValue);
  if (Number.isFinite(last)) return unread.find((chapter) => Number(chapter) > last) || unread[0];
  return unread[0];
}

function progressText(manga) {
  const readChapters = [...(manga.readChapters || [])].map(String).sort(compareChapters);
  const chapters = [...(manga.chapters || [])].map(String).sort(compareChapters);
  const lastRead = manga.lastRead || readChapters.at(-1) || '';
  const latest = manga.latestChapter || chapters.at(-1) || manga.chapterCount || '?';
  return `Progress ${lastRead || 0} / ${latest}`;
}

function mangaLifecycle(manga) {
  const start = Number(manga.airedStart?.year || manga.airedStart || 0);
  const end = Number(manga.airedEnd?.year || manga.airedEnd || 0);
  const status = String(manga.status || '').trim().toLowerCase();
  if (status.includes('releas') || status.includes('ongoing') || status.includes('publish')) {
    return start ? `Ongoing since ${start}` : 'Ongoing';
  }
  if (status.includes('finish') || status.includes('complete')) {
    const years = start ? `${start}${end && end !== start ? `–${end}` : ''} · ` : '';
    return `${years}Finished`;
  }
  if (status.includes('hiatus')) return start ? `Hiatus · since ${start}` : 'Hiatus';
  if (status.includes('cancel') || status.includes('discontinu')) return 'Cancelled';
  return '';
}

function mangaDate(value) {
  if (!value) return null;
  let date;
  if (typeof value === 'object') {
    if (!Number(value.year)) return null;
    // Upstream months are 0-indexed (January = 0).
    const month = Number.isFinite(Number(value.month)) ? Number(value.month) : 0;
    date = new Date(Date.UTC(
      Number(value.year),
      month,
      Number(value.date) || 1,
      Number.isFinite(Number(value.hour)) ? Number(value.hour) : 0,
      Number.isFinite(Number(value.minute)) ? Number(value.minute) : 0,
      Number.isFinite(Number(value.second)) ? Number(value.second) : 0,
    ));
  } else date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function mangaDateLabel(value) {
  const date = mangaDate(value);
  return date ? new Intl.DateTimeFormat('en', { year: 'numeric', month: 'short', day: 'numeric' }).format(date) : '';
}

function mangaRelativeDate(value) {
  const date = mangaDate(value);
  if (!date) return '';
  const days = Math.max(0, Math.floor((Date.now() - date.getTime()) / 86_400_000));
  const formatter = new Intl.RelativeTimeFormat('en', { numeric: 'always' });
  if (days < 30) return formatter.format(-days, 'day');
  const months = Math.floor(days / 30);
  if (months < 12) return formatter.format(-months, 'month');
  return formatter.format(-Math.floor(days / 365), 'year');
}

function mangaRecentlyUpdated(value) {
  const date = mangaDate(value);
  if (!date) return false;
  const age = Date.now() - date.getTime();
  return age >= 0 && age <= 30 * 86_400_000;
}

function mangaOriginLabel(value) {
  const origin = String(value || '').trim().toUpperCase();
  if (['JP', 'JPN', 'JAPAN'].includes(origin)) return 'JP';
  if (['KR', 'KOR', 'KOREA', 'SOUTH KOREA'].includes(origin)) return 'KR';
  if (['CN', 'CHN', 'CHINA'].includes(origin)) return 'CN';
  if (['EN', 'ENG', 'US', 'USA', 'UK', 'GB'].includes(origin)) return 'EN';
  return '';
}

function relationLabel(value) {
  const relation = String(value || '').toLowerCase().replace(/[:_-]+/g, ' ').trim();
  if (relation === 'sequel') return 'Sequel';
  if (relation === 'prequel' || relation === 'preserialization') return 'Prequel';
  if (relation === 'side story') return 'Side story';
  if (relation === 'spin off') return 'Spin-off';
  return relation ? relation.replace(/^./, (char) => char.toUpperCase()) : 'Related';
}

function isMangaArchived(manga) {
  return Boolean(manga?.archived);
}

function mangaHasStarted(manga) {
  return (manga?.readChapters || []).length > 0;
}

function filterMangaLibrary(mangas) {
  return mangas.filter((manga) => {
    if (state.mangaLibraryFilter === 'archived') return isMangaArchived(manga);
    if (state.mangaLibraryFilter === 'all') return true;
    if (isMangaArchived(manga)) return false;
    if (state.mangaLibraryFilter === 'continue') return mangaHasStarted(manga) && Number(manga.newCount) > 0;
    if (state.mangaLibraryFilter === 'caughtup') return mangaHasStarted(manga) && Number(manga.newCount) <= 0;
    if (state.mangaLibraryFilter === 'notstarted') return !mangaHasStarted(manga);
    return true;
  }).filter((manga) => matchesLibraryQuery(manga, state.mangaLibraryQuery));
}

function mangaSequelAlerts(mangas) {
  const tracked = new Set(mangas.filter((manga) => manga.tracked !== false).map((manga) => String(manga.id)));
  const seen = new Set();
  return mangas.flatMap((source) => {
    const dismissed = new Set((source.dismissedSequelIds || []).map(String));
    return (source.relations || []).flatMap((sequel) => {
      const id = String(sequel?.id || '');
      const relation = String(sequel?.relation || '').toLowerCase();
      if (!relation.includes('sequel') || !id || tracked.has(id) || dismissed.has(id) || seen.has(id)) return [];
      seen.add(id);
      return [{ source, sequel }];
    });
  });
}

function mangaSequelCard(alert) {
  const manga = alert.sequel;
  const cover = coverUrl(manga.thumbnail);
  return `
    <article class="show-card manga-card manga-sequel-alert" data-manga-id="${escapeHtml(manga.id)}" data-source="sequel">
      ${cover ? `<img class="show-thumb" src="${escapeHtml(cover)}" alt="" loading="lazy" decoding="async">` : `<div class="show-thumb placeholder">${escapeHtml(initials(manga))}</div>`}
      <div class="show-main">
        <div class="show-title">${escapeHtml(manga.name || manga.title)}</div>
        <div class="show-meta">
          <span class="pill sequel released">Sequel found</span>
          <span class="pill">After ${escapeHtml(alert.source.name || alert.source.title)}</span>
          ${manga.status ? `<span class="pill schedule">${escapeHtml(manga.status)}</span>` : ''}
        </div>
      </div>
      <div class="card-actions three">
        <button class="primary" data-action="manga-track-sequel">Track sequel</button>
        <button class="secondary" data-action="manga-about">About</button>
        <button class="secondary" data-action="manga-dismiss-sequel" data-source-id="${escapeHtml(alert.source.id)}">Dismiss</button>
      </div>
    </article>`;
}

function mangaCard(manga, source) {
  const tracked = state.mangaLibrary.some((item) => item.id === manga.id && item.tracked !== false);
  const resume = source === 'library' ? latestMangaPositionFor(manga) : null;
  const chapter = resume?.chapter || nextChapter(manga);
  const cover = coverUrl(manga.thumbnail);
  const started = mangaHasStarted(manga);
  const canContinue = started && Number(manga.newCount) > 0;
  const lifecycle = mangaLifecycle(manga);
  const latestDate = mangaRelativeDate(manga.lastChapterDate);
  const recentlyUpdated = mangaRecentlyUpdated(manga.lastChapterDate);
  const origin = mangaOriginLabel(manga.countryOfOrigin);
  const hasSequel = (manga.relations || []).some((item) => String(item.relation).toLowerCase().includes('sequel'));
  const readLabel = resume
    ? `Resume ch ${chapter} · page ${resume.page}`
    : `${canContinue ? 'Continue' : 'Read'} ch ${chapter}`;
  const primary = source === 'library'
    ? chapter
      ? `<button class="primary play-action ${resume ? 'play-action-resume' : canContinue ? 'play-action-continue' : 'play-action-play'} manga-read-action" data-action="manga-read" data-chapter="${escapeHtml(chapter)}">${escapeHtml(readLabel)}</button>`
      : '<button class="primary play-action play-action-play manga-read-action" data-action="manga-read" data-chapter="auto">Read</button>'
    : chapter
      ? `<button class="primary play-action play-action-play manga-read-action" data-action="manga-read" data-chapter="${escapeHtml(chapter)}">Read ch ${escapeHtml(chapter)}</button>`
      : '<button class="primary play-action play-action-play manga-read-action" data-action="manga-read" data-chapter="auto">Read</button>';
  const trackAction = source === 'library'
    ? ''
    : tracked
      ? '<button class="tracked" data-action="manga-tracked" disabled>Tracked</button>'
      : '<button class="secondary" data-action="manga-track">Track</button>';
  const libraryActions = source === 'library'
    ? `${manga.archived
      ? '<button class="secondary" data-action="manga-unarchive">Unarchive</button>'
      : '<button class="secondary" data-action="manga-archive">Archive</button>'
    }<button class="danger" data-action="manga-remove">Remove</button>`
    : trackAction;
  return `
    <article class="show-card manga-card${manga.archived ? ' archived' : ''}" data-manga-id="${escapeHtml(manga.id)}" data-source="${source}">
      ${cover ? `<img class="show-thumb" src="${escapeHtml(cover)}" alt="" loading="lazy" decoding="async">` : `<div class="show-thumb placeholder">${escapeHtml(initials(manga))}</div>`}
      <div class="show-main">
        <div class="show-title">${escapeHtml(manga.name || manga.title)}</div>
        <div class="show-meta">
          <span class="pill${source === 'library' && canContinue ? ' hot' : ''}">${escapeHtml(source === 'library' ? progressText(manga) : `${manga.chapterCount || manga.latestChapter || '?'} chapters`)}</span>
          ${origin ? `<span class="pill">${escapeHtml(origin)}</span>` : ''}
          ${manga.archived ? '<span class="pill">Archived</span>' : ''}
          ${manga.downloadedChapters ? `<span class="pill downloaded">↓ ${escapeHtml(manga.downloadedChapters)} saved</span>` : ''}
          ${lifecycle ? `<span class="pill schedule">${escapeHtml(lifecycle)}</span>` : ''}
          ${manga.latestChapter && latestDate ? `<span class="pill schedule${recentlyUpdated ? ' hot' : ''}">Ch ${escapeHtml(manga.latestChapter)} · ${escapeHtml(latestDate)}</span>` : ''}
          ${source !== 'library' && manga.score ? `<span class="pill">Score ${escapeHtml(manga.score)}</span>` : ''}
          ${manga.recommendationReason ? `<span class="pill reason">${escapeHtml(manga.recommendationReason)}</span>` : ''}
          ${hasSequel ? '<span class="pill sequel released">Sequel available</span>' : ''}
          ${manga.refreshError ? '<span class="pill danger">Refresh failed</span>' : ''}
        </div>
      </div>
      <div class="card-actions four">
        ${primary}
        <button class="secondary" data-action="manga-chapters">Chapters</button>
        <button class="secondary" data-action="manga-about">About</button>
        ${libraryActions}
      </div>
    </article>`;
}

function mangaProgressRatio(manga) {
  const latest = Number(manga.latestChapter || manga.chapterCount);
  const last = Number(manga.lastRead);
  if (!Number.isFinite(last) || !Number.isFinite(latest) || latest <= 0) return 0;
  return Math.min(1, last / latest);
}

function sortMangaLibrary(sort) {
  return (a, b) => {
    if (sort === 'az') return String(a.name || a.title).localeCompare(String(b.name || b.title));
    if (sort === 'recent') return String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
    if (sort === 'progress') {
      const diff = mangaProgressRatio(b) - mangaProgressRatio(a);
      return diff || String(a.name || a.title).localeCompare(String(b.name || b.title));
    }
    return (Number(b.newCount) - Number(a.newCount)) || String(a.name || a.title).localeCompare(String(b.name || b.title));
  };
}

export function renderMangaLibrary() {
  state.mangaSequelAlerts = mangaSequelAlerts(state.mangaLibrary);
  const sequelOption = els.mangaLibraryFilter.querySelector('option[value="sequels"]');
  if (sequelOption) sequelOption.textContent = `Sequels found (${state.mangaSequelAlerts.length})`;
  const activeCount = state.mangaLibrary.filter((manga) => !isMangaArchived(manga)).length;
  els.mangaCount.textContent = state.mangaLibraryFilter === 'sequels'
    ? String(state.mangaSequelAlerts.length)
    : state.mangaLibraryFilter === 'archived'
    ? String(state.mangaLibrary.filter(isMangaArchived).length)
    : state.mangaLibraryFilter === 'all'
      ? String(state.mangaLibrary.length)
      : String(activeCount);
  if (!state.mangaLibrary.length) {
    els.mangaLibraryList.innerHTML = '<div class="empty empty-action"><span>Your manga library is empty.</span><button class="small-button secondary" data-action="manga-open-discover" type="button">Find manga</button></div>';
    return;
  }
  if (state.mangaLibraryFilter === 'sequels') {
    const alerts = state.mangaSequelAlerts.filter(({ source, sequel }) => matchesLibraryQuery({
      ...sequel,
      title: `${sequel.title || sequel.name || ''} ${source.title || source.name || ''}`,
    }, state.mangaLibraryQuery));
    els.mangaLibraryList.innerHTML = alerts.length
      ? alerts.map(mangaSequelCard).join('')
      : `<div class="empty">${String(state.mangaLibraryQuery || '').trim() ? 'No manga sequels match this search.' : 'No new manga sequels found.'}</div>`;
    return;
  }
  const mangas = filterMangaLibrary(state.mangaLibrary).sort(sortMangaLibrary(state.mangaLibrarySort || 'new'));
  const emptyLabel = String(state.mangaLibraryQuery || '').trim()
    ? 'No manga match this search.'
    : 'No manga match this filter.';
  els.mangaLibraryList.innerHTML = mangas.length
    ? mangas.map((manga) => mangaCard(manga, 'library')).join('')
    : `<div class="empty">${emptyLabel}</div>`;
}

function findManga(card) {
  const id = card?.dataset.mangaId;
  if (!id) return null;
  if (card.dataset.source === 'sequel') {
    return state.mangaSequelAlerts.find((alert) => alert.sequel.id === id)?.sequel || null;
  }
  const primary = card.dataset.source === 'library' ? state.mangaLibrary : state.mangaResults;
  const secondary = card.dataset.source === 'library' ? state.mangaResults : state.mangaLibrary;
  return primary.find((item) => item.id === id) || secondary.find((item) => item.id === id) || null;
}

export function renderMangaResults(emptyHtml = '<div class="empty">No manga found.</div>', leadingHtml = '') {
  els.mangaSearchResults.innerHTML = leadingHtml + (state.mangaResults.length
    ? state.mangaResults.map((manga) => mangaCard(manga, 'search')).join('')
    : emptyHtml);
}

export function refreshMangaCards(emptyHtml) {
  renderMangaLibrary();
  if (state.mangaResults.length || emptyHtml) renderMangaResults(emptyHtml);
}

/** Patch every in-memory copy of a manga and recompute card fields. */
export function syncManga(partial) {
  if (!partial?.id) return null;
  const presented = presentMangaCard(partial);
  for (const manga of state.mangaLibrary) {
    if (manga.id === presented.id) Object.assign(manga, presented);
  }
  for (const manga of state.mangaResults) {
    if (manga.id === presented.id) Object.assign(manga, presented);
  }
  if (state.activeManga?.id === presented.id) Object.assign(state.activeManga, presented);
  return presented;
}

export async function loadMangaLibrary(refresh = false) {
  if (state.mediaMode === 'manga') els.refreshBtn.disabled = true;
  try {
    const data = await api(`/api/manga/library${refresh ? '?refresh=1' : ''}`);
    state.mangaLibrary = data.mangas || [];
    refreshMangaCards();
    if (refresh) toast('Manga library updated');
  } finally {
    if (state.mediaMode === 'manga') els.refreshBtn.disabled = false;
  }
}

export async function searchManga(query = '', options = {}) {
  state.mangaDiscoverLoaded = true;
  const params = new URLSearchParams({
    q: query,
    sort: options.sort || state.mangaBrowseSort,
  });
  if (state.mangaYear) params.set('year', String(state.mangaYear));
  state.mangaGenres.forEach((genre) => params.append('genre', genre));
  const data = await api(`/api/manga/search?${params}`);
  state.mangaResults = data.results || [];
  state.lastMangaSearchQuery = query;
  const emptyHtml = query
    ? `<div class="empty empty-action"><span>No manga found.</span><button class="small-button secondary" data-action="manga-watch-release" data-query="${escapeHtml(query)}" type="button">Watch release</button></div>`
    : '<div class="empty">No manga found.</div>';
  const leadingHtml = state.mangaResults.length && query && !hasExactTitleMatch(state.mangaResults, query)
    ? `<div class="empty empty-action"><span>No exact match for “${escapeHtml(query)}”.</span><button class="small-button secondary" data-action="manga-watch-release" data-query="${escapeHtml(query)}" type="button">Watch this title</button></div>`
    : '';
  renderMangaResults(emptyHtml, leadingHtml);
}

async function browseManga(button) {
  state.mangaDiscoverLoaded = true;
  state.mangaGenres = [];
  state.mangaYear = null;
  els.mangaGenreFilter?.querySelectorAll('input[type="checkbox"]').forEach((input) => { input.checked = false; });
  if (els.mangaYearFilter) els.mangaYearFilter.value = '';
  updateMangaFilterSummary();
  let endpoint = '/api/manga/search?q=&sort=Latest_Update';
  if (button.dataset.mangaRecommended) endpoint = '/api/manga/recommendations';
  if (button.dataset.mangaPopularRange !== undefined) endpoint = `/api/manga/popular?range=${encodeURIComponent(button.dataset.mangaPopularRange)}`;
  const data = await api(endpoint);
  state.mangaResults = data.results || [];
  renderMangaResults();
}

export function loadDefaultMangaDiscover() {
  if (state.mangaDiscoverLoaded) return;
  const popularButton = els.mangaPopularBtn || document.querySelector('.manga-browse-button[data-manga-popular-range="0"]');
  if (!popularButton) return;
  document.querySelectorAll('.manga-browse-button').forEach((button) => button.classList.toggle('active', button === popularButton));
  els.mangaSearchResults.innerHTML = '<div class="empty">Loading Popular...</div>';
  browseManga(popularButton).catch((err) => toast(err.message));
}

function updateMangaFilterSummary() {
  const values = [...state.mangaGenres, state.mangaYear].filter(Boolean);
  els.mangaGenreFilterSummary.textContent = values.length ? `Filters · ${values.join(', ')}` : 'Filters · All';
}

export async function trackManga(manga) {
  await api('/api/manga/track', { method: 'POST', body: JSON.stringify(manga) });
  await loadMangaLibrary();
  toast('Manga tracked');
}

async function removeManga(manga) {
  const name = manga.name || manga.title || 'this manga';
  if (!confirm(`Remove "${name}" from your library?\n\nYou can add it again from Search > Track.`)) return;
  await api(`/api/manga/${encodeURIComponent(manga.id)}`, { method: 'DELETE' });
  await loadMangaLibrary();
  toast('Removed from library');
}

function isMangaTracked(manga) {
  return Boolean(manga?.id) && state.mangaLibrary.some((item) => item.id === manga.id && item.tracked !== false);
}

function renderMangaDialogActions(manga) {
  if (!els.mangaDialogActions) return;
  if (!manga?.id) {
    els.mangaDialogActions.hidden = true;
    els.mangaDialogActions.innerHTML = '';
    return;
  }
  const tracked = isMangaTracked(manga);
  els.mangaDialogActions.hidden = false;
  els.mangaDialogActions.innerHTML = tracked
    ? '<button class="danger" data-action="manga-details-untrack" type="button">Remove from library</button>'
    : '<button class="primary" data-action="manga-details-track" type="button">Add to library</button>';
}

function clearMangaDialogActions() {
  if (!els.mangaDialogActions) return;
  els.mangaDialogActions.hidden = true;
  els.mangaDialogActions.innerHTML = '';
}

async function setMangaArchived(manga, archived) {
  const data = await api(`/api/manga/${encodeURIComponent(manga.id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ archived: Boolean(archived) }),
  });
  syncManga({ ...manga, ...(data.manga || {}), id: manga.id, archived: Boolean(archived) });
  refreshMangaCards();
  toast(archived ? 'Archived' : 'Moved back to active library');
}

async function dismissMangaSequel(sourceId, sequelId) {
  const source = state.mangaLibrary.find((manga) => manga.id === sourceId);
  const dismissedSequelIds = Array.from(new Set([...(source?.dismissedSequelIds || []), sequelId]));
  const data = await api(`/api/manga/${encodeURIComponent(sourceId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ dismissedSequelIds }),
  });
  if (source) Object.assign(source, data.manga || {}, { dismissedSequelIds });
  renderMangaLibrary();
  toast('Manga sequel dismissed');
}

function chapterRow(manga, chapter) {
  const chapterText = String(chapter);
  const read = (manga.readChapters || []).map(String).includes(chapterText);
  const position = read ? null : mangaPositionFor(manga.id, chapterText);
  const downloaded = Boolean(state.mangaDownloads[chapterText]);
  const upNext = !read && !position && chapterText === String(nextChapter(manga));
  const released = mangaDateLabel(manga.chapterDates?.[chapterText]);
  const classes = ['episode', 'episode-play', 'chapter-open'];
  if (read) classes.push('watched');
  if (upNext) classes.push('next');
  const pageProgress = position
    ? Math.min(95, Math.max(1, Math.round((position.page / (position.pageCount || position.page)) * 100)))
    : 0;
  const pageLabel = position
    ? `Resume page ${position.page}${position.pageCount ? ` of ${position.pageCount}` : ''}`
    : '';
  const stateLabels = [read ? 'Read' : pageLabel || (upNext ? 'Up next' : 'Open in reader')];
  if (downloaded) stateLabels.push('Downloaded');
  return `
    <article class="episode-row-wrap chapter-row${read ? ' watched' : ''}${downloaded ? ' has-download downloaded' : ''}" data-chapter="${escapeHtml(chapterText)}">
      <div class="episode-row">
        <div class="episode-number" aria-hidden="true">${escapeHtml(chapterText)}</div>
        <button class="${classes.join(' ')}" data-action="chapter-open" data-chapter="${escapeHtml(chapterText)}" type="button">
          <span class="episode-name">Chapter ${escapeHtml(chapterText)}</span>
          <small class="episode-state">${escapeHtml(stateLabels.join(' · '))}</small>
          <small class="episode-state episode-release">${escapeHtml(released ? `Released ${released}` : 'Release date unavailable')}</small>
        </button>
        <div class="episode-actions">
          <button class="episode-action episode-watch${read ? ' active' : ''}" data-action="chapter-toggle" data-chapter="${escapeHtml(chapterText)}" type="button" title="${read ? 'Mark unread' : 'Mark read'}" aria-label="${read ? `Mark chapter ${escapeHtml(chapterText)} unread` : `Mark chapter ${escapeHtml(chapterText)} read`}" aria-pressed="${read}">
            <span class="watch-icon" aria-hidden="true">${read ? '✓' : '👁'}</span>
          </button>
          <button class="episode-action episode-download${downloaded ? ' downloaded' : ''}" data-action="chapter-download" data-chapter="${escapeHtml(chapterText)}" type="button" title="${downloaded ? 'Remove offline chapter' : 'Download for offline reading'}" aria-label="${downloaded ? `Remove downloaded chapter ${escapeHtml(chapterText)}` : `Download chapter ${escapeHtml(chapterText)}`}">
            <span class="download-icon" aria-hidden="true">${downloaded ? '✓' : '↓'}</span>
          </button>
        </div>
      </div>
      <div class="episode-view-progress${read ? ' complete' : ''}" role="progressbar" aria-label="Chapter ${escapeHtml(chapterText)} read progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${read ? '100' : pageProgress}" aria-valuetext="${escapeHtml(read ? 'Read' : pageLabel || 'Unread')}">
        <span style="width:${read ? '100' : pageProgress}%"></span>
      </div>
    </article>`;
}

function renderChapterGrid(manga) {
  els.chapterGrid.innerHTML = [...(manga.chapters || [])]
    .sort((a, b) => compareChapters(b, a))
    .map((chapter) => chapterRow(manga, chapter))
    .join('');
}

function chapterTarget() {
  return String(els.mangaChapterTarget.value || '').trim();
}

function jumpToChapter() {
  const target = chapterTarget();
  const row = [...els.chapterGrid.querySelectorAll('.chapter-row')]
    .find((item) => item.dataset.chapter === target);
  if (!row) return toast(`Chapter ${target || '?'} is not in this list`);
  row.scrollIntoView({ behavior: 'smooth', block: 'center' });
  row.classList.add('chapter-jump-highlight');
  setTimeout(() => row.classList.remove('chapter-jump-highlight'), 1800);
}

async function loadMangaDownloads(manga) {
  const data = await api(`/api/manga/${encodeURIComponent(manga.id)}/downloads`);
  state.mangaDownloads = Object.fromEntries((data.downloads || []).map((item) => [String(item.chapter), item]));
}

let mangaDownloadPollTimer;

function downloadableChapters(manga = state.activeManga) {
  return [...(manga?.chapters || [])]
    .map(String)
    .filter((chapter) => Number.isFinite(Number(chapter)))
    .sort(compareChapters);
}

function setQuickDownloadRange(count) {
  const chapters = downloadableChapters().filter((chapter) => !state.mangaDownloads[chapter]);
  if (!chapters.length) return toast('Every chapter is already downloaded');
  const requestedStart = Number(nextChapter(state.activeManga));
  const startIndex = chapters.findIndex((chapter) => Number(chapter) >= requestedStart);
  if (startIndex < 0) return toast('No chapters available from that point');
  const selected = chapters.slice(startIndex, startIndex + count);
  if (!selected.length) return toast('No chapters available from that point');
  els.mangaDownloadFrom.value = selected[0];
  els.mangaDownloadTo.value = selected.at(-1);
  els.mangaDownloadCustomRange.hidden = true;
  els.mangaDownloadCustomBtn.setAttribute('aria-expanded', 'false');
  document.querySelectorAll('.manga-download-quick').forEach((button) => {
    button.setAttribute('aria-pressed', String(Number(button.dataset.count) === count));
  });
  updateMangaDownloadSelection();
}

function selectedDownloadChapters() {
  const from = Number(els.mangaDownloadFrom.value);
  const to = Number(els.mangaDownloadTo.value);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) return [];
  return downloadableChapters()
    .filter((chapter) => Number(chapter) >= from && Number(chapter) <= to)
    .filter((chapter) => !state.mangaDownloads[chapter]);
}

function updateMangaDownloadSelection() {
  const count = selectedDownloadChapters().length;
  els.mangaDownloadRangeBtn.textContent = count
    ? `Download ${count} chapter${count === 1 ? '' : 's'}`
    : 'Choose chapters';
  els.mangaDownloadRangeBtn.disabled = !count || mangaDownloadJobActive(state.mangaDownloadJob);
}

function setMangaDownloadPanelOpen(open) {
  els.mangaDownloadPanel.hidden = !open;
  els.mangaDownloadToggleBtn.setAttribute('aria-expanded', String(open));
}

function mangaDownloadJobActive(job) {
  return ['queued', 'running', 'cancelling'].includes(job?.status);
}

function renderMangaDownloadJob(job) {
  const active = mangaDownloadJobActive(job);
  els.mangaDownloadToggleBtn.disabled = active;
  els.mangaCancelDownloadBtn.hidden = !active;
  updateMangaDownloadSelection();
  if (!job) {
    els.mangaDownloadStatus.textContent = '';
    return;
  }
  const processed = Number(job.completed || 0) + Number(job.failed || 0) + Number(job.cancelled || 0);
  if (active) {
    setMangaDownloadPanelOpen(false);
    const label = job.status === 'queued' ? 'Queued' : `Downloading ${processed} of ${job.total}`;
    els.mangaDownloadStatus.innerHTML = `<span>${label}</span><progress max="${Number(job.total) || 1}" value="${processed}"></progress>`;
    return;
  }
  els.mangaDownloadStatus.textContent = job.failed ? `${job.failed} chapter${job.failed === 1 ? '' : 's'} failed` : '';
}

async function refreshMangaDownloadsAfterBatch(manga) {
  await loadMangaDownloads(manga);
  const count = Object.keys(state.mangaDownloads).length;
  for (const entry of [...state.mangaLibrary, ...state.mangaResults]) {
    if (entry.id === manga.id) entry.downloadedChapters = count;
  }
  if (state.activeManga?.id === manga.id) {
    state.activeManga.downloadedChapters = count;
    renderChapterGrid(state.activeManga);
  }
  refreshMangaCards();
  updateReaderControls();
}

function scheduleMangaDownloadPoll(manga, delay = 800) {
  clearTimeout(mangaDownloadPollTimer);
  if (!mangaDownloadJobActive(state.mangaDownloadJob)) return;
  mangaDownloadPollTimer = setTimeout(async () => {
    try {
      const wasActive = mangaDownloadJobActive(state.mangaDownloadJob);
      const data = await api(`/api/manga/${encodeURIComponent(manga.id)}/download-jobs`);
      state.mangaDownloadJob = (data.jobs || []).find(mangaDownloadJobActive) || data.jobs?.[0] || null;
      renderMangaDownloadJob(state.mangaDownloadJob);
      if (mangaDownloadJobActive(state.mangaDownloadJob)) scheduleMangaDownloadPoll(manga);
      else if (wasActive) {
        const completed = Number(state.mangaDownloadJob?.completed || 0);
        if (completed) toast(`${completed} chapter${completed === 1 ? '' : 's'} downloaded`);
        await refreshMangaDownloadsAfterBatch(manga);
      }
    } catch (error) {
      reportBackgroundError('Manga download polling failed', error);
      if (mangaDownloadJobActive(state.mangaDownloadJob)) scheduleMangaDownloadPoll(manga, 2500);
    }
  }, delay);
}

async function loadMangaDownloadJobs(manga) {
  clearTimeout(mangaDownloadPollTimer);
  const data = await api(`/api/manga/${encodeURIComponent(manga.id)}/download-jobs`);
  state.mangaDownloadJob = (data.jobs || []).find(mangaDownloadJobActive) || data.jobs?.[0] || null;
  renderMangaDownloadJob(state.mangaDownloadJob);
  scheduleMangaDownloadPoll(manga);
}

async function startMangaDownloadRange() {
  const manga = state.activeManga;
  const chapters = selectedDownloadChapters();
  if (!chapters.length) return toast('Choose a valid range with chapters not already downloaded');
  if (chapters.length > 50) return toast('Select at most 50 chapters per batch');
  if (!confirm(`Download ${chapters.length} chapter${chapters.length === 1 ? '' : 's'} for offline reading?`)) return;
  const data = await api(`/api/manga/${encodeURIComponent(manga.id)}/chapters/download-batch`, {
    method: 'POST',
    body: JSON.stringify({ chapters }),
  });
  state.mangaDownloadJob = data.job;
  renderMangaDownloadJob(data.job);
  scheduleMangaDownloadPoll(manga);
}

async function cancelMangaDownloadRange() {
  const manga = state.activeManga;
  const job = state.mangaDownloadJob;
  if (!manga || !mangaDownloadJobActive(job)) return;
  const data = await api(`/api/manga/${encodeURIComponent(manga.id)}/download-jobs/${encodeURIComponent(job.id)}`, {
    method: 'DELETE',
  });
  state.mangaDownloadJob = data.job;
  renderMangaDownloadJob(data.job);
  scheduleMangaDownloadPoll(manga);
}

async function openMangaChapters(manga, requestedChapter = '') {
  // Continue/read with a known chapter: open pages first so we don't burn the
  // upstream rate budget on a redundant details+relations fetch.
  if (requestedChapter && Array.isArray(manga.chapters) && manga.chapters.length) {
    state.activeManga = presentMangaCard(manga);
    await openMangaReader(manga, requestedChapter);
    return;
  }

  const [data] = await Promise.all([
    api(`/api/manga/${encodeURIComponent(manga.id)}/chapters`),
    loadMangaDownloads(manga),
  ]);
  const details = { ...data.manga, chapters: data.chapters };
  syncManga(details);
  state.activeManga = presentMangaCard({ ...(state.activeManga || manga), ...details });
  refreshMangaCards();
  els.mangaDialogTitle.textContent = details.name;
  els.mangaDialogMeta.textContent = `${data.chapters.length} chapters / ${details.status || 'Status unknown'}`;
  clearMangaDialogActions();
  els.mangaDialogBody.innerHTML = '';
  els.mangaChapterTools.hidden = false;
  els.mangaDownloadTools.hidden = false;
  els.mangaChapterTarget.value = '';
  els.mangaDownloadFrom.value = nextChapter(details);
  setMangaDownloadPanelOpen(false);
  els.mangaDownloadCustomRange.hidden = true;
  els.mangaDownloadCustomBtn.setAttribute('aria-expanded', 'false');
  setQuickDownloadRange(10);
  renderChapterGrid(details);
  els.mangaDialog.showModal();
  await loadMangaDownloadJobs(details);
  const resolvedChapter = requestedChapter === 'auto' ? nextChapter(details) : requestedChapter;
  if (resolvedChapter) {
    els.mangaDialog.close();
    await openMangaReader(details, resolvedChapter);
  }
}

async function openMangaAbout(manga) {
  const data = await api(`/api/manga/${encodeURIComponent(manga.id)}/details`);
  const details = data.manga;
  state.activeManga = details;
  state.mangaRelations = details.relations || [];
  syncManga(details);
  refreshMangaCards();
  els.mangaDialogTitle.textContent = details.name;
  els.mangaDialogMeta.textContent = [details.type, details.status, details.score ? `Score ${details.score}` : '', details.authors?.join(', ')].filter(Boolean).join(' · ');
  const thumb = coverUrl(details.thumbnail || details.thumbnails?.[0]);
  const description = stripDescription(details.description) || 'No synopsis available.';
  els.mangaChapterTools.hidden = true;
  els.mangaDownloadTools.hidden = true;
  renderMangaDialogActions(details);
  els.mangaDialogBody.innerHTML = `
    <div class="manga-details-layout">
      ${thumb ? `<img class="details-cover" src="${escapeHtml(thumb)}" alt="" loading="lazy" decoding="async">` : '<div class="details-cover placeholder" aria-hidden="true">?</div>'}
      <p>${escapeHtml(description)}</p>
      <div class="details-pills">${(details.genres || []).map((genre) => `<span class="pill">${escapeHtml(genre)}</span>`).join('')}</div>
    </div>
    ${mangaRelatedSection(details.relations || [])}`;
  els.chapterGrid.innerHTML = '';
  els.mangaDialog.showModal();
}

function mangaRelatedSection(relations) {
  if (!relations.length) return '';
  return `
    <section class="related-section" aria-label="Related manga">
      <h3>Related manga</h3>
      <div class="related-list">
        ${relations.map((item) => {
          const tracked = state.mangaLibrary.some((manga) => manga.id === item.id && manga.tracked !== false);
          const thumb = coverUrl(item.thumbnail);
          return `<article class="related-item" data-related-manga-id="${escapeHtml(item.id)}">
            ${thumb ? `<img class="related-thumb" src="${escapeHtml(thumb)}" alt="" loading="lazy" decoding="async">` : '<div class="related-thumb placeholder" aria-hidden="true">?</div>'}
            <div class="related-main">
              <span class="pill hot">${escapeHtml(relationLabel(item.relation))}</span>
              <strong>${escapeHtml(item.name || 'Related manga')}</strong>
              <span>${escapeHtml([item.status, item.chapterCount ? `${item.chapterCount} chapters` : ''].filter(Boolean).join(' · '))}</span>
            </div>
            <div class="related-actions">
              <button class="secondary small-button" data-action="manga-related-about" type="button">About</button>
              ${tracked ? '<button class="tracked small-button" type="button" disabled>Tracked</button>' : '<button class="secondary small-button" data-action="manga-related-track" type="button">Track</button>'}
            </div>
          </article>`;
        }).join('')}
      </div>
    </section>`;
}

let readerPageCount = 0;
let readerProgressTimer;
let readerChapterComplete = false;
let readerRestoring = false;

function currentReaderPage() {
  const pages = [...els.mangaReaderPages.querySelectorAll('.manga-page')];
  if (!pages.length) return 0;
  const root = els.mangaReaderPages.getBoundingClientRect();
  const marker = root.top + Math.min(80, root.height * 0.2);
  const visible = pages.find((page) => page.getBoundingClientRect().bottom > marker) || pages.at(-1);
  return Number(visible.dataset.page) || pages.indexOf(visible) + 1;
}

function readerReachedEnd() {
  const lastPage = els.mangaReaderPages.querySelector('.manga-page:last-child');
  if (!lastPage) return false;
  const root = els.mangaReaderPages.getBoundingClientRect();
  return lastPage.getBoundingClientRect().bottom <= root.bottom + 4;
}

function persistReaderProgress() {
  const manga = state.activeManga;
  const chapter = state.activeChapter;
  if (!manga || !chapter || readerChapterComplete) return;
  if ((manga.readChapters || []).map(String).includes(String(chapter))) return;
  const page = currentReaderPage();
  if (!page) return;
  saveMangaProgress(manga, chapter, page, readerPageCount);
  refreshMangaCards();
  if (els.mangaDialog.open) renderChapterGrid(manga);
}

async function completeReaderChapter() {
  if (readerChapterComplete || !state.activeManga || !state.activeChapter) return;
  readerChapterComplete = true;
  clearTimeout(readerProgressTimer);
  removeMangaProgress(state.activeManga, state.activeChapter);
  state.activeManga = await setChapterRead(state.activeManga, state.activeChapter, true);
}

function restoreReaderProgress(manga, chapter) {
  const position = mangaPositionFor(manga.id, chapter);
  const target = position && els.mangaReaderPages.querySelector(`.manga-page[data-page="${position.page}"]`);
  if (!target) return;
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    readerRestoring = true;
    requestAnimationFrame(() => {
      els.mangaReaderPages.scrollTop = target.offsetTop;
      setTimeout(() => { readerRestoring = false; }, 100);
    });
  };
  const image = target.querySelector('img');
  if (image?.complete) restore();
  else {
    image?.addEventListener('load', restore, { once: true });
    image?.addEventListener('error', restore, { once: true });
    setTimeout(restore, 150);
  }
}

async function openMangaReader(manga, chapter) {
  if (!chapter) return openMangaChapters(manga);
  clearTimeout(readerProgressTimer);
  els.mangaReaderTitle.textContent = manga.name;
  els.mangaReaderMeta.textContent = `Chapter ${chapter}`;
  els.mangaReaderPages.innerHTML = '<div class="empty">Loading pages...</div>';
  state.activeManga = manga;
  state.activeChapter = String(chapter);
  readerChapterComplete = (manga.readChapters || []).map(String).includes(String(chapter));
  readerRestoring = false;
  updateReaderControls();
  if (els.mangaDialog.open) els.mangaDialog.close();
  if (!els.mangaReaderDialog.open) els.mangaReaderDialog.showModal();
  showReaderControls();
  const data = await api(`/api/manga/${encodeURIComponent(manga.id)}/chapters/${encodeURIComponent(chapter)}/pages`);
  readerPageCount = data.pages.length;
  if (data.uploadDate) state.activeManga.chapterDates = { ...(state.activeManga.chapterDates || {}), [String(chapter)]: data.uploadDate };
  els.mangaReaderPages.innerHTML = data.pages.map((page) => {
    const src = page.url;
    return `<figure class="manga-page" data-page="${escapeHtml(page.number)}"><img src="${escapeHtml(src)}" alt="Page ${page.number}" loading="lazy" decoding="async"><figcaption>Page ${page.number}</figcaption></figure>`;
  }).join('');
  if (data.notes) els.mangaReaderMeta.textContent = `Chapter ${chapter} · ${data.notes}`;
  els.mangaReaderPages.scrollTop = 0;
  restoreReaderProgress(manga, chapter);
}

let readerControlsTimer;

function showReaderControls(autoHide = true) {
  clearTimeout(readerControlsTimer);
  els.mangaReaderDialog.classList.remove('controls-hidden');
  if (autoHide) readerControlsTimer = setTimeout(() => els.mangaReaderDialog.classList.add('controls-hidden'), 2200);
}

function toggleReaderControls() {
  if (els.mangaReaderDialog.classList.contains('controls-hidden')) showReaderControls();
  else {
    clearTimeout(readerControlsTimer);
    els.mangaReaderDialog.classList.add('controls-hidden');
  }
}

function fullscreenElement() {
  return document.fullscreenElement || document.webkitFullscreenElement || null;
}

function updateMangaFullscreenButton() {
  const fullscreen = els.mangaReaderDialog.classList.contains('manga-reader-fullscreen');
  const path = fullscreen
    ? 'M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z'
    : 'M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z';
  els.mangaFullscreenBtn.innerHTML = `<svg class="fullscreen-icon ${fullscreen ? 'fullscreen-exit' : 'fullscreen-enter'}" viewBox="0 0 24 24" aria-hidden="true"><path d="${path}"></path></svg>`;
  els.mangaFullscreenBtn.title = fullscreen ? 'Exit fullscreen' : 'Fullscreen';
  els.mangaFullscreenBtn.setAttribute('aria-label', fullscreen ? 'Exit fullscreen' : 'Enter fullscreen');
}

async function requestMangaFullscreen() {
  els.mangaReaderDialog.classList.add('manga-reader-fullscreen');
  document.body.classList.add('manga-reader-fullscreen-active');
  updateMangaFullscreenButton();
  const root = document.documentElement;
  const request = root.requestFullscreen || root.webkitRequestFullscreen;
  if (request) await request.call(root);
}

async function exitMangaFullscreen() {
  els.mangaReaderDialog.classList.remove('manga-reader-fullscreen');
  document.body.classList.remove('manga-reader-fullscreen-active');
  updateMangaFullscreenButton();
  const exit = document.exitFullscreen || document.webkitExitFullscreen;
  if (fullscreenElement() && exit) await exit.call(document);
}

async function toggleMangaFullscreen() {
  if (els.mangaReaderDialog.classList.contains('manga-reader-fullscreen')) await exitMangaFullscreen();
  else await requestMangaFullscreen();
  showReaderControls();
}

async function closeMangaReader() {
  clearTimeout(readerProgressTimer);
  if (readerReachedEnd()) await completeReaderChapter();
  else persistReaderProgress();
  if (els.mangaReaderDialog.classList.contains('manga-reader-fullscreen')) await exitMangaFullscreen();
  els.mangaReaderDialog.close();
}

function readerChapter(delta) {
  const chapters = [...(state.activeManga?.chapters || [])].map(String).sort(compareChapters);
  const index = chapters.indexOf(String(state.activeChapter));
  return index >= 0 ? chapters[index + delta] || '' : '';
}

function updateReaderControls() {
  const downloaded = Boolean(state.mangaDownloads[String(state.activeChapter)]);
  els.mangaDownloadChapterBtn.textContent = downloaded ? '⬇✓' : '↓';
  els.mangaDownloadChapterBtn.title = downloaded ? 'Remove offline chapter' : 'Download chapter';
  els.mangaPrevChapterBtn.disabled = !readerChapter(-1);
  els.mangaNextChapterBtn.disabled = !readerChapter(1);
}

async function changeReaderChapter(delta) {
  const chapter = readerChapter(delta);
  if (!chapter) return;
  clearTimeout(readerProgressTimer);
  if (delta > 0) await completeReaderChapter();
  else persistReaderProgress();
  await openMangaReader(state.activeManga, chapter);
}

async function setChapterRead(manga, chapter, read, { markThrough = false } = {}) {
  const currentlyRead = (manga.readChapters || []).map(String).includes(String(chapter));
  if (currentlyRead === read) {
    if (read) removeMangaProgress(manga, chapter);
    return manga;
  }
  const shouldMarkThrough = read && markThrough && Number.isFinite(Number(chapter));
  const data = await api(shouldMarkThrough ? '/api/manga/read-through' : '/api/manga/read', {
    method: 'POST',
    body: JSON.stringify({
      id: manga.id,
      chapter,
      ...(shouldMarkThrough ? { chapters: manga.chapters || [] } : { read }),
      manga: { name: manga.name, thumbnail: manga.thumbnail },
    }),
  });
  if (read) removeMangaProgress(manga, chapter);
  const presented = syncManga(data.manga || manga);
  state.activeManga = presented || { ...manga, ...data.manga };
  if (els.mangaDialog.open) renderChapterGrid(state.activeManga);
  refreshMangaCards();
  return state.activeManga;
}

function confirmEarlierChapters(message) {
  els.mangaReadConfirmMessage.textContent = message;
  els.mangaReadConfirmDialog.returnValue = 'no';
  return new Promise((resolve) => {
    els.mangaReadConfirmDialog.addEventListener('close', () => {
      resolve(els.mangaReadConfirmDialog.returnValue === 'yes');
    }, { once: true });
    els.mangaReadConfirmDialog.showModal();
  });
}

async function markChapterRead(manga, chapter) {
  const readSet = new Set((manga.readChapters || []).map(String));
  if (readSet.has(String(chapter))) return manga;
  if (!Number.isFinite(Number(chapter))) return setChapterRead(manga, chapter, true);

  const target = Number(chapter);
  const unreadEarlier = (manga.chapters || [])
    .map(String)
    .filter((item) => Number.isFinite(Number(item)) && Number(item) < target && !readSet.has(item));
  if (!unreadEarlier.length) return setChapterRead(manga, chapter, true);

  const noun = unreadEarlier.length === 1 ? 'chapter' : 'chapters';
  const markThrough = await confirmEarlierChapters(
    `${unreadEarlier.length} earlier unread ${noun} found. Mark everything through chapter ${chapter} as read?`,
  );
  return setChapterRead(manga, chapter, true, { markThrough });
}

async function toggleChapter(manga, chapter) {
  const read = !(manga.readChapters || []).map(String).includes(String(chapter));
  return read ? markChapterRead(manga, chapter) : setChapterRead(manga, chapter, false);
}

async function toggleChapterDownload(manga, chapter) {
  const downloaded = Boolean(state.mangaDownloads[String(chapter)]);
  await api(`/api/manga/${encodeURIComponent(manga.id)}/chapters/${encodeURIComponent(chapter)}/download`, {
    method: downloaded ? 'DELETE' : 'POST',
  });
  await loadMangaDownloads(manga);
  updateReaderControls();
  if (els.mangaDialog.open) {
    renderChapterGrid(state.activeManga || manga);
  }
  toast(downloaded ? 'Offline chapter removed' : 'Chapter downloaded for offline reading');
}

async function deleteAllMangaDownloads(manga) {
  const chapters = Object.keys(state.mangaDownloads || {});
  if (!chapters.length) {
    toast('No offline chapters to delete');
    return;
  }
  if (!confirm(`Delete ${chapters.length} offline chapter${chapters.length === 1 ? '' : 's'} for ${manga.name || 'this manga'}?`)) return;
  for (const chapter of chapters) {
    await api(`/api/manga/${encodeURIComponent(manga.id)}/chapters/${encodeURIComponent(chapter)}/download`, {
      method: 'DELETE',
    });
  }
  await loadMangaDownloads(manga);
  if (els.mangaDialog.open) renderChapterGrid(state.activeManga || manga);
  updateReaderControls();
  toast('Offline chapters deleted');
}

export function bindMangaControls() {
  els.mangaLibraryFilter?.addEventListener('change', () => {
    state.mangaLibraryFilter = els.mangaLibraryFilter.value;
    writeUiPrefs({ mangaLibraryFilter: state.mangaLibraryFilter });
    renderMangaLibrary();
  });
  els.mangaLibrarySort?.addEventListener('change', () => {
    state.mangaLibrarySort = els.mangaLibrarySort.value;
    writeUiPrefs({ mangaLibrarySort: state.mangaLibrarySort });
    renderMangaLibrary();
  });
  els.mangaLibrarySearchInput?.addEventListener('input', () => {
    state.mangaLibraryQuery = els.mangaLibrarySearchInput.value;
    writeUiPrefs({ mangaLibraryQuery: state.mangaLibraryQuery });
    renderMangaLibrary();
  });
  document.querySelectorAll('.manga-browse-button').forEach((button) => button.addEventListener('click', () => {
    state.mangaBrowseSort = button.dataset.mangaSort || 'Latest_Update';
    document.querySelectorAll('.manga-browse-button').forEach((item) => item.classList.toggle('active', item === button));
    runAction(button, 'Loading…', () => browseManga(button)).catch((err) => toast(err.message));
  }));
  els.mangaSearchForm.addEventListener('submit', (event) => {
    event.preventDefault();
    state.mangaBrowseSort = 'Latest_Update';
    document.querySelectorAll('.manga-browse-button').forEach((button) => button.classList.toggle('active', button === els.mangaLatestBtn));
    searchManga(els.mangaSearchInput.value.trim()).catch((err) => toast(err.message));
  });
  els.mangaGenreApplyBtn.addEventListener('click', () => {
    state.mangaGenres = Array.from(els.mangaGenreFilter.querySelectorAll('input[type="checkbox"]:checked')).map((input) => input.value);
    const year = Number(els.mangaYearFilter.value);
    state.mangaYear = Number.isInteger(year) && year >= 1917 && year <= 2100 ? year : null;
    updateMangaFilterSummary();
    els.mangaGenreFilter.open = false;
    document.querySelectorAll('.manga-browse-button').forEach((button) => button.classList.remove('active'));
    searchManga(els.mangaSearchInput.value.trim()).catch((err) => toast(err.message));
  });
  els.mangaGenreClearBtn.addEventListener('click', () => {
    els.mangaGenreFilter.querySelectorAll('input[type="checkbox"]').forEach((input) => { input.checked = false; });
    els.mangaYearFilter.value = '';
    state.mangaGenres = [];
    state.mangaYear = null;
    updateMangaFilterSummary();
    els.mangaGenreFilter.open = false;
    document.querySelectorAll('.manga-browse-button').forEach((button) => button.classList.remove('active'));
    searchManga(els.mangaSearchInput.value.trim()).catch((err) => toast(err.message));
  });
  els.closeMangaDialogBtn.addEventListener('click', () => els.mangaDialog.close());
  els.mangaDialogActions?.addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button || !state.activeManga) return;
    const manga = state.activeManga;
    if (button.dataset.action === 'manga-details-track') {
      await runAction(button, 'Saving…', async () => {
        await trackManga(manga);
        renderMangaDialogActions(manga);
      }).catch((err) => toast(err.message));
      return;
    }
    if (button.dataset.action === 'manga-details-untrack') {
      await runAction(button, 'Removing…', async () => {
        await removeManga(manga);
        if (!isMangaTracked(manga)) renderMangaDialogActions(manga);
      }).catch((err) => toast(err.message));
    }
  });
  els.mangaDialog.addEventListener('click', (event) => { if (event.target === els.mangaDialog) els.mangaDialog.close(); });
  els.mangaChapterJumpBtn.addEventListener('click', jumpToChapter);
  els.mangaChapterTarget.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      jumpToChapter();
    }
  });
  els.mangaDownloadToggleBtn.addEventListener('click', () => {
    setMangaDownloadPanelOpen(els.mangaDownloadPanel.hidden);
  });
  els.mangaDeleteAllDownloadsBtn?.addEventListener('click', () => {
    if (!state.activeManga) return;
    runAction(els.mangaDeleteAllDownloadsBtn, 'Deleting…', () => deleteAllMangaDownloads(state.activeManga))
      .catch((err) => toast(err.message));
  });
  document.querySelectorAll('.manga-download-quick').forEach((button) => {
    button.addEventListener('click', () => setQuickDownloadRange(Number(button.dataset.count)));
  });
  els.mangaDownloadCustomBtn.addEventListener('click', () => {
    const open = els.mangaDownloadCustomRange.hidden;
    els.mangaDownloadCustomRange.hidden = !open;
    els.mangaDownloadCustomBtn.setAttribute('aria-expanded', String(open));
    if (open) {
      document.querySelectorAll('.manga-download-quick').forEach((button) => button.setAttribute('aria-pressed', 'false'));
      els.mangaDownloadFrom.focus();
    }
    updateMangaDownloadSelection();
  });
  [els.mangaDownloadFrom, els.mangaDownloadTo].forEach((input) => {
    input.addEventListener('input', updateMangaDownloadSelection);
  });
  els.mangaDownloadRangeBtn.addEventListener('click', () => {
    runAction(els.mangaDownloadRangeBtn, 'Queueing…', startMangaDownloadRange)
      .then(() => renderMangaDownloadJob(state.mangaDownloadJob));
  });
  els.mangaCancelDownloadBtn.addEventListener('click', () => {
    runAction(els.mangaCancelDownloadBtn, 'Cancelling…', cancelMangaDownloadRange)
      .then(() => renderMangaDownloadJob(state.mangaDownloadJob));
  });
  els.mangaDialogBody.addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-action]');
    const card = button?.closest('[data-related-manga-id]');
    const related = state.mangaRelations.find((item) => item.id === card?.dataset.relatedMangaId);
    if (!button || !related) return;
    await runAction(button, '…', async () => {
      if (button.dataset.action === 'manga-related-about') await openMangaAbout(related);
      if (button.dataset.action === 'manga-related-track') {
        await trackManga(related);
        button.textContent = 'Tracked';
        button.disabled = true;
        button.classList.add('tracked');
        button.classList.remove('secondary');
      }
    });
  });
  els.closeMangaReaderBtn.addEventListener('click', () => closeMangaReader().catch((err) => toast(err.message)));
  els.mangaReaderDialog.addEventListener('click', (event) => {
    if (event.target === els.mangaReaderDialog) closeMangaReader().catch((err) => toast(err.message));
  });
  els.mangaReaderDialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    closeMangaReader().catch((err) => toast(err.message));
  });
  els.mangaReaderPages.addEventListener('click', toggleReaderControls);
  els.mangaReaderPages.addEventListener('scroll', () => {
    clearTimeout(readerControlsTimer);
    els.mangaReaderDialog.classList.add('controls-hidden');
    if (readerRestoring) return;
    clearTimeout(readerProgressTimer);
    if (readerReachedEnd()) {
      completeReaderChapter().catch((err) => toast(err.message));
      return;
    }
    readerProgressTimer = setTimeout(persistReaderProgress, 500);
  }, { passive: true });
  els.mangaDownloadChapterBtn.addEventListener('click', () => runAction(els.mangaDownloadChapterBtn, '…', () => toggleChapterDownload(state.activeManga, state.activeChapter)));
  updateMangaFullscreenButton();
  els.mangaFullscreenBtn.addEventListener('click', () => toggleMangaFullscreen().catch((err) => {
    exitMangaFullscreen().catch((exitError) => reportBackgroundError('Could not exit manga fullscreen', exitError));
    toast(`Fullscreen unavailable: ${err.message}`);
  }));
  const syncMangaFullscreen = () => {
    if (!fullscreenElement()) {
      els.mangaReaderDialog.classList.remove('manga-reader-fullscreen');
      document.body.classList.remove('manga-reader-fullscreen-active');
      updateMangaFullscreenButton();
    }
  };
  document.addEventListener('fullscreenchange', syncMangaFullscreen);
  document.addEventListener('webkitfullscreenchange', syncMangaFullscreen);
  els.mangaPrevChapterBtn.addEventListener('click', () => changeReaderChapter(-1).catch((err) => toast(err.message)));
  els.mangaNextChapterBtn.addEventListener('click', () => changeReaderChapter(1).catch((err) => toast(err.message)));

  document.addEventListener('click', async (event) => {
    const discover = event.target.closest('[data-action="manga-open-discover"]');
    if (discover) return document.querySelector('.tab[data-section="discover"]')?.click();
    const button = event.target.closest('.manga-card button[data-action]');
    if (!button) return;
    const manga = findManga(button.closest('.manga-card'));
    if (!manga) return;
    await runAction(button, '…', async () => {
      if (button.dataset.action === 'manga-track') await trackManga(manga);
      if (button.dataset.action === 'manga-track-sequel') await trackManga(manga);
      if (button.dataset.action === 'manga-archive') await setMangaArchived(manga, true);
      if (button.dataset.action === 'manga-unarchive') await setMangaArchived(manga, false);
      if (button.dataset.action === 'manga-remove') await removeManga(manga);
      if (button.dataset.action === 'manga-chapters') await openMangaChapters(manga);
      if (button.dataset.action === 'manga-about') await openMangaAbout(manga);
      if (button.dataset.action === 'manga-dismiss-sequel') await dismissMangaSequel(button.dataset.sourceId, manga.id);
      if (button.dataset.action === 'manga-read') await openMangaChapters(manga, button.dataset.chapter);
    }).catch((err) => toast(err.message));
  });

  els.chapterGrid.addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button || !state.activeManga) return;
    try {
      if (button.dataset.action === 'chapter-open') await openMangaReader(state.activeManga, button.dataset.chapter);
      if (button.dataset.action === 'chapter-toggle') await runAction(button, '…', () => toggleChapter(state.activeManga, button.dataset.chapter));
      if (button.dataset.action === 'chapter-download') await runAction(button, '…', () => toggleChapterDownload(state.activeManga, button.dataset.chapter));
    } catch (err) { toast(err.message); }
  });
}
