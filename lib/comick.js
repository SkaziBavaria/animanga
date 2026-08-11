'use strict';

const { compareEpisodes, highestEpisode } = require('./episodes');
const { withUpstreamRetry } = require('./upstream-retry');
const { fetchWebText } = require('./anidb-fetch');
const { COMICK_API } = require('./config');
const { getChapterPagesByTitle } = require('./weebcentral');
const { getChapterPagesByTitle: getMangaPillPages } = require('./mangapill');
const { getChapterPagesByTitle: getMangaDexPages } = require('./mangadex');
const { resolvedTitleMatchesAny } = require('./title-match');

let pageResolvers = [getChapterPagesByTitle, getMangaPillPages, getMangaDexPages];

const COMICK_REFERER = 'https://comick.dev/';

let textFetcher = null;

function setRawFetcher(fn) {
  textFetcher = typeof fn === 'function' ? fn : null;
}

async function fetchJson(path) {
  if (textFetcher) {
    const raw = await textFetcher(path);
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  }
  return withUpstreamRetry(async () => {
    const url = path.startsWith('http') ? path : `${COMICK_API}${path.startsWith('/') ? '' : '/'}${path}`;
    const body = await fetchWebText(url, {
      timeoutMs: 20_000,
      headers: {
        Referer: COMICK_REFERER,
        Origin: COMICK_REFERER.replace(/\/$/, ''),
        Accept: 'application/json',
      },
    });
    try {
      return JSON.parse(body);
    } catch {
      throw new Error(`ComicK returned non-JSON for ${url}`);
    }
  });
}

function titleFromComic(comic) {
  const titles = Array.isArray(comic?.md_titles) ? comic.md_titles : [];
  const english = titles.filter((item) => item?.lang === 'en' && item?.title).map((item) => item.title);
  const slugTitle = String(comic?.slug || '').replace(/^\d+-/, '').replace(/-\d+$/, '').replace(/-/g, ' ');
  const normalizedSlug = normalizeTitle(slugTitle);
  const slugMatch = english.find((title) => normalizeTitle(title) === normalizedSlug);
  return slugMatch || comic?.title || english[0] || comic?.slug || 'Untitled manga';
}

