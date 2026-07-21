'use strict';

const fs = require('fs');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { ALLANIME_API, ANI_CLI, USER_AGENT } = require('./config');
const { compareEpisodes, highestEpisode } = require('./episodes');

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
let cryptoConfig = null;

async function graphql(query, variables) {
  const result = await rawFetcher(query, variables);
  if (result.errors?.length) throw new Error(result.errors.map((error) => error.message).join('; '));
  return result.data;
}

function setRawFetcher(fetcher) {
  rawFetcher = fetcher || fetchRaw;
}

function installedAniCliSource() {
  const resolved = spawnSync('sh', ['-c', 'command -v "$1"', 'sh', ANI_CLI], { encoding: 'utf8' }).stdout.trim();
  if (!resolved) throw new Error('ani-cli is required for AllManga chapter decryption');
  return fs.readFileSync(resolved, 'utf8');
}

function mangaCryptoConfig() {
  if (cryptoConfig) return cryptoConfig;
  const source = installedAniCliSource();
  const match = (patterns, label) => {
    const value = patterns.map((pattern) => source.match(pattern)?.[1]).find(Boolean);
    if (!value) throw new Error(`ani-cli is missing ${label}`);
    return value;
  };
  cryptoConfig = {
    key: match([/^allanime_key="([0-9a-f]{64})"$/m], 'AllAnime key'),
    epoch: Number(match([/^allanime_epoch=([0-9]+)$/m, /epoch:\s*([0-9]+)/], 'AllAnime epoch')),
    buildId: match([/^allanime_build_id=([0-9]+)$/m, /buildId:\s*['"]([0-9]+)['"]/], 'AllAnime build id'),
  };
  return cryptoConfig;
}

function aaRequest(query, config) {
  const qh = crypto.createHash('sha256').update(query).digest('hex');
  const ts = Math.floor(Date.now() / 300_000) * 300_000;
  const iv = crypto.createHash('sha256').update(`${config.epoch}:${config.buildId}:${qh}:${ts}`).digest().subarray(0, 12);
  const payload = JSON.stringify({ v: 1, ts, epoch: config.epoch, buildId: config.buildId, qh });
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(config.key, 'hex'), iv);
  return Buffer.concat([Buffer.from([1]), iv, cipher.update(payload), cipher.final(), cipher.getAuthTag()]).toString('base64');
}

function decryptResponse(value, config) {
  const bytes = Buffer.from(value, 'base64');
  const iv = bytes.subarray(1, 13);
  const ciphertext = bytes.subarray(13, -16);
  const tag = bytes.subarray(-16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(config.key, 'hex'), iv);
  decipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8'));
}

async function encryptedGraphql(query, variables) {
  const config = mangaCryptoConfig();
  const response = await fetch(ALLANIME_API, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'user-agent': USER_AGENT,
      referer: 'https://youtu-chan.com',
      origin: 'https://mkissa.to',
      'x-build-id': config.buildId,
    },
    body: JSON.stringify({ query, variables, extensions: { aaReq: aaRequest(query, config) } }),
  });
  if (!response.ok) throw new Error(`AllManga chapter API returned ${response.status}`);
  const result = await response.json();
  if (result.errors?.length) throw new Error(result.errors.map((error) => error.message).join('; '));
  return result.data?.tobeparsed ? decryptResponse(result.data.tobeparsed, config) : result.data;
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
  const query = 'query($mangaId:String!,$translationType:VaildTranslationTypeMangaEnumType!,$chapterString:String!,$page:Int,$limit:Int!,$offset:Int){chapterPages(mangaId:$mangaId translationType:$translationType chapterString:$chapterString page:$page limit:$limit offset:$offset){edges{streamerId sourceName chapterString pictureUrls pictureUrlsProcessed pictureUrlHead notes uploadDate sourceUrl priority versionFix} pageInfo{total} manga{_id name thumbnail availableChaptersDetail availableChapters}}}';
  const data = await encryptedGraphql(query, {
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

module.exports = { searchManga, popularManga, getMangaDetails, getChapterPages, mangaSummary, coverUrl, setRawFetcher };
