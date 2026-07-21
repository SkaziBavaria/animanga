import { api, toast, runAction } from './api.js';
import { els } from './dom.js';
import { state } from './state.js';
import { escapeHtml, stripDescription } from './util.js';

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
  const read = new Set((manga.readChapters || []).map(String));
  const chapters = [...(manga.chapters || [])].map(String).sort(compareChapters);
  return chapters.find((chapter) => !read.has(chapter)) || manga.latestChapter || chapters.at(-1) || '';
}

function progressText(manga) {
  const read = (manga.readChapters || []).length;
  const total = manga.chapters?.length || manga.chapterCount || manga.latestChapter || '?';
  return `Read ${read} / ${total}`;
}

function mangaYearRange(manga) {
  const start = Number(manga.airedStart?.year || manga.airedStart || 0);
  const end = Number(manga.airedEnd?.year || manga.airedEnd || 0);
  if (!start) return '';
  if (end && end !== start) return `${start}–${end}`;
  return String(manga.status || '').toLowerCase().includes('releas') ? `${start}–ongoing` : String(start);
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
  const yearRange = mangaYearRange(manga);
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
          ${manga.downloadedChapters ? `<span class="pill downloaded">↓ ${escapeHtml(manga.downloadedChapters)} saved</span>` : ''}
          ${manga.status ? `<span class="pill">${escapeHtml(manga.status)}</span>` : ''}
          ${yearRange ? `<span class="pill schedule">${escapeHtml(yearRange)}</span>` : ''}
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

function renderMangaResults() {
  els.mangaSearchResults.innerHTML = state.mangaResults.length
    ? state.mangaResults.map((manga) => mangaCard(manga, 'search')).join('')
    : '<div class="empty">No manga found.</div>';
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

export async function searchManga(query = '') {
  const data = await api(`/api/manga/search?q=${encodeURIComponent(query)}`);
  state.mangaResults = data.results || [];
  renderMangaResults();
}

async function trackManga(manga) {
  await api('/api/manga/track', { method: 'POST', body: JSON.stringify(manga) });
  await loadMangaLibrary();
  renderMangaResults();
  toast('Manga added to library');
}

async function removeManga(manga) {
  if (!confirm(`Remove ${manga.name} from your manga library?`)) return;
  await api(`/api/manga/${encodeURIComponent(manga.id)}`, { method: 'DELETE' });
  await loadMangaLibrary();
  toast('Manga removed');
}

function chapterRow(manga, chapter) {
  const read = (manga.readChapters || []).map(String).includes(String(chapter));
  const downloaded = Boolean(state.mangaDownloads[String(chapter)]);
  return `
    <article class="episode-row-wrap chapter-row${read ? ' watched' : ''}" data-chapter="${escapeHtml(chapter)}">
      <button class="episode episode-play chapter-open${read ? ' watched' : ''}" data-action="chapter-open" data-chapter="${escapeHtml(chapter)}" type="button">
        <span>Chapter ${escapeHtml(chapter)}</span><small>${read ? 'Read' : 'Open in reader'}</small>
      </button>
      <button class="episode-action episode-watch" data-action="chapter-toggle" data-chapter="${escapeHtml(chapter)}" type="button" title="${read ? 'Mark unread' : 'Mark read'}" aria-label="${read ? 'Mark chapter unread' : 'Mark chapter read'}">${read ? '✓' : '👁'}</button>
      <button class="episode-action" data-action="chapter-download" data-chapter="${escapeHtml(chapter)}" type="button" title="${downloaded ? 'Remove offline chapter' : 'Download for offline reading'}" aria-label="${downloaded ? 'Remove downloaded chapter' : 'Download chapter'}">${downloaded ? '⬇✓' : '↓'}</button>
    </article>`;
}

async function loadMangaDownloads(manga) {
  const data = await api(`/api/manga/${encodeURIComponent(manga.id)}/downloads`);
  state.mangaDownloads = Object.fromEntries((data.downloads || []).map((item) => [String(item.chapter), item]));
}

async function openMangaChapters(manga, requestedChapter = '') {
  const [data] = await Promise.all([
    api(`/api/manga/${encodeURIComponent(manga.id)}/chapters`),
    loadMangaDownloads(manga),
  ]);
  const details = data.manga;
  const index = state.mangaLibrary.findIndex((item) => item.id === manga.id);
  if (index >= 0) state.mangaLibrary[index] = { ...state.mangaLibrary[index], ...details };
  state.activeManga = details;
  els.mangaDialogTitle.textContent = details.name;
  els.mangaDialogMeta.textContent = `${data.chapters.length} chapters / ${details.status || 'Status unknown'}`;
  els.mangaDialogBody.innerHTML = '';
  els.chapterGrid.innerHTML = [...data.chapters].sort((a, b) => compareChapters(b, a)).map((chapter) => chapterRow(details, chapter)).join('');
  els.mangaDialog.showModal();
  if (requestedChapter) await openMangaReader(details, requestedChapter);
}

async function openMangaAbout(manga) {
  const data = await api(`/api/manga/${encodeURIComponent(manga.id)}/details`);
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
  els.mangaDialogBody.innerHTML = `
    <div class="details-layout">
      ${thumb ? `<img class="details-cover" src="${escapeHtml(thumb)}" alt="" loading="lazy" decoding="async">` : '<div class="details-cover placeholder" aria-hidden="true">?</div>'}
      <div class="details-copy">
        <p>${escapeHtml(description)}</p>
        <div class="details-pills">${(details.genres || []).map((genre) => `<span class="pill">${escapeHtml(genre)}</span>`).join('')}</div>
      </div>
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
  els.chapterGrid.innerHTML = [...(manga.chapters || [])].sort((a, b) => compareChapters(b, a)).map((item) => chapterRow(state.activeManga, item)).join('');
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
    els.chapterGrid.innerHTML = [...(manga.chapters || [])].sort((a, b) => compareChapters(b, a)).map((item) => chapterRow(state.activeManga || manga, item)).join('');
  }
  toast(downloaded ? 'Offline chapter removed' : 'Chapter downloaded for offline reading');
}

export function bindMangaControls() {
  els.mangaLatestBtn.addEventListener('click', () => searchManga('').catch((err) => toast(err.message)));
  els.mangaSearchForm.addEventListener('submit', (event) => {
    event.preventDefault();
    searchManga(els.mangaSearchInput.value.trim()).catch((err) => toast(err.message));
  });
  els.closeMangaDialogBtn.addEventListener('click', () => els.mangaDialog.close());
  els.mangaDialog.addEventListener('click', (event) => { if (event.target === els.mangaDialog) els.mangaDialog.close(); });
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
  els.closeMangaReaderBtn.addEventListener('click', () => els.mangaReaderDialog.close());
  els.mangaReaderDialog.addEventListener('click', (event) => { if (event.target === els.mangaReaderDialog) els.mangaReaderDialog.close(); });
  els.mangaReaderPages.addEventListener('click', toggleReaderControls);
  els.mangaReaderPages.addEventListener('scroll', () => {
    clearTimeout(readerControlsTimer);
    els.mangaReaderDialog.classList.add('controls-hidden');
  }, { passive: true });
  els.mangaDownloadChapterBtn.addEventListener('click', () => runAction(els.mangaDownloadChapterBtn, '…', () => toggleChapterDownload(state.activeManga, state.activeChapter)));
  els.mangaFullscreenBtn.addEventListener('click', async () => {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await els.mangaReaderDialog.requestFullscreen();
    showReaderControls();
  });
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