function normalizeTitle(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function nativeFromComic(comic) {
  const titles = Array.isArray(comic?.md_titles) ? comic.md_titles : [];
  return titles.find((item) => item?.lang === 'ja' && item?.title)?.title
    || titles.find((item) => item?.lang === comic?.iso639_1 && item?.title)?.title
    || '';
}

function statusFromComic(comic) {
  const value = Number(comic?.status);
  if (value === 2) return 'Finished';
  if (value === 1) return 'Ongoing';
  if (value === 3) return 'Hiatus';
  if (value === 4) return 'Cancelled';
  return comic?.translation_completed ? 'Finished' : 'Ongoing';
}

function coverFromComic(comic) {
  if (comic?.cover_url) return comic.cover_url;
  const key = comic?.md_covers?.[0]?.b2key;
  if (!key) return '';
  return `https://meo.comick.pictures/${String(key).replace(/(\.[a-z]+)$/i, '-s$1')}`;
}

function mangaSummary(comic) {
  const name = titleFromComic(comic);
  const latest = comic?.last_chapter != null ? String(comic.last_chapter) : null;
  const chapterCount = Number(comic?.chapter_count || comic?.last_chapter || 0) || 0;
  return {
    id: comic.slug || comic.hid,
    hid: comic.hid || '',
    slug: comic.slug || '',
    name,
    sourceName: comic.title || name,
    englishName: name,
    nativeName: nativeFromComic(comic),
    thumbnail: coverFromComic(comic),
    chapterCount,
    latestChapter: latest,
    lastChapterDate: comic?.uploaded_at || null,
    score: comic?.bayesian_rating || comic?.rating || null,
    type: comic?.media_type || 'Manga',
    status: statusFromComic(comic),
    airedStart: comic?.year ? { year: Number(comic.year), month: 0, date: 1 } : null,
    airedEnd: null,
    season: null,
    countryOfOrigin: comic?.country || '',
    title: `${name} (${chapterCount || latest || '?'} chapters)`,
    provider: 'comick',
  };
}

async function searchManga(search = '', {
  page = 1,
  limit = 30,
  sortBy = 'Latest_Update',
  genres = [],
  year = null,
} = {}) {
  const params = new URLSearchParams([
    ['type', 'comic'],
    ['page', String(Math.max(1, Number(page) || 1))],
    ['limit', String(Math.max(1, Math.min(50, Number(limit) || 30)))],
  ]);
  const q = String(search || '').trim();
  if (q) params.set('q', q);
  if (year) params.set('from', String(year));
  if (year) params.set('to', String(year));
  if (genres?.length) params.set('genres', genres.join(','));

  const sort = String(sortBy || '');
  if (sort === 'Latest_Update' || sort === 'uploaded') params.set('sort', 'uploaded');
  else if (sort === 'Trending' || sort === 'view') params.set('sort', 'view');
  else if (sort === 'follow' || sort === 'user_follow_count') params.set('sort', 'follow');
  else params.set('sort', q ? 'user_follow_count' : 'view');

  const data = await fetchJson(`/v1.0/search/?${params.toString()}`);
  const rows = Array.isArray(data)
    ? data
    : (Array.isArray(data?.data) ? data.data : (Array.isArray(data?.results) ? data.results : []));
  return {
    total: rows.length,
    results: rows.filter((item) => item?.hid || item?.slug).map((item) => mangaSummary(item)),
  };
}

async function popularManga(range = 0, { limit = 30 } = {}) {
  const value = Number(range) || 0;
  let sort = 'follow';
  if (value === 1) sort = 'view';
  else if (value === 7 || value === 30) sort = 'uploaded';
  return searchManga('', { limit, sortBy: sort, page: 1 });
}

async function listAllChapters(comicKey) {
  const lang = 'en';
  const chapters = [];
  const seen = new Set();
  for (let page = 1; page <= 20; page += 1) {
    const data = await fetchJson(`/comic/${encodeURIComponent(comicKey)}/chapters?limit=100&page=${page}&lang=${encodeURIComponent(lang)}`);
    const batch = data?.chapters || [];
    if (!batch.length) break;
    for (const item of batch) {
      const number = item?.chap != null ? String(item.chap) : '';
      if (!number || seen.has(number)) continue;
      seen.add(number);
      chapters.push(number);
    }
    if (batch.length < 100) break;
  }
  return chapters.sort(compareEpisodes);
}

function comicIdentityMatches(key, comic) {
  const wanted = String(key || '').trim();
  if (!wanted || !comic) return false;
  if (String(comic.hid || '').trim() === wanted) return true;
  return String(comic.slug || '').trim().toLowerCase() === wanted.toLowerCase();
}

function assertComicIdentity(key, payload) {
  if (!payload?.comic?.hid || !comicIdentityMatches(key, payload.comic)) {
    throw new Error(`ComicK identity mismatch for "${key}"`);
  }
  return payload;
}

async function fetchComicPayload(id) {
  const key = String(id || '').trim();
  if (!key) throw new Error('Manga not found');
  let directError;
  try {
    return assertComicIdentity(key, await fetchJson(`/comic/${encodeURIComponent(key)}/?tachiyomi=true`));
  } catch (error) {
    directError = error;
  }

  let search;
  try {
    search = await searchManga(key, { limit: 10 });
  } catch (searchError) {
    throw new Error(
      `ComicK could not verify "${key}": ${directError.message}; search failed: ${searchError.message}`,
      { cause: searchError },
    );
  }
  const match = (search.results || []).find((item) => (
    String(item.hid || '') === key
    || String(item.slug || '').toLowerCase() === key.toLowerCase()
    || String(item.id || '').toLowerCase() === key.toLowerCase()
  ));
  if (!match?.slug) {
    throw new Error(`ComicK could not verify "${key}": ${directError.message}; exact search match missing`);
  }
  try {
    return assertComicIdentity(key, await fetchJson(`/comic/${encodeURIComponent(match.slug)}/?tachiyomi=true`));
  } catch (fallbackError) {
    throw new Error(
      `ComicK could not verify "${key}": ${directError.message}; exact fallback failed: ${fallbackError.message}`,
      { cause: fallbackError },
    );
  }
}

async function getMangaDetails(id, { includeRelations = true } = {}) {
  const payload = await fetchComicPayload(id);

  const comic = payload?.comic;
  if (!comic?.hid) throw new Error('Manga not found');
  const chapters = await listAllChapters(comic.hid || comic.slug);
  const genres = (payload?.comic?.md_comic_md_genres || comic.md_comic_md_genres || [])
    .map((item) => item?.md_genres?.name)
    .filter(Boolean);
  const authors = (payload?.authors || []).map((item) => item?.name).filter(Boolean);
  const artists = (payload?.artists || []).map((item) => item?.name).filter(Boolean);

  let relations = [];
  if (includeRelations) {
    relations = (comic.relate_from || comic.recommendations || [])
      .slice(0, 6)
      .map((item) => ({
        id: item?.hid || item?.slug || item?.relate_to?.hid,
        name: item?.title || item?.relate_to?.title || 'Related manga',
        relation: item?.rel || item?.relation || 'related',
      }))
      .filter((item) => item.id);
  }

  return {
    ...mangaSummary({ ...comic, cover_url: comic.cover_url || coverFromComic(comic) }),
    description: comic.desc || '',
    thumbnails: comic.cover_url ? [comic.cover_url] : [],
    authors: authors.length ? authors : artists,
    genres,
    magazine: '',
    tags: genres,
    alternativeTitles: [...new Set([
      ...(comic.md_titles || []).filter((item) => item?.lang === 'en').map((item) => item.title),
      ...(comic.md_titles || []).map((item) => item?.title),
    ].filter(Boolean))],
    relations,
    chapters,
    latestChapter: highestEpisode(chapters) || (comic.last_chapter != null ? String(comic.last_chapter) : null),
  };
}

async function getChapterPages(id, chapter) {
  const payload = await fetchComicPayload(id);
  const comic = payload?.comic;
  if (!comic?.hid) throw new Error('Manga not found');
  const name = titleFromComic(comic);
  const names = [
    name,
    String(comic.slug || '').replace(/^\d+-/, '').replace(/-/g, ' '),
    comic.title,
    ...(comic.md_titles || []).filter((item) => item?.lang === 'en').map((item) => item.title),
    ...(comic.md_titles || []).map((item) => item?.title),
  ];
  const errors = [];
  for (const [index, resolver] of pageResolvers.entries()) {
    try {
      const result = await resolver(names, chapter);
      if (!result?.resolvedTitle || !resolvedTitleMatchesAny(result.resolvedTitle, names)) {
        throw new Error('resolved title did not match the verified ComicK titles');
      }
      return {
        ...result,
        verifiedTitleMatch: true,
        catalogProvider: 'comick',
        catalogRequestId: String(id),
        catalogHid: String(comic.hid),
        catalogSlug: String(comic.slug || ''),
      };
    } catch (error) {
      const label = ['Weeb Central', 'MangaPill', 'MangaDex'][index] || `Resolver ${index + 1}`;
      errors.push(`${label}: ${error.message || String(error)}`);
    }
  }
  throw new Error(`No safe page resolver match (${errors.join('; ')})`);
}

function setPageResolversForTests(resolvers) {
  pageResolvers = Array.isArray(resolvers) ? resolvers : [getChapterPagesByTitle, getMangaPillPages, getMangaDexPages];
}

module.exports = {
  COMICK_API,
  searchManga,
  popularManga,
  getMangaDetails,
  getChapterPages,
  mangaSummary,
  comicIdentityMatches,
  assertComicIdentity,
  setRawFetcher,
  setPageResolversForTests,
};
