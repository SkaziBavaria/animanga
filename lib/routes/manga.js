'use strict';

const fs = require('fs');
const { pipeline } = require('stream/promises');
const { sendJson, sendError, readBody } = require('../http');
const {
  readState,
  saveState,
  saveMangaPositionAtomic,
  updateMangaRead,
  updateMangaReadBatch,
} = require('../state');
const { episodeKey, episodesThrough } = require('../episodes');
const { searchManga, popularManga, getMangaDetails, getChapterPages } = require('../allmanga');
const {
  mergeManga,
  presentManga,
  presentMangaResults,
  refreshManga,
  presentMangaReleaseWatch,
  createMangaReleaseWatch,
  checkMangaReleaseWatch,
} = require('../manga-library');
const {
  cacheChapter,
  readManifest,
  presentPages,
  downloadChapter,
  listDownloads,
  cachedChapterDates,
  localPage,
  deleteDownload,
} = require('../manga-cache');
const {
  MAX_BATCH_CHAPTERS,
  startMangaDownloadBatch,
  listMangaDownloadJobs,
  cancelMangaDownloadJob,
} = require('../manga-download-jobs');
const { invalid, requiredString, stringArray } = require('../validation');
const { proxyRemotePages } = require('../proxy-sign');

async function handleMangaRoutes(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/manga/library') {
    const state = readState();
    let mangas = Object.values(state.mangas).filter((manga) => manga.tracked !== false);
    if (url.searchParams.get('refresh') === '1') {
      const refreshed = [];
      for (const manga of mangas) {
        try {
          refreshed.push(await refreshManga(state, manga));
        } catch (err) {
          refreshed.push({ ...presentManga(manga), refreshError: err.message });
        }
      }
      saveState(state);
      mangas = refreshed;
    } else {
      mangas = mangas.map(presentManga);
    }
    mangas = mangas.map((manga) => ({
      ...manga,
      downloadedChapters: listDownloads(manga.id, manga.language || 'sub').length,
    }));
    mangas.sort((a, b) => Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0) || String(a.name).localeCompare(String(b.name)));
    return sendJson(res, 200, { mangas });
  }

  if (req.method === 'GET' && url.pathname === '/api/manga/search') {
    const result = await searchManga(url.searchParams.get('q') || '', {
      page: Number(url.searchParams.get('page') || 1),
      language: url.searchParams.get('language') || 'sub',
      sortBy: url.searchParams.get('sort') || 'Latest_Update',
      genres: url.searchParams.getAll('genre'),
      year: url.searchParams.get('year') || null,
    });
    return sendJson(res, 200, presentMangaResults(result));
  }

  if (req.method === 'GET' && url.pathname === '/api/manga/popular') {
    return sendJson(res, 200, presentMangaResults(await popularManga(Number(url.searchParams.get('range') || 0), {
      language: url.searchParams.get('language') || 'sub',
    })));
  }

  if (req.method === 'GET' && url.pathname === '/api/manga/recommendations') {
    const state = readState();
    const genres = Object.values(state.mangas || {}).flatMap((manga) => manga.genres || []);
    const ranked = [...new Set(genres)].sort((a, b) => genres.filter((item) => item === b).length - genres.filter((item) => item === a).length).slice(0, 3);
    return sendJson(res, 200, presentMangaResults(await searchManga('', { genres: ranked, limit: 30, language: 'sub' })));
  }

  if (req.method === 'POST' && url.pathname === '/api/manga/track') {
    const body = await readBody(req);
    requiredString(body, 'id', { label: 'manga id' });
    const state = readState();
    let details;
    try { details = await getMangaDetails(body.id, body.language || 'sub'); } catch {}
    const manga = mergeManga(state, { ...body, ...details, tracked: true, archived: false });
    saveState(state);
    return sendJson(res, 200, { manga: presentManga(manga) });
  }

  if (req.method === 'POST' && url.pathname === '/api/manga/read') {
    const body = await readBody(req);
    requiredString(body, 'id', { label: 'manga id' });
    requiredString(body, 'chapter');
    const manga = updateMangaRead(body.id, body.chapter, body.read !== false, body.manga || {});
    return sendJson(res, 200, { manga: presentManga(manga) });
  }

  if (req.method === 'POST' && url.pathname === '/api/manga/read-through') {
    const body = await readBody(req);
    requiredString(body, 'id', { label: 'manga id' });
    requiredString(body, 'chapter');
    const target = episodeKey(body.chapter);
    if (!target || !Number.isFinite(Number(target))) invalid('Invalid target chapter');
    const state = readState();
    const existing = state.mangas[body.id] || {};
    let details;
    try {
      details = await getMangaDetails(body.id, existing.language || body.manga?.language || 'sub');
    } catch {
      details = {};
    }
    const availableChapters = details.chapters?.length
      ? details.chapters
      : body.chapters?.length
        ? body.chapters
        : existing.chapters || [];
    if (!availableChapters.length) invalid('Chapter list unavailable');
    const throughTarget = episodesThrough(availableChapters, target).map(episodeKey);
    const previouslyRead = new Set((existing.readChapters || []).map(String));
    const manga = updateMangaReadBatch(body.id, throughTarget, true, {
      ...existing,
      ...details,
      ...(body.manga || {}),
      chapters: availableChapters,
      tracked: true,
    });
    const marked = throughTarget.filter((chapter) => !previouslyRead.has(chapter)).length;
    return sendJson(res, 200, { manga: presentManga(manga), marked });
  }

  if (req.method === 'POST' && url.pathname === '/api/manga/progress') {
    const body = await readBody(req);
    requiredString(body, body.mangaId ? 'mangaId' : 'id', { label: 'manga id' });
    requiredString(body, 'chapter');
    const result = saveMangaPositionAtomic(body);
    return sendJson(res, 200, { ok: true, ...result });
  }

  const mangaDetailsMatch = url.pathname.match(/^\/api\/manga\/([^/]+)\/details$/);
  if (req.method === 'GET' && mangaDetailsMatch) {
    const id = decodeURIComponent(mangaDetailsMatch[1]);
    const state = readState();
    const existing = state.mangas[id] || {};
    const language = (url.searchParams.get('language') || existing.language) === 'raw' ? 'raw' : 'sub';
    const details = await getMangaDetails(id, language);
    const manga = existing.id ? mergeManga(state, { ...existing, ...details }) : { ...existing, ...details };
    if (existing.id) saveState(state);
    return sendJson(res, 200, { manga: presentManga(manga) });
  }

  const mangaChaptersMatch = url.pathname.match(/^\/api\/manga\/([^/]+)\/chapters$/);
  if (req.method === 'GET' && mangaChaptersMatch) {
    const id = decodeURIComponent(mangaChaptersMatch[1]);
    const state = readState();
    const existing = state.mangas[id] || {};
    const language = (url.searchParams.get('language') || existing.language) === 'raw' ? 'raw' : 'sub';
    const details = await getMangaDetails(id, language, { includeRelations: false });
    const manga = existing.id ? mergeManga(state, { ...existing, ...details }) : { ...existing, ...details };
    if (existing.id) saveState(state);
    const chapterDates = cachedChapterDates(id, language);
    if (details.latestChapter && details.lastChapterDate) chapterDates[String(details.latestChapter)] = details.lastChapterDate;
    return sendJson(res, 200, { manga: presentManga({ ...manga, chapterDates }), chapters: details.chapters, chapterDates });
  }

  const mangaDownloadsMatch = url.pathname.match(/^\/api\/manga\/([^/]+)\/downloads$/);
  if (req.method === 'GET' && mangaDownloadsMatch) {
    const id = decodeURIComponent(mangaDownloadsMatch[1]);
    const state = readState();
    const language = state.mangas[id]?.language || 'sub';
    return sendJson(res, 200, { downloads: listDownloads(id, language) });
  }

  const mangaBatchDownloadMatch = url.pathname.match(/^\/api\/manga\/([^/]+)\/chapters\/download-batch$/);
  if (req.method === 'POST' && mangaBatchDownloadMatch) {
    const id = decodeURIComponent(mangaBatchDownloadMatch[1]);
    const body = await readBody(req);
    const state = readState();
    const manga = state.mangas[id];
    if (!manga) return sendError(res, 404, 'Manga not found');
    const requested = Array.from(new Set(stringArray(body, 'chapters')));
    if (!requested.length) return sendError(res, 422, 'Select at least one chapter');
    if (requested.length > MAX_BATCH_CHAPTERS) {
      return sendError(res, 422, `A batch can contain at most ${MAX_BATCH_CHAPTERS} chapters`);
    }
    const available = new Set((manga.chapters || []).map(String));
    if (requested.some((chapter) => !available.has(chapter))) {
      return sendError(res, 422, 'One or more selected chapters are unavailable');
    }
    const job = startMangaDownloadBatch({
      mangaId: id,
      mangaName: manga.name || manga.title,
      language: manga.language || 'sub',
      chapters: requested,
    });
    return sendJson(res, 202, { job });
  }

  const mangaDownloadJobsMatch = url.pathname.match(/^\/api\/manga\/([^/]+)\/download-jobs$/);
  if (req.method === 'GET' && mangaDownloadJobsMatch) {
    const id = decodeURIComponent(mangaDownloadJobsMatch[1]);
    return sendJson(res, 200, { jobs: listMangaDownloadJobs(id) });
  }

  const mangaDownloadJobMatch = url.pathname.match(/^\/api\/manga\/([^/]+)\/download-jobs\/([^/]+)$/);
  if (req.method === 'DELETE' && mangaDownloadJobMatch) {
    const id = decodeURIComponent(mangaDownloadJobMatch[1]);
    const jobId = decodeURIComponent(mangaDownloadJobMatch[2]);
    const job = cancelMangaDownloadJob(id, jobId);
    if (!job) return sendError(res, 404, 'Manga download job not found');
    return sendJson(res, 200, { job });
  }

  const mangaDownloadMatch = url.pathname.match(/^\/api\/manga\/([^/]+)\/chapters\/([^/]+)\/download$/);
  if (mangaDownloadMatch && ['POST', 'DELETE'].includes(req.method)) {
    const id = decodeURIComponent(mangaDownloadMatch[1]);
    const chapter = decodeURIComponent(mangaDownloadMatch[2]);
    const state = readState();
    const language = state.mangas[id]?.language || 'sub';
    if (req.method === 'DELETE') {
      return sendJson(res, 200, { deleted: deleteDownload(id, language, chapter) });
    }
    let result = readManifest(id, language, chapter);
    if (!result || result.downloaded) result = await getChapterPages(id, chapter, language);
    const manifest = await downloadChapter(id, language, chapter, result);
    return sendJson(res, 200, { download: { chapter, pages: manifest.pages.length, status: 'done' } });
  }

  const mangaLocalPageMatch = url.pathname.match(/^\/api\/manga\/([^/]+)\/chapters\/([^/]+)\/pages\/([^/]+)$/);
  if (req.method === 'GET' && mangaLocalPageMatch) {
    const id = decodeURIComponent(mangaLocalPageMatch[1]);
    const chapter = decodeURIComponent(mangaLocalPageMatch[2]);
    const number = decodeURIComponent(mangaLocalPageMatch[3]);
    const state = readState();
    const page = localPage(id, state.mangas[id]?.language || 'sub', chapter, number);
    if (!page) return sendError(res, 404, 'Downloaded manga page not found');
    const stat = fs.statSync(page.file);
    res.writeHead(200, { 'content-type': page.contentType, 'content-length': stat.size, 'cache-control': 'private, max-age=31536000, immutable' });
    try {
      await pipeline(fs.createReadStream(page.file), res);
    } catch (err) {
      if (!res.headersSent) sendError(res, 500, 'Failed to stream manga page', err.message);
      else res.destroy();
    }
    return;
  }

  const mangaPagesMatch = url.pathname.match(/^\/api\/manga\/([^/]+)\/chapters\/([^/]+)\/pages$/);
  if (req.method === 'GET' && mangaPagesMatch) {
    const id = decodeURIComponent(mangaPagesMatch[1]);
    const chapter = decodeURIComponent(mangaPagesMatch[2]);
    const state = readState();
    const manga = state.mangas[id] || {};
    const language = manga.language || 'sub';
    const cached = readManifest(id, language, chapter);
    if (cached?.downloaded) return sendJson(res, 200, presentPages(id, language, chapter, cached));
    try {
      const result = await getChapterPages(id, chapter, language);
      cacheChapter(id, language, chapter, result);
      return sendJson(res, 200, proxyRemotePages(result));
    } catch (error) {
      if (cached?.pages?.length) return sendJson(res, 200, proxyRemotePages(cached));
      throw error;
    }
  }

  const mangaMatch = url.pathname.match(/^\/api\/manga\/([^/]+)$/);
  if (req.method === 'PATCH' && mangaMatch) {
    const id = decodeURIComponent(mangaMatch[1]);
    const body = await readBody(req);
    const state = readState();
    const existing = state.mangas[id];
    if (!existing) return sendError(res, 404, 'Manga not found');
    const patch = { ...existing };
    if (Object.hasOwn(body, 'archived')) patch.archived = Boolean(body.archived);
    if (Object.hasOwn(body, 'language')) {
      const language = body.language === 'raw' ? 'raw' : 'sub';
      const details = await getMangaDetails(id, language);
      Object.assign(patch, details, { language });
    }
    const manga = mergeManga(state, patch);
    saveState(state);
    return sendJson(res, 200, { manga: presentManga(manga) });
  }
  if (req.method === 'DELETE' && mangaMatch) {
    const id = decodeURIComponent(mangaMatch[1]);
    const state = readState();
    const manga = mergeManga(state, { ...(state.mangas[id] || { id }), tracked: false });
    saveState(state);
    return sendJson(res, 200, { manga: presentManga(manga) });
  }

  if (req.method === 'GET' && url.pathname === '/api/manga/release-watches') {
    const state = readState();
    const watches = Object.values(state.mangaReleaseWatches)
      .map(presentMangaReleaseWatch)
      .sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')));
    return sendJson(res, 200, { watches });
  }

  if (req.method === 'POST' && url.pathname === '/api/manga/release-watches') {
    const body = await readBody(req);
    const state = readState();
    const query = requiredString(body, 'query', { maxLength: 200 });
    const watch = createMangaReleaseWatch(state, query, body.language || 'sub');
    saveState(state);
    return sendJson(res, 200, { watch: presentMangaReleaseWatch(watch) });
  }

  if (req.method === 'POST' && url.pathname === '/api/manga/release-watches/check') {
    const state = readState();
    const watches = Object.values(state.mangaReleaseWatches || {});
    const checked = [];
    for (const watch of watches) {
      checked.push(await checkMangaReleaseWatch(state, watch));
    }
    saveState(state);
    return sendJson(res, 200, {
      watches: checked.map(presentMangaReleaseWatch),
      found: checked.filter((watch) => watch.status === 'found').map(presentMangaReleaseWatch),
    });
  }

  const mangaReleaseWatchMatch = url.pathname.match(/^\/api\/manga\/release-watches\/([^/]+)$/);
  if (req.method === 'DELETE' && mangaReleaseWatchMatch) {
    const id = decodeURIComponent(mangaReleaseWatchMatch[1]);
    const state = readState();
    if (!state.mangaReleaseWatches[id]) return sendError(res, 404, 'Manga release watch not found');
    delete state.mangaReleaseWatches[id];
    saveState(state);
    return sendJson(res, 200, { ok: true });
  }


  return sendError(res, 404, 'Manga endpoint missing');
}

module.exports = { handleMangaRoutes };
