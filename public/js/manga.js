import { api, toast, runAction } from './api.js';
import { els } from './dom.js';
import { state } from './state.js';
import { escapeHtml } from './util.js';

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

function mangaCard(manga, source) {
  const tracked = state.mangaLibrary.some((item) => item.id === manga.id && item.tracked !== false);
  const chapter = nextChapter(manga);
  const cover = coverUrl(manga.thumbnail);
  const primary = source === 'library'
    ? `<button class="primary manga-read-action" data-action="manga-read" data-chapter="${escapeHtml(chapter)}">${chapter ? `Read ch ${escapeHtml(chapter)}` : 'Chapters'}</button>`
    : tracked
      ? '<button class="tracked" data-action="manga-tracked" disabled>In library</button>'
      : '<button class="primary" data-action="manga-track">Add to library</button>';
  return `
    <article class="show-card manga-card" data-manga-id="${escapeHtml(manga.id)}" data-source="${source}">
      ${cover ? `<img class="show-thumb" src="${escapeHtml(cover)}" alt="" loading="lazy" decoding="async">` : `<div class="show-thumb placeholder">${escapeHtml(initials(manga))}</div>`}
      <div class="show-main">
        <div class="show-title">${escapeHtml(manga.name || manga.title)}</div>
        <div class="show-meta">
          <span class="pill">${escapeHtml(source === 'library' ? progressText(manga) : `${manga.chapterCount || manga.latestChapter || '?'} chapters`)}</span>
          ${manga.status ? `<span class="pill">${escapeHtml(manga.status)}</span>` : ''}
          ${manga.countryOfOrigin ? `<span class="pill">${escapeHtml(manga.countryOfOrigin)}</span>` : ''}
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
  return `
    <article class="episode-row-wrap chapter-row${read ? ' watched' : ''}" data-chapter="${escapeHtml(chapter)}">
      <button class="episode episode-play chapter-open${read ? ' watched' : ''}" data-action="chapter-open" data-chapter="${escapeHtml(chapter)}" type="button">
        <span>Chapter ${escapeHtml(chapter)}</span><small>${read ? 'Read' : 'Open in reader'}</small>
      </button>
      <button class="episode-action episode-watch" data-action="chapter-toggle" data-chapter="${escapeHtml(chapter)}" type="button" title="${read ? 'Mark unread' : 'Mark read'}" aria-label="${read ? 'Mark chapter unread' : 'Mark chapter read'}">${read ? '✓' : '👁'}</button>
    </article>`;
}

async function openMangaChapters(manga, requestedChapter = '') {
  const data = await api(`/api/manga/${encodeURIComponent(manga.id)}/chapters`);
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
  els.mangaDialogTitle.textContent = details.name;
  els.mangaDialogMeta.textContent = [details.type, details.status, details.authors?.join(', ')].filter(Boolean).join(' / ');
  els.mangaDialogBody.innerHTML = `
    ${details.description ? `<p>${escapeHtml(details.description)}</p>` : '<p>No synopsis available.</p>'}
    ${details.genres?.length ? `<div class="show-meta">${details.genres.map((genre) => `<span class="pill">${escapeHtml(genre)}</span>`).join('')}</div>` : ''}`;
  els.chapterGrid.innerHTML = '';
  els.mangaDialog.showModal();
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
  const data = await api(`/api/manga/${encodeURIComponent(manga.id)}/chapters/${encodeURIComponent(chapter)}/pages`);
  els.mangaReaderPages.innerHTML = data.pages.map((page) => {
    const src = `/api/proxy?url=${encodeURIComponent(page.url)}&referrer=${encodeURIComponent('https://allmanga.to/')}`;
    return `<figure class="manga-page"><img src="${escapeHtml(src)}" alt="Page ${page.number}" loading="lazy" decoding="async"><figcaption>Page ${page.number}</figcaption></figure>`;
  }).join('');
  if (data.notes) els.mangaReaderMeta.textContent = `Chapter ${chapter} · ${data.notes}`;
  els.mangaReaderPages.scrollTop = 0;
}

function readerChapter(delta) {
  const chapters = [...(state.activeManga?.chapters || [])].map(String).sort(compareChapters);
  const index = chapters.indexOf(String(state.activeChapter));
  return index >= 0 ? chapters[index + delta] || '' : '';
}

function updateReaderControls() {
  const read = (state.activeManga?.readChapters || []).map(String).includes(String(state.activeChapter));
  els.mangaMarkReadBtn.textContent = read ? 'Mark unread' : 'Mark read';
  els.mangaMarkReadBtn.classList.toggle('primary', !read);
  els.mangaMarkReadBtn.classList.toggle('secondary', read);
  els.mangaPrevChapterBtn.disabled = !readerChapter(-1);
  els.mangaNextChapterBtn.disabled = !readerChapter(1);
}

async function changeReaderChapter(delta) {
  const chapter = readerChapter(delta);
  if (chapter) await openMangaReader(state.activeManga, chapter);
}

async function toggleChapter(manga, chapter) {
  const read = !(manga.readChapters || []).map(String).includes(String(chapter));
  const data = await api('/api/manga/read', {
    method: 'POST',
    body: JSON.stringify({ id: manga.id, chapter, read, manga: { name: manga.name, thumbnail: manga.thumbnail, language: manga.language } }),
  });
  state.activeManga = { ...manga, ...data.manga };
  const index = state.mangaLibrary.findIndex((item) => item.id === manga.id);
  if (index >= 0) state.mangaLibrary[index] = { ...state.mangaLibrary[index], ...data.manga };
  els.chapterGrid.innerHTML = [...(manga.chapters || [])].sort((a, b) => compareChapters(b, a)).map((item) => chapterRow(state.activeManga, item)).join('');
  renderMangaLibrary();
}

export function bindMangaControls() {
  els.mangaLatestBtn.addEventListener('click', () => searchManga('').catch((err) => toast(err.message)));
  els.mangaSearchForm.addEventListener('submit', (event) => {
    event.preventDefault();
    searchManga(els.mangaSearchInput.value.trim()).catch((err) => toast(err.message));
  });
  els.closeMangaDialogBtn.addEventListener('click', () => els.mangaDialog.close());
  els.mangaDialog.addEventListener('click', (event) => { if (event.target === els.mangaDialog) els.mangaDialog.close(); });
  els.closeMangaReaderBtn.addEventListener('click', () => els.mangaReaderDialog.close());
  els.mangaReaderDialog.addEventListener('click', (event) => { if (event.target === els.mangaReaderDialog) els.mangaReaderDialog.close(); });
  els.mangaMarkReadBtn.addEventListener('click', async () => {
    await runAction(els.mangaMarkReadBtn, '…', () => toggleChapter(state.activeManga, state.activeChapter));
    updateReaderControls();
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
    } catch (err) { toast(err.message); }
  });
}
