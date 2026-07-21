import { api, toast, runAction } from './api.js';
import { els } from './dom.js';
import { state } from './state.js';
import { escapeHtml, nextEpisode, stripDescription } from './util.js';

function compareChapters(a, b) {
  return Number(a) - Number(b) || String(a).localeCompare(String(b));
}

function coverUrl(url) {
  if (!url) return '';
  return `/api/proxy?url=${encodeURIComponent(url)}&referrer=${encodeURIComponent('https://allmanga.to/')}`;
}

function initials(manga) {
  return String(manga.name || '?').split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase();
}

function nextChapter(manga) {
  const chapters = [...(manga.chapters || [])].map(String).sort(compareChapters);
  return nextEpisode({
    episodes: chapters,
    watchedEpisodes: manga.readChapters,
    lastWatched: manga.lastRead,
    latestEpisode: manga.latestChapter,
    episodeCount: manga.chapterCount,
  }) || manga.latestChapter || chapters.at(-1) || '';
}

function progressText(manga) {
  const readSet = new Set((manga.readChapters || []).map(String));
  const read = manga.chapters?.length
    ? manga.chapters.filter((chapter) => readSet.has(String(chapter))).length
    : readSet.size;
  const total = manga.chapters?.length || manga.chapterCount || manga.latestChapter || '?';
  return `Read ${read} / ${total}`;
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
    date = new Date(Date.UTC(Number(value.year), Math.max(0, Number(value.month || 1) - 1), Number(value.date || 1)));
  } else date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function mangaDateLabel(value) {
  const date = mangaDate(value);
  return date ? new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' }).format(date) : '';
}

function mangaRelativeDate(value) {
  const date = mangaDate(value);
  if (!date) return '';
  const days = Math.max(0, Math.floor((Date.now() - date.getTime()) / 86_400_000));
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'always' });
  if (days < 30) return formatter.format(-days, 'day');
  const months = Math.floor(days / 30);
  if (months < 12) return formatter.format(-months, 'month');
  return formatter.format(-Math.floor(days / 365), 'year');
}

function mangaRecentlyUpdated(value) {
  const date = mangaDate(value);
  if (!date) return false;
  const age = Date.now() - date.getTime();
  return age >= 0 && age <= 90 * 86_400_000;
}

function mangaOriginLabel(value) {
  const origin = String(value || '').trim().toUpperCase();
  if (['JP', 'JPN', 'JAPAN'].includes(origin)) return 'Japanese';
  if (['KR', 'KOR', 'KOREA', 'SOUTH KOREA'].includes(origin)) return 'Korean';
  if (['CN', 'CHN', 'CHINA'].includes(origin)) return 'Chinese';
  return '';
}

function mangaLanguageSelector(manga) {
  const current = manga.language === 'raw' ? 'raw' : 'sub';
  const counts = manga.chapterCounts || {};
  const hasAvailability = Object.values(counts).some((count) => Number(count) > 0);
  const options = [
    ['sub', 'Translated'],
    ['raw', 'Raw'],
  ].map(([language, label]) => {
    const unavailable = hasAvailability && Number(counts[language] || 0) <= 0;
    return `<option value="${language}"${language === current ? ' selected' : ''}${unavailable ? ' disabled' : ''}>${label}</option>`;
  }).join('');
  return `
    <label class="card-mode" title="Reading version">
      <select data-action="manga-language" aria-label="Reading version">${options}</select>
    </label>`;
}

function relationLabel(value) {
  const relation = String(value || '').toLowerCase().replace(/[:_-]+/g, ' ').trim();
  if (relation === 'sequel') return 'Sequel';
  if (relation === 'prequel' || relation === 'preserialization') return 'Prequel';
  if (relation === 'side story') return 'Side story';
  if (relation === 'spin off') return 'Spin-off';
  return relation ? relation.replace(/^./, (char) => char.toUpperCase()) : 'Related';
}

