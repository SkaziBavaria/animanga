'use strict';

const API_URL = 'https://graphql.anilist.co';
const { normalizeEpisode } = require('./episodes');
const CACHE_TTL_MS = 15 * 60_000;
const cache = new Map();
let fetcher = globalThis.fetch.bind(globalThis);

const QUERY = `
  query ($search: String!) {
    Page(page: 1, perPage: 10) {
      media(search: $search, type: ANIME) {
        id
        type
        format
        status
        episodes
        description
        genres
        coverImage { large }
        streamingEpisodes { title }
        startDate { year month day }
        endDate { year month day }
        title { romaji english native }
        synonyms
        relations {
          edges {
            relationType
            node {
              id
              type
              format
              title { romaji english native }
              coverImage { large }
              synonyms
              status
              episodes
              startDate { year month day }
              endDate { year month day }
            }
          }
        }
      }
    }
  }
`;

function normalizeAnimeTitle(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/\b(\d+)(?:st|nd|rd|th)\b/g, '$1')
    .replace(/\b(first|one)\b/g, '1')
    .replace(/\b(second|two)\b/g, '2')
    .replace(/\b(third|three)\b/g, '3')
    .replace(/\b(fourth|four)\b/g, '4')
    .replace(/\b(?:season|cour|part)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function mediaTitleValues(media) {
  return [
    media?.title?.english,
    media?.title?.romaji,
    media?.title?.native,
    ...(Array.isArray(media?.synonyms) ? media.synonyms : []),
  ].map((value) => String(value || '').trim()).filter(Boolean);
}

function mediaTitles(media) {
  return mediaTitleValues(media).map(normalizeAnimeTitle).filter(Boolean);
}

function exactTitleMatch(leftTitles, rightTitles) {
  const right = new Set(rightTitles);
  return leftTitles.some((title) => right.has(title));
}

function dateRange(date) {
  if (!Number(date?.year)) return null;
  return {
    year: Number(date.year),
    month: Number(date.month) ? Number(date.month) - 1 : 0,
    date: Number(date.day) || 1,
  };
}


function parseStreamingEpisodeTitles(streamingEpisodes = []) {
  const titles = {};
  const conflicts = new Set();
  for (const item of streamingEpisodes) {
    const raw = String(item?.title || '').trim();
    const match = raw.match(/^(?:episode|ep\.?|#)\s*#?(\d+(?:\.\d+)?)\s*[-:|?]\s*(.+)$/i)
      || raw.match(/^(\d+(?:\.\d+)?)\s*[-:|?]\s*(.+)$/);
    if (!match) continue;
    const number = normalizeEpisode(match[1]);
    const title = String(match[2] || '').replace(/\s+/g, ' ').trim();
    if (!number || !title || /^episode\s*\d+(?:\.\d+)?$/i.test(title) || conflicts.has(number)) continue;
    if (titles[number] && titles[number] !== title) {
      delete titles[number];
      conflicts.add(number);
      continue;
    }
    titles[number] = title;
  }
  return titles;
}

async function fetchRelations(parentTitle) {
  const key = normalizeAnimeTitle(parentTitle);
  if (!key) return null;
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const pending = Promise.resolve().then(async () => {
    const response = await fetcher(API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'user-agent': 'AniManga',
      },
      body: JSON.stringify({ query: QUERY, variables: { search: parentTitle } }),
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new Error(`AniList HTTP ${response.status}`);
    const payload = await response.json();
    if (Array.isArray(payload.errors) && payload.errors.length) throw new Error('AniList query failed');
    const matches = payload.data?.Page?.media || [];
    const queryTitles = [key];
    const parent = matches.find((media) => exactTitleMatch(mediaTitles(media), queryTitles));
    return parent ? { media: parent, edges: parent.relations?.edges || [] } : null;
  });
  const entry = { expiresAt: Date.now() + CACHE_TTL_MS, value: pending };
  cache.set(key, entry);
  while (cache.size > 128) cache.delete(cache.keys().next().value);
  try {
    return await pending;
  } catch (error) {
    if (cache.get(key) === entry) cache.delete(key);
    throw error;
  }
}

function enrichWithEdge(edge) {
  const node = edge.node;
  const relationType = String(edge.relationType || '').toUpperCase();
  const kind = relationType === 'SEQUEL' ? 'sequel'
    : relationType === 'PREQUEL' ? 'prequel' : 'related';
  const airedStart = dateRange(node.startDate);
  const airedEnd = dateRange(node.endDate);
  const titles = mediaTitleValues(node);
  const name = node.title?.english || node.title?.romaji || node.title?.native || titles[0] || '';
  return {
    id: 'anilist:' + node.id,
    anilistId: node.id,
    name,
    title: name,
    alternativeTitles: titles,
    relation: kind,
    type: node.type || '',
    format: node.format || '',
    playable: false,
    ...(node.coverImage?.large ? { thumbnail: node.coverImage.large } : {}),
    ...(airedStart ? { airedStart, anilistAiredStart: airedStart } : {}),
    ...(airedEnd ? { airedEnd, anilistAiredEnd: airedEnd } : {}),
    ...(node.status ? { anilistStatus: String(node.status).toUpperCase() } : {}),
    ...(Number(node.episodes) ? { anilistEpisodeCount: Number(node.episodes) } : {}),
  };
}

async function enrichAnimeRelations(parentTitle) {
  const found = await fetchRelations(parentTitle);
  if (!found) return null;
  const { media, edges } = found;
  const mediaStatus = String(media.status || '').toUpperCase();
  const mediaStart = dateRange(media.startDate);
  const mediaEnd = dateRange(media.endDate);
  const mediaTitles = mediaTitleValues(media);
  const canonicalTitle = media.title?.english || media.title?.romaji || media.title?.native || mediaTitles[0] || '';
  const relations = edges.filter((edge) => edge?.node?.id && edge.node.type === 'ANIME').map(enrichWithEdge);
  return {
    anilistRelationsVerified: true,
    anilistId: Number(media.id) || null,
    anilistTitle: canonicalTitle,
    anilistEnglishTitle: media.title?.english || '',
    anilistRomajiTitle: media.title?.romaji || '',
    anilistNativeTitle: media.title?.native || '',
    anilistDescription: String(media.description || ''),
    anilistType: String(media.type || 'ANIME'),
    anilistFormat: String(media.format || ''),
    anilistGenres: Array.isArray(media.genres) ? media.genres : [],
    anilistCoverImage: media.coverImage?.large || '',
    anilistEpisodeTitles: parseStreamingEpisodeTitles(media.streamingEpisodes),
    anilistStatus: mediaStatus,
    ...(mediaStart ? { anilistAiredStart: mediaStart } : {}),
    ...(mediaEnd ? { anilistAiredEnd: mediaEnd } : {}),
    ...(Number(media.episodes) ? { anilistEpisodeCount: Number(media.episodes) } : {}),
    relations,
    previousSeason: relations.find((item) => item.relation === 'prequel') || null,
    nextSeason: relations.find((item) => item.relation === 'sequel') || null,
  };
}

function setAniListFetcherForTests(value) {
  fetcher = typeof value === 'function' ? value : globalThis.fetch.bind(globalThis);
  cache.clear();
}

module.exports = { normalizeAnimeTitle, mediaTitleValues, parseStreamingEpisodeTitles, enrichAnimeRelations, setAniListFetcherForTests };
