'use strict';
const { ALLANIME_API, USER_AGENT } = require('./config');
const { compareEpisodes, highestEpisode } = require('./episodes');
const {
  MKISSA_ORIGIN,
  CHAPTER_PAGES_QUERY,
  deriveKey,
  buildAaRequest,
  decryptAaResponse,
  extractClientCrypto,
  resolveCompleteCryptoConfig,
  discardCompleteConfig,
  markConfigVerified,
  formatCryptoFailure,
  resetMkissaCryptoForTests,
  candidateKey,
} = require('./mkissa-crypto');

const REFERER = 'https://allmanga.to/';
const SUMMARY_FIELDS = `
  _id name englishName nativeName thumbnail lastChapterInfo lastChapterDate
  chapterCount volumes type season score airedStart availableChapters lastUpdateEnd
  slugTime countryOfOrigin status averageScore airedEnd
`;
const POPULAR_FIELDS = `
  _id name englishName nativeName thumbnail lastChapterInfo lastChapterDate
  chapterCount type season score airedStart availableChapters lastUpdateEnd slugTime status averageScore
`;

async function fetchRaw(query, variables) {
  const response = await fetch(ALLANIME_API, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'user-agent': USER_AGENT,
      referer: REFERER,
      origin: REFERER.replace(/\/$/, ''),
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!response.ok) throw new Error(`AllManga API returned ${response.status}`);
  return response.json();
}

let rawFetcher = fetchRaw;

async function graphql(query, variables) {
  const result = await rawFetcher(query, variables);
  if (result.errors?.length) throw new Error(result.errors.map((error) => error.message).join('; '));
  return result.data;
}

function setRawFetcher(fetcher) {
  rawFetcher = fetcher || fetchRaw;
}

function resetMangaCryptoForTests() {
  resetMkissaCryptoForTests();
}

function deriveMangaKey(mask, partB) {
  return deriveKey(mask, partB);
}

function isAaCryptoError(result) {
  return (result?.errors || []).some((error) => {
    const code = String(error?.extensions?.code || error?.message || '');
    return code.startsWith('AA_CRYPTO');
  });
}

function aaCryptoCode(result) {
  const error = (result?.errors || []).find((item) => String(item?.extensions?.code || item?.message || '').startsWith('AA_CRYPTO'));
  return error?.extensions?.code || error?.message || 'AA_CRYPTO';
}

function aaRequest(query, config) {
  return buildAaRequest(query, config);
}

function decryptResponse(value, config) {
  return decryptAaResponse(value, config);
}

async function encryptedGraphql(query, variables) {
  const triedKeys = new Set();
  let lastError = null;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    let config;
    try {
      config = await resolveCompleteCryptoConfig({
        forceRefresh: attempt > 0,
        excludeKeys: triedKeys,
        allowLastVerifiedFallback: attempt === 0,
      });
    } catch (error) {
      lastError = new Error(formatCryptoFailure({ message: error.message }));
      break;
    }

    const key = config.candidateKey || candidateKey(config.maskHex, config.buildId);
    if (triedKeys.has(key)) {
      lastError = new Error(formatCryptoFailure({
        message: 'AllManga chapter crypto exhausted unique candidates',
        epoch: config.epoch,
        buildId: config.buildId,
      }));
      break;
    }
    triedKeys.add(key);

    const response = await fetch(ALLANIME_API, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': USER_AGENT,
        referer: `${MKISSA_ORIGIN}/`,
        origin: MKISSA_ORIGIN,
        'x-build-id': config.buildId,
      },
      body: JSON.stringify({ query, variables, extensions: { aaReq: aaRequest(query, config) } }),
    });
    if (!response.ok) throw new Error(`AllManga chapter API returned ${response.status}`);
    const result = await response.json();
    if (isAaCryptoError(result)) {
      discardCompleteConfig(config);
      lastError = new Error(formatCryptoFailure({
        message: result.errors.map((error) => error.message).join('; '),
        code: aaCryptoCode(result),
        epoch: config.epoch,
        buildId: config.buildId,
      }));
      continue;
    }
    if (result.errors?.length) throw new Error(result.errors.map((error) => error.message).join('; '));
    let data;
    try {
      data = result.data?.tobeparsed ? decryptResponse(result.data.tobeparsed, config) : result.data;
    } catch (error) {
      discardCompleteConfig(config);
      lastError = new Error(formatCryptoFailure({
        message: `AllManga response decryption failed: ${error.message}`,
        epoch: config.epoch,
        buildId: config.buildId,
      }));
      continue;
    }
    markConfigVerified(config);
    return data;
  }

  throw lastError || new Error('AllManga chapter crypto failed');
}