function mangaCard(manga, source) {
  const tracked = state.mangaLibrary.some((item) => item.id === manga.id && item.tracked !== false);
  const chapter = nextChapter(manga);
  const cover = coverUrl(manga.thumbnail);
  const started = (manga.readChapters || []).length > 0;
  const canContinue = started && Number(manga.newCount) > 0;
  const lifecycle = mangaLifecycle(manga);
  const latestDate = mangaRelativeDate(manga.lastChapterDate);
  const recentlyUpdated = mangaRecentlyUpdated(manga.lastChapterDate);
  const origin = mangaOriginLabel(manga.countryOfOrigin);
  const hasSequel = (manga.relations || []).some((item) => String(item.relation).toLowerCase().includes('sequel'));
  const primary = source === 'library'
    ? `<button class="primary play-action ${canContinue ? 'play-action-continue' : 'play-action-play'} manga-read-action" data-action="manga-read" data-chapter="${escapeHtml(chapter)}">${chapter ? `${canContinue ? 'Continue' : 'Read'} ch ${escapeHtml(chapter)}` : 'Chapters'}</button>`
    : tracked
      ? '<button class="tracked" data-action="manga-tracked" disabled>In library</button>'
      : '<button class="primary" data-action="manga-track">Add to library</button>';
  return `
    <article class="show-card manga-card" data-manga-id="${escapeHtml(manga.id)}" data-source="${source}">
      ${cover ? `<img class="show-thumb" src="${escapeHtml(cover)}" alt="" loading="lazy" decoding="async">` : `<div class="show-thumb placeholder">${escapeHtml(initials(manga))}</div>`}
      <div class="show-main">
        <div class="show-title">${escapeHtml(manga.name || manga.title)}</div>
        <div class="show-meta">
          <span class="pill${source === 'library' && canContinue ? ' hot' : ''}">${escapeHtml(source === 'library' ? progressText(manga) : `${manga.chapterCount || manga.latestChapter || '?'} chapters`)}</span>
          ${origin ? `<span class="pill">${escapeHtml(origin)}</span>` : ''}
          ${mangaLanguageSelector(manga)}
          ${manga.downloadedChapters ? `<span class="pill downloaded">↓ ${escapeHtml(manga.downloadedChapters)} saved</span>` : ''}
          ${lifecycle ? `<span class="pill schedule">${escapeHtml(lifecycle)}</span>` : ''}
          ${recentlyUpdated ? '<span class="pill hot">Recently updated</span>' : ''}
          ${manga.latestChapter ? `<span class="pill schedule">Ch ${escapeHtml(manga.latestChapter)}${latestDate ? ` · ${escapeHtml(latestDate)}` : ''}</span>` : ''}
          ${source !== 'library' && manga.score ? `<span class="pill">Score ${escapeHtml(manga.score)}</span>` : ''}
          ${hasSequel ? '<span class="pill sequel released">Sequel available</span>' : ''}
          ${manga.refreshError ? '<span class="pill danger">Refresh failed</span>' : ''}
        </div>
      </div>
      <div class="card-actions three">
        ${primary}
        <button class="secondary" data-action="manga-chapters">Chapters</button>
        <button class="secondary" data-action="manga-about">About</button>
        ${source === 'library' ? '<button class="danger" data-action="manga-remove">Remove</button>' : ''}
      </div>
    </article>`;
}

function findManga(card) {
  const id = card?.dataset.mangaId;
  return [...state.mangaLibrary, ...state.mangaResults].find((item) => item.id === id);
}

export function renderMangaLibrary() {
  els.mangaCount.textContent = String(state.mangaLibrary.length);
  els.mangaLibraryList.innerHTML = state.mangaLibrary.length
    ? state.mangaLibrary.map((manga) => mangaCard(manga, 'library')).join('')
    : '<div class="empty empty-action"><span>Your manga library is empty.</span><button class="small-button secondary" data-action="manga-open-discover" type="button">Find manga</button></div>';
}

function renderMangaResults(emptyHtml = '<div class="empty">No manga found.</div>') {
  els.mangaSearchResults.innerHTML = state.mangaResults.length
    ? state.mangaResults.map((manga) => mangaCard(manga, 'search')).join('')
    : emptyHtml;
}

export async function loadMangaLibrary(refresh = false) {
  if (state.mediaMode === 'manga') els.refreshBtn.disabled = true;
  try {
    const data = await api(`/api/manga/library${refresh ? '?refresh=1' : ''}`);
    state.mangaLibrary = data.mangas || [];
    renderMangaLibrary();
    if (refresh) toast('Manga library updated');
  } finally {
    if (state.mediaMode === 'manga') els.refreshBtn.disabled = false;
  }
}