function preferredName(manga) {
  return manga.englishName || manga.name || manga.nativeName || 'Untitled manga';
}

function coverUrl(value) {
  if (!value) return '';
  if (/^https?:\/\//i.test(value)) return value;
  return `https://aln.youtube-anime.com/${String(value).replace(/^\/+/, '')}`;
}

function chapterList(manga, language = 'sub') {
  return Array.from(new Set((manga.availableChaptersDetail?.[language] || []).map(String)))
    .sort(compareEpisodes);
}

function mangaSummary(manga, language = 'sub') {
  const available = Number(manga.availableChapters?.[language] || 0);
  const latest = manga.lastChapterInfo?.[language]?.chapterString || null;
  return {
    id: manga._id,
    name: preferredName(manga),
    sourceName: manga.name || '',
    englishName: manga.englishName || '',
    nativeName: manga.nativeName || '',
    thumbnail: coverUrl(manga.thumbnail),
    language,
    chapterCounts: {
      sub: Number(manga.availableChapters?.sub || 0),
      raw: Number(manga.availableChapters?.raw || 0),
    },
    latestChapters: {
      sub: manga.lastChapterInfo?.sub?.chapterString || null,
      raw: manga.lastChapterInfo?.raw?.chapterString || null,
    },
    lastChapterDates: {
      sub: manga.lastChapterDate?.sub || null,
      raw: manga.lastChapterDate?.raw || null,
    },
    chapterCount: available || Number(manga.chapterCount || 0),
    latestChapter: latest,
    lastChapterDate: manga.lastChapterDate?.[language] || null,
    score: manga.averageScore || manga.score || null,
    type: manga.type || 'Manga',
    status: manga.status || '',
    airedStart: manga.airedStart || null,
    airedEnd: manga.airedEnd || null,
    season: manga.season || null,
    countryOfOrigin: manga.countryOfOrigin || '',
    title: `${preferredName(manga)} (${available || manga.chapterCount || '?'} chapters)`,
  };
}

async function searchManga(search = '', {
  page = 1,
  limit = 30,
  language = 'sub',
  sortBy = 'Latest_Update',
  genres = [],
  year = null,
} = {}) {
  const query = `query($search: SearchInput $limit: Int $page: Int $translationType: VaildTranslationTypeMangaEnumType $countryOrigin: VaildCountryOriginEnumType) {
    mangas(search: $search limit: $limit page: $page translationType: $translationType countryOrigin: $countryOrigin) {
      pageInfo { total }
      edges { ${SUMMARY_FIELDS} }
    }
  }`;
  const input = {
    allowAdult: false,
    allowUnknown: false,
    sortBy,
    sortDirection: 'DSC',
    isManga: true,
  };
  if (String(search).trim()) input.query = String(search).trim();
  if (genres.length) {
    input.genres = genres;
    input.includeGenres = true;
  }
  if (Number.isInteger(Number(year)) && Number(year) > 0) input.year = Number(year);
  const data = await graphql(query, {
    search: input,
    limit,
    page,
    translationType: language,
    countryOrigin: 'ALL',
  });
  return {
    total: Number(data?.mangas?.pageInfo?.total || 0),
    results: (data?.mangas?.edges || []).filter((item) => item?._id).map((item) => mangaSummary(item, language)),
  };
}

async function popularManga(range = 0, { limit = 30, language = 'sub' } = {}) {
  const query = `query($type: VaildPopularTypeEnumType! $size: Int! $dateRange: Int) {
    queryPopular(type: $type size: $size dateRange: $dateRange allowAdult: false allowUnknown: false) {
      total recommendations { isManga anyCard { ${POPULAR_FIELDS} } }
    }
  }`;
  const data = await graphql(query, { type: 'manga', size: limit, dateRange: Number(range) || 0 });
  const recommendations = data?.queryPopular?.recommendations || [];
  return {
    total: Number(data?.queryPopular?.total || recommendations.length),
    results: recommendations.filter((item) => item?.isManga !== false && item?.anyCard?._id).map((item) => mangaSummary(item.anyCard, language)),
  };
}

async function getMangaDetails(id, language = 'sub') {
  const query = `query($_id: String!) {
    manga(_id: $_id) {
      ${SUMMARY_FIELDS}
      description thumbnails authors genres altNames rating banner magazine
      availableChaptersDetail nameOnlyString relatedMangas isAdult tags
    }
  }`;
  const data = await graphql(query, { _id: id });
  const manga = data?.manga;
  if (!manga?._id) throw new Error('Manga not found');
  const chapters = chapterList(manga, language);
  const relations = await getRelatedMangas(manga.relatedMangas || [], language);
  return {
    ...mangaSummary(manga, language),
    description: manga.description || '',
    thumbnails: (manga.thumbnails || []).map(coverUrl),
    authors: manga.authors || [],
    genres: manga.genres || [],
    status: manga.status || '',
    airedEnd: manga.airedEnd || null,
    magazine: manga.magazine || '',
    tags: manga.tags || [],
    relations,
    chapters,
    latestChapter: highestEpisode(chapters) || manga.lastChapterInfo?.[language]?.chapterString || null,
  };
}

async function getRelatedMangas(rawRelations, language) {
  const relations = rawRelations
    .filter((item) => item?.mangaId)
    .filter((item, index, items) => items.findIndex((candidate) => candidate.mangaId === item.mangaId) === index)
    .sort((a, b) => relationPriority(a.relation) - relationPriority(b.relation))
    .slice(0, 6);
  if (!relations.length) return [];
  const fields = relations.map((item, index) => `r${index}: manga(_id: ${JSON.stringify(item.mangaId)}) { ${SUMMARY_FIELDS} }`).join('\n');
  try {
    const result = await rawFetcher(`query { ${fields} }`, {});
    const related = result.data || {};
    return relations.flatMap((relation, index) => {
      const manga = related?.[`r${index}`];
      return manga?._id
        ? [{ ...mangaSummary(manga, language), relation: relation.relation || 'related' }]
        : [{ id: relation.mangaId, name: 'Related manga', relation: relation.relation || 'related', language }];
    });
  } catch {
    return relations.map((item) => ({ id: item.mangaId, name: 'Related manga', relation: item.relation || 'related', language }));
  }
}

function relationPriority(value) {
  const relation = String(value || '').toLowerCase();
  if (relation.includes('sequel')) return 0;
  if (relation.includes('prequel') || relation.includes('preserialization')) return 1;
  if (relation.includes('side')) return 2;
  if (relation.includes('spin')) return 3;
  return 4;
}

function absolutePageUrl(head, value) {
  if (!value) return '';
  if (/^https?:\/\//i.test(value)) return value;
  return `${String(head || 'https://aln.youtube-anime.com/').replace(/\/?$/, '/')}${String(value).replace(/^\/+/, '')}`;
}

async function getChapterPages(id, chapter, language = 'sub') {
  const data = await encryptedGraphql(CHAPTER_PAGES_QUERY, {
    mangaId: id,
    translationType: language,
    chapterString: String(chapter),
    page: 1,
    limit: 20,
    offset: 0,
  });
  const sources = (data?.chapterPages?.edges || []).filter((source) => Array.isArray(source.pictureUrls) && source.pictureUrls.length);
  const source = sources.sort((a, b) => Number(b.priority || 0) - Number(a.priority || 0))[0];
  if (!source) throw new Error('No readable pages found for this chapter');
  const pages = source.pictureUrls
    .map((page, index) => ({ number: Number(page.num || index + 1), url: absolutePageUrl(page.pictureHead || source.pictureUrlHead, page.url) }))
    .filter((page) => page.url)
    .sort((a, b) => a.number - b.number);
  return { pages, notes: source.notes || '', sourceName: source.sourceName || '', uploadDate: source.uploadDate || null };
}

module.exports = {
  searchManga,
  popularManga,
  getMangaDetails,
  getChapterPages,
  mangaSummary,
  coverUrl,
  setRawFetcher,
  deriveMangaKey,
  extractClientCrypto,
  aaRequest,
  encryptedGraphql,
  resetMangaCryptoForTests,
};