export async function searchManga(query = '', options = {}) {
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
  renderMangaResults(emptyHtml);
}

async function browseManga(button) {
  let endpoint = '/api/manga/search?q=&sort=Latest_Update';
  if (button.dataset.mangaRecommended) endpoint = '/api/manga/recommendations';
  if (button.dataset.mangaPopularRange !== undefined) endpoint = `/api/manga/popular?range=${encodeURIComponent(button.dataset.mangaPopularRange)}`;
  const data = await api(endpoint);
  state.mangaResults = data.results || [];
  renderMangaResults();
}

function updateMangaFilterSummary() {
  const values = [...state.mangaGenres, state.mangaYear].filter(Boolean);
  els.mangaGenreFilterSummary.textContent = values.length ? `Filters · ${values.join(', ')}` : 'Filters · All';
}

export async function trackManga(manga) {
  await api('/api/manga/track', { method: 'POST', body: JSON.stringify(manga) });
  await loadMangaLibrary();
  renderMangaResults();
  toast('Manga added to library');
}

async function updateMangaLanguage(manga, language) {
  const data = await api(`/api/manga/${encodeURIComponent(manga.id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ language }),
  });
  Object.assign(manga, data.manga);
  await loadMangaLibrary();
  renderMangaResults();
  toast(`Using ${language === 'raw' ? 'Raw' : 'Translated'} for ${manga.name || manga.title}`);
}

async function removeManga(manga) {
  if (!confirm(`Remove ${manga.name} from your manga library?`)) return;
  await api(`/api/manga/${encodeURIComponent(manga.id)}`, { method: 'DELETE' });
  await loadMangaLibrary();
  toast('Manga removed');
}

function chapterRow(manga, chapter) {
  const chapterText = String(chapter);
  const read = (manga.readChapters || []).map(String).includes(chapterText);
  const downloaded = Boolean(state.mangaDownloads[chapterText]);
  const upNext = !read && chapterText === String(nextChapter(manga));
  const released = mangaDateLabel(manga.chapterDates?.[chapterText]);
  const classes = ['episode', 'episode-play', 'chapter-open'];
  if (read) classes.push('watched');
  if (upNext) classes.push('next');
  const stateLabels = [read ? 'Read' : upNext ? 'Up next' : 'Open in reader'];
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
      <div class="episode-view-progress${read ? ' complete' : ''}" role="progressbar" aria-label="Chapter ${escapeHtml(chapterText)} read progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${read ? '100' : '0'}" aria-valuetext="${read ? 'Read' : 'Unread'}">
        <span style="width:${read ? '100' : '0'}%"></span>
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

async function markChaptersReadThrough() {
  const manga = state.activeManga;
  const target = chapterTarget();
  const targetValue = Number(target);
  if (!manga || !target || !Number.isFinite(targetValue)) return toast('Enter a valid chapter number');
  const chapters = (manga.chapters || []).map(String);
  const throughTarget = chapters.filter((chapter) => Number.isFinite(Number(chapter)) && Number(chapter) <= targetValue);
  if (!throughTarget.length) return toast(`No chapters found through ${target}`);
  const read = new Set((manga.readChapters || []).map(String));
  const unreadCount = throughTarget.filter((chapter) => !read.has(chapter)).length;
  if (!unreadCount) return toast(`All chapters through ${target} are already read`);
  if (!confirm(`Mark ${unreadCount} chapter${unreadCount === 1 ? '' : 's'} through chapter ${target} as read?`)) return;
  const data = await api('/api/manga/read-through', {
    method: 'POST',
    body: JSON.stringify({
      id: manga.id,
      chapter: target,
      chapters,
      manga: { name: manga.name, thumbnail: manga.thumbnail, language: manga.language },
    }),
  });
  state.activeManga = { ...manga, ...data.manga, chapters };
  const index = state.mangaLibrary.findIndex((item) => item.id === manga.id);
  if (index >= 0) state.mangaLibrary[index] = { ...state.mangaLibrary[index], ...state.activeManga };
  renderChapterGrid(state.activeManga);
  renderMangaLibrary();
  const marked = Number(data.marked) || unreadCount;
  toast(`${marked} chapter${marked === 1 ? '' : 's'} marked read`);
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
  const requestedStart = Number(els.mangaDownloadFrom.value || nextChapter(state.activeManga));
  const startIndex = chapters.findIndex((chapter) => Number(chapter) >= requestedStart);
  if (startIndex < 0) return toast('No chapters available from that point');
  const selected = chapters.slice(startIndex, startIndex + count);
  if (!selected.length) return toast('No chapters available from that point');
  els.mangaDownloadFrom.value = selected[0];
  els.mangaDownloadTo.value = selected.at(-1);
}

function selectedDownloadChapters() {
  const from = Number(els.mangaDownloadFrom.value);
  const to = Number(els.mangaDownloadTo.value);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) return [];
  return downloadableChapters()
    .filter((chapter) => Number(chapter) >= from && Number(chapter) <= to)
    .filter((chapter) => !state.mangaDownloads[chapter]);
}

function mangaDownloadJobActive(job) {
  return ['queued', 'running', 'cancelling'].includes(job?.status);
}

function renderMangaDownloadJob(job) {
  const active = mangaDownloadJobActive(job);
  els.mangaDownloadRangeBtn.disabled = active;
  els.mangaCancelDownloadBtn.hidden = !active;
  if (!job) {
    els.mangaDownloadStatus.textContent = 'Choose up to 50 chapters.';
    return;
  }
  const processed = Number(job.completed || 0) + Number(job.failed || 0) + Number(job.cancelled || 0);
  if (active) {
    els.mangaDownloadStatus.textContent = `${job.status === 'queued' ? 'Queued' : 'Downloading'} ${processed} / ${job.total}${job.skipped ? ` · ${job.skipped} already saved` : ''}`;
    return;
  }
  const labels = [`${job.completed || 0} downloaded`];
  if (job.skipped) labels.push(`${job.skipped} already saved`);
  if (job.failed) labels.push(`${job.failed} failed`);
  if (job.cancelled) labels.push(`${job.cancelled} cancelled`);
  els.mangaDownloadStatus.textContent = labels.join(' · ');
}

async function refreshMangaDownloadsAfterBatch(manga) {
  await loadMangaDownloads(manga);
  const index = state.mangaLibrary.findIndex((item) => item.id === manga.id);
  if (index >= 0) state.mangaLibrary[index].downloadedChapters = Object.keys(state.mangaDownloads).length;
  if (state.activeManga?.id === manga.id) renderChapterGrid(state.activeManga);
  renderMangaLibrary();
  updateReaderControls();
}

function scheduleMangaDownloadPoll(manga) {
  clearTimeout(mangaDownloadPollTimer);
  if (!mangaDownloadJobActive(state.mangaDownloadJob)) return;
  mangaDownloadPollTimer = setTimeout(async () => {
    try {
      const wasActive = mangaDownloadJobActive(state.mangaDownloadJob);
      const data = await api(`/api/manga/${encodeURIComponent(manga.id)}/download-jobs`);
      state.mangaDownloadJob = (data.jobs || []).find(mangaDownloadJobActive) || data.jobs?.[0] || null;
      renderMangaDownloadJob(state.mangaDownloadJob);
      if (mangaDownloadJobActive(state.mangaDownloadJob)) scheduleMangaDownloadPoll(manga);
      else if (wasActive) await refreshMangaDownloadsAfterBatch(manga);
    } catch {}
  }, 800);
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
  toast(`${chapters.length} chapter${chapters.length === 1 ? '' : 's'} queued`);
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
  const language = manga.language === 'raw' ? 'raw' : 'sub';
  const [data] = await Promise.all([
    api(`/api/manga/${encodeURIComponent(manga.id)}/chapters?language=${language}`),
    loadMangaDownloads(manga),
  ]);
  const details = { ...data.manga, chapters: data.chapters };
  const index = state.mangaLibrary.findIndex((item) => item.id === manga.id);
  if (index >= 0) state.mangaLibrary[index] = { ...state.mangaLibrary[index], ...details };
  state.activeManga = details;
  els.mangaDialogTitle.textContent = details.name;
  els.mangaDialogMeta.textContent = `${data.chapters.length} chapters / ${details.status || 'Status unknown'}`;
  els.mangaDialogBody.innerHTML = '';
  els.mangaChapterTools.hidden = false;
  els.mangaDownloadTools.hidden = false;
  els.mangaChapterTarget.value = '';
  els.mangaDownloadFrom.value = nextChapter(details);
  setQuickDownloadRange(10);
  renderChapterGrid(details);
  els.mangaDialog.showModal();
  await loadMangaDownloadJobs(details);
  if (requestedChapter) await openMangaReader(details, requestedChapter);
}

async function openMangaAbout(manga) {
  const language = manga.language === 'raw' ? 'raw' : 'sub';
  const data = await api(`/api/manga/${encodeURIComponent(manga.id)}/details?language=${language}`);
  const details = data.manga;
  state.activeManga = details;
  state.mangaRelations = details.relations || [];
  const libraryIndex = state.mangaLibrary.findIndex((item) => item.id === details.id);
  if (libraryIndex >= 0) {
    state.mangaLibrary[libraryIndex] = { ...state.mangaLibrary[libraryIndex], ...details };
    renderMangaLibrary();
  }
  els.mangaDialogTitle.textContent = details.name;
  els.mangaDialogMeta.textContent = [details.type, details.status, details.score ? `Score ${details.score}` : '', details.authors?.join(', ')].filter(Boolean).join(' · ');
  const thumb = coverUrl(details.thumbnail || details.thumbnails?.[0]);
  const description = stripDescription(details.description) || 'No synopsis available.';
  els.mangaChapterTools.hidden = true;
  els.mangaDownloadTools.hidden = true;
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
              ${tracked ? '<button class="tracked small-button" type="button" disabled>In library</button>' : '<button class="secondary small-button" data-action="manga-related-track" type="button">Add to library</button>'}
            </div>
          </article>`;
        }).join('')}
      </div>
    </section>`;
}

async function openMangaReader(manga, chapter) {
  if (!chapter) return openMangaChapters(manga);
  els.mangaReaderTitle.textContent = manga.name;
  els.mangaReaderMeta.textContent = `Chapter ${chapter}`;
  els.mangaReaderPages.innerHTML = '<div class="empty">Loading pages...</div>';
  state.activeManga = manga;
  state.activeChapter = String(chapter);
  updateReaderControls();
  if (els.mangaDialog.open) els.mangaDialog.close();
  if (!els.mangaReaderDialog.open) els.mangaReaderDialog.showModal();
  showReaderControls();
  const data = await api(`/api/manga/${encodeURIComponent(manga.id)}/chapters/${encodeURIComponent(chapter)}/pages`);
  if (data.uploadDate) state.activeManga.chapterDates = { ...(state.activeManga.chapterDates || {}), [String(chapter)]: data.uploadDate };
  els.mangaReaderPages.innerHTML = data.pages.map((page) => {
    const src = page.local || String(page.url).startsWith('/')
      ? page.url
      : `/api/proxy?url=${encodeURIComponent(page.url)}&referrer=${encodeURIComponent('https://allmanga.to/')}`;
    return `<figure class="manga-page"><img src="${escapeHtml(src)}" alt="Page ${page.number}" loading="lazy" decoding="async"><figcaption>Page ${page.number}</figcaption></figure>`;
  }).join('');
  if (data.notes) els.mangaReaderMeta.textContent = `Chapter ${chapter} · ${data.notes}`;
  els.mangaReaderPages.scrollTop = 0;
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
  els.mangaFullscreenBtn.textContent = fullscreen ? '×' : '⛶';
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
  if (delta > 0) await setChapterRead(state.activeManga, state.activeChapter, true);
  await openMangaReader(state.activeManga, chapter);
}

async function setChapterRead(manga, chapter, read) {
  const currentlyRead = (manga.readChapters || []).map(String).includes(String(chapter));
  if (currentlyRead === read) return manga;
  const data = await api('/api/manga/read', {
    method: 'POST',
    body: JSON.stringify({ id: manga.id, chapter, read, manga: { name: manga.name, thumbnail: manga.thumbnail, language: manga.language } }),
  });
  state.activeManga = { ...manga, ...data.manga };
  const index = state.mangaLibrary.findIndex((item) => item.id === manga.id);
  if (index >= 0) state.mangaLibrary[index] = { ...state.mangaLibrary[index], ...data.manga };
  renderChapterGrid(state.activeManga);
  renderMangaLibrary();
  return state.activeManga;
}

async function toggleChapter(manga, chapter) {
  const read = !(manga.readChapters || []).map(String).includes(String(chapter));
  return setChapterRead(manga, chapter, read);
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

export function bindMangaControls() {
  document.addEventListener('change', async (event) => {
    const select = event.target.closest('.manga-card select[data-action="manga-language"]');
    if (!select) return;
    const card = select.closest('.manga-card');
    const manga = findManga(card);
    if (!manga) return;
    const previous = manga.language === 'raw' ? 'raw' : 'sub';
    const language = select.value === 'raw' ? 'raw' : 'sub';
    select.disabled = true;
    try {
      if (card.dataset.source === 'library') await updateMangaLanguage(manga, language);
      else {
        manga.language = language;
        manga.chapterCount = manga.chapterCounts?.[language] || manga.chapterCount;
        manga.latestChapter = manga.latestChapters?.[language] || manga.latestChapter;
        manga.lastChapterDate = manga.lastChapterDates?.[language] || null;
        renderMangaResults();
        toast(`Using ${language === 'raw' ? 'Raw' : 'Translated'} for ${manga.name || manga.title}`);
      }
    } catch (err) {
      manga.language = previous;
      select.value = previous;
      toast(err.message);
    } finally {
      select.disabled = false;
    }
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
    state.mangaYear = Number.isInteger(year) && year >= 1900 && year <= 2100 ? year : null;
    updateMangaFilterSummary();
    els.mangaGenreFilter.open = false;
    searchManga(els.mangaSearchInput.value.trim()).catch((err) => toast(err.message));
  });
  els.mangaGenreClearBtn.addEventListener('click', () => {
    els.mangaGenreFilter.querySelectorAll('input[type="checkbox"]').forEach((input) => { input.checked = false; });
    els.mangaYearFilter.value = '';
    state.mangaGenres = [];
    state.mangaYear = null;
    updateMangaFilterSummary();
    els.mangaGenreFilter.open = false;
    searchManga(els.mangaSearchInput.value.trim()).catch((err) => toast(err.message));
  });
  els.closeMangaDialogBtn.addEventListener('click', () => els.mangaDialog.close());
  els.mangaDialog.addEventListener('click', (event) => { if (event.target === els.mangaDialog) els.mangaDialog.close(); });
  els.mangaChapterJumpBtn.addEventListener('click', jumpToChapter);
  els.mangaChapterTarget.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      jumpToChapter();
    }
  });
  els.mangaMarkThroughBtn.addEventListener('click', () => runAction(els.mangaMarkThroughBtn, 'Marking…', markChaptersReadThrough));
  document.querySelectorAll('.manga-download-quick').forEach((button) => {
    button.addEventListener('click', () => setQuickDownloadRange(Number(button.dataset.count)));
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
        button.textContent = 'In library';
        button.disabled = true;
      }
    });
  });
  els.closeMangaReaderBtn.addEventListener('click', () => closeMangaReader().catch((err) => toast(err.message)));
  els.mangaReaderDialog.addEventListener('click', (event) => {
    if (event.target === els.mangaReaderDialog) closeMangaReader().catch((err) => toast(err.message));
  });
  els.mangaReaderPages.addEventListener('click', toggleReaderControls);
  els.mangaReaderPages.addEventListener('scroll', () => {
    clearTimeout(readerControlsTimer);
    els.mangaReaderDialog.classList.add('controls-hidden');
  }, { passive: true });
  els.mangaDownloadChapterBtn.addEventListener('click', () => runAction(els.mangaDownloadChapterBtn, '…', () => toggleChapterDownload(state.activeManga, state.activeChapter)));
  els.mangaFullscreenBtn.addEventListener('click', () => toggleMangaFullscreen().catch((err) => {
    exitMangaFullscreen().catch(() => {});
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
      if (button.dataset.action === 'manga-remove') await removeManga(manga);
      if (button.dataset.action === 'manga-chapters') await openMangaChapters(manga);
      if (button.dataset.action === 'manga-about') await openMangaAbout(manga);
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
