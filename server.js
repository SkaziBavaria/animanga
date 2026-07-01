#!/usr/bin/env node
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const JOB_LOG_DIR = path.join(DATA_DIR, 'job-logs');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const HOST = process.env.ANI_WEB_HOST || '127.0.0.1';
const PORT = Number(process.env.ANI_WEB_PORT || process.env.PORT || 7831);
const ANI_CLI = process.env.ANI_CLI_BIN || 'ani-cli';
const HISTORY_DIR = process.env.ANI_CLI_HIST_DIR || path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'ani-cli');
const HISTORY_FILE = path.join(HISTORY_DIR, 'ani-hsts');
const DOWNLOAD_DIR = path.resolve(process.env.ANI_CLI_DOWNLOAD_DIR || os.homedir());
const ALLANIME_BASE = process.env.ANI_WEB_ALLANIME_BASE || 'allanime.day';
const ALLANIME_API = `https://api.${ALLANIME_BASE}/api`;
const ALLANIME_REFERER = 'https://youtu-chan.com';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:150.0) Gecko/20100101 Firefox/150.0';
const MAX_BODY = 1024 * 1024;
const DETAIL_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const RECOMMENDATION_CACHE_TTL_MS = 45 * 60 * 1000;
const DOWNLOAD_CONCURRENCY = Math.max(1, Number(process.env.ANI_WEB_DOWNLOAD_CONCURRENCY || 2));
const jobs = new Map();
const downloadQueue = [];
let activeDownloads = 0;

ensureDataDir();

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(JOB_LOG_DIR, { recursive: true });
  fs.mkdirSync(HISTORY_DIR, { recursive: true });
  if (!fs.existsSync(HISTORY_FILE)) fs.writeFileSync(HISTORY_FILE, '');
  if (!fs.existsSync(STATE_FILE)) {
    writeJson(STATE_FILE, { shows: {}, settings: defaultSettings(), jobs: [] });
  }
}

function defaultSettings() {
  return {
    mode: 'sub',
    quality: 'best',
    player: 'android_mpv',
    skipIntro: false,
    autoTrackPlayed: true,
  };
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.writeFileSync(`${file}.tmp`, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(`${file}.tmp`, file);
}

function readState() {
  const state = readJson(STATE_FILE, {});
  state.shows ||= {};
  state.settings = { ...defaultSettings(), ...(state.settings || {}) };
  state.jobs ||= [];
  state.downloads ||= {};
  state.releaseWatches ||= {};
  state.cache ||= {};
  state.cache.details ||= {};
  state.cache.recommendations ||= {};
  return state;
}

function saveState(state) {
  state.jobs = recentJobs(Array.from(jobs.values()), state.jobs || []);
  writeJson(STATE_FILE, state);
}

function recentJobs(...groups) {
  const byId = new Map();
  for (const job of groups.flat()) {
    if (!job?.id || byId.has(job.id)) continue;
    byId.set(job.id, job);
  }
  return Array.from(byId.values())
    .sort((a, b) => Date.parse(b.startedAt || b.finishedAt || 0) - Date.parse(a.startedAt || a.finishedAt || 0))
    .slice(0, 30);
}

function cacheEntryFresh(entry, ttlMs) {
  return entry?.createdAt && Date.now() - Date.parse(entry.createdAt) < ttlMs;
}

function cacheGet(state, namespace, key, ttlMs) {
  const entry = state.cache?.[namespace]?.[key];
  return cacheEntryFresh(entry, ttlMs) ? entry.value : null;
}

function cacheSet(state, namespace, key, value) {
  state.cache ||= {};
  state.cache[namespace] ||= {};
  state.cache[namespace][key] = {
    value,
    createdAt: new Date().toISOString(),
  };
  return value;
}

function trimCache(state, namespace, maxEntries = 120) {
  const bucket = state.cache?.[namespace];
  if (!bucket) return;
  const entries = Object.entries(bucket)
    .sort((a, b) => Date.parse(b[1]?.createdAt || 0) - Date.parse(a[1]?.createdAt || 0));
  for (const [key] of entries.slice(maxEntries)) delete bucket[key];
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

function sendError(res, status, message, details) {
  sendJson(res, status, { error: message, details });
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error('Request body is too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

function cleanTitle(title) {
  return String(title || '').replace(/\s*\(\d+(?:\.\d+)? episodes?\)\s*$/i, '').trim();
}

function parseEpisodeCount(title) {
  const match = String(title || '').match(/\((\d+(?:\.\d+)?) episodes?\)/i);
  return match ? Number(match[1]) : null;
}

function preferredName(input = {}, fallback = {}) {
  return cleanTitle(
    input.customName ||
      fallback.customName ||
      input.englishName ||
      fallback.englishName ||
      input.displayName ||
      fallback.displayName ||
      input.name ||
      input.title ||
      fallback.name ||
      fallback.title ||
      fallback.sourceName ||
      ''
  );
}

function normalizeMode(mode) {
  return mode === 'dub' ? 'dub' : 'sub';
}

function normalizeEpisode(ep) {
  return String(ep || '').trim();
}

function episodeKey(ep) {
  return normalizeEpisode(ep);
}

function episodesThrough(episodes, target) {
  const targetValue = Number(target);
  if (!Number.isFinite(targetValue)) return [normalizeEpisode(target)].filter(Boolean);
  const sourceEpisodes = (episodes || []).length
    ? episodes
    : Array.from({ length: Math.max(0, Math.floor(targetValue)) }, (_, index) => String(index + 1));
  const selected = sourceEpisodes.filter((episode) => {
    const value = Number(episode);
    return Number.isFinite(value) && value <= targetValue;
  });
  const normalizedTarget = normalizeEpisode(target);
  if (normalizedTarget && !selected.includes(normalizedTarget)) selected.push(normalizedTarget);
  selected.sort(compareEpisodes);
  return selected;
}

function compareEpisodes(a, b) {
  const an = Number(a);
  const bn = Number(b);
  if (Number.isFinite(an) && Number.isFinite(bn)) return an - bn;
  return String(a).localeCompare(String(b), undefined, { numeric: true });
}

function highestEpisode(episodes) {
  return [...episodes].filter(Boolean).sort(compareEpisodes).at(-1) || null;
}

function downloadKey(showId, episode) {
  return `${showId}:${episodeKey(episode)}`;
}

function safeDownloadBase(value) {
  return String(value || '')
    .replace(/[\\/:*?"<>|]/g, '')
    .trim();
}

function expectedDownloadPath(show, episode) {
  const title = cleanTitle(show.sourceName || show.name || show.title || '');
  const cleanedTitle = safeDownloadBase(title.replace(/\([^)]*\)/g, '').replace(/[!"#$%&'()*+,./:;<=>?@[\\\]^_`{|}~-]/g, ''));
  const fallbackTitle = safeDownloadBase(title) || 'Anime';
  const base = cleanedTitle || fallbackTitle;
  return path.join(DOWNLOAD_DIR, `${base} Episode ${normalizeEpisode(episode)}.mp4`);
}

function isInsideDownloadDir(filePath) {
  const resolved = path.resolve(filePath);
  return resolved === DOWNLOAD_DIR || resolved.startsWith(`${DOWNLOAD_DIR}${path.sep}`);
}

function fileInfo(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return null;
    return {
      path: filePath,
      filename: path.basename(filePath),
      size: stat.size,
      updatedAt: stat.mtime.toISOString(),
    };
  } catch {
    return null;
  }
}

function sizeLabel(bytes) {
  if (!Number.isFinite(Number(bytes)) || Number(bytes) <= 0) return '';
  const mb = Number(bytes) / 1024 / 1024;
  return `${mb >= 10 ? Math.round(mb) : mb.toFixed(1)} MB`;
}

function parseDownloadProgress(record) {
  if (!record?.job?.logFile && !record?.logFile) return null;
  try {
    const logFile = record.job?.logFile || record.logFile;
    const output = stripAnsi(fs.readFileSync(logFile, 'utf8')).slice(-12000);
    const matches = [...output.matchAll(/\((\d{1,3}(?:\.\d+)?)%\)|\b(\d{1,3}(?:\.\d+)?)%/g)]
      .map((match) => Number(match[1] ?? match[2]))
      .filter((value) => Number.isFinite(value) && value >= 0 && value <= 100);
    if (!matches.length) return null;
    return Math.max(0, Math.min(100, matches.at(-1)));
  } catch {
    return null;
  }
}

function downloadStatus(record) {
  if (!record) return null;
  const job = jobs.get(record.jobId);
  const current = job || record.job || {};
  const file = fileInfo(record.filePath);
  let status = record.status || current.status || 'queued';
  if (file && status !== 'deleted') status = current.status === 'failed' ? 'failed' : 'done';
  if (current.status === 'running') status = 'running';
  if (!file && ['queued', 'running'].includes(status) && !job) status = 'unknown';
  return {
    ...record,
    status,
    progress: status === 'done' ? 100 : parseDownloadProgress({ ...record, job: current }),
    downloadedBytes: status === 'running' && file ? file.size : null,
    downloadedLabel: status === 'running' && file ? sizeLabel(file.size) : '',
    file: file || null,
    job: current.id ? current : null,
  };
}

function isDownloadBusy(status) {
  return status === 'queued' || status === 'running';
}

function refreshDownloadRecords(state) {
  state.downloads ||= {};
  for (const [key, record] of Object.entries(state.downloads)) {
    state.downloads[key] = downloadStatus(record);
  }
  return state.downloads;
}

function updateDownloadRecord(key, job) {
  const state = readState();
  const existing = state.downloads?.[key] || {};
  state.downloads ||= {};
  state.downloads[key] = downloadStatus({
    ...existing,
    job,
    status: job.status,
    finishedAt: job.finishedAt || existing.finishedAt,
    updatedAt: new Date().toISOString(),
  });
  saveState(state);
}

function createDownloadRecord(state, show, episode, mode, job) {
  const normalizedEpisode = normalizeEpisode(episode);
  const key = downloadKey(show.id, normalizedEpisode);
  state.downloads ||= {};
  state.downloads[key] = downloadStatus({
    key,
    showId: show.id,
    episode: normalizedEpisode,
    showName: show.name || show.title || '',
    mode,
    filePath: expectedDownloadPath(show, normalizedEpisode),
    jobId: job.id,
    job,
    status: job.status,
    startedAt: job.startedAt,
    updatedAt: new Date().toISOString(),
  });
  return state.downloads[key];
}

function cancelQueuedDownload(jobId) {
  const index = downloadQueue.findIndex((item) => item.job.id === jobId);
  if (index === -1) return false;
  const [item] = downloadQueue.splice(index, 1);
  item.cancelled = true;
  item.job.status = 'cancelled';
  item.job.finishedAt = new Date().toISOString();
  item.onUpdate?.(item.job);
  return true;
}

function cancelRunningDownload(jobId) {
  const job = jobs.get(jobId);
  if (!job || job.status !== 'running') return false;
  job.status = 'cancelled';
  job.finishedAt = new Date().toISOString();
  try {
    job.child?.kill('SIGTERM');
  } catch {}
  setTimeout(() => {
    try {
      if (job.child && !job.child.killed) job.child.kill('SIGKILL');
    } catch {}
  }, 1500);
  return true;
}

function removeDownloadFiles(record) {
  if (!record?.filePath || !isInsideDownloadDir(record.filePath)) return false;
  let removed = false;
  for (const filePath of [record.filePath, `${record.filePath}.aria2`]) {
    if (fs.existsSync(filePath)) {
      fs.rmSync(filePath, { force: true });
      removed = true;
    }
  }
  return removed;
}

function streamDownloadFile(req, res, filePath) {
  const stat = fs.statSync(filePath);
  const range = req.headers.range;
  const headers = {
    'content-type': 'video/mp4',
    'accept-ranges': 'bytes',
    'cache-control': 'no-store',
  };

  if (range) {
    const match = range.match(/bytes=(\d*)-(\d*)/);
    const start = match?.[1] ? Number(match[1]) : 0;
    const end = match?.[2] ? Number(match[2]) : stat.size - 1;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= stat.size) {
      res.writeHead(416, { 'content-range': `bytes */${stat.size}` });
      res.end();
      return;
    }
    res.writeHead(206, {
      ...headers,
      'content-length': end - start + 1,
      'content-range': `bytes ${start}-${end}/${stat.size}`,
    });
    fs.createReadStream(filePath, { start, end }).pipe(res);
    return;
  }

  res.writeHead(200, {
    ...headers,
    'content-length': stat.size,
  });
  fs.createReadStream(filePath).pipe(res);
}

function readHistory() {
  const text = fs.existsSync(HISTORY_FILE) ? fs.readFileSync(HISTORY_FILE, 'utf8') : '';
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [lastWatched, id, ...titleParts] = line.split('\t');
      const title = titleParts.join('\t');
      return {
        id,
        title,
        name: cleanTitle(title),
        lastWatched,
        episodeCount: parseEpisodeCount(title),
      };
    })
    .filter((entry) => entry.id && entry.title);
}

function writeHistoryEntry(show, episode) {
  const rows = readHistory().filter((row) => row.id !== show.id);
  const normalizedEpisode = normalizeEpisode(episode);
  if (!normalizedEpisode) {
    const body = rows.map((row) => `${row.lastWatched}\t${row.id}\t${row.title}`).join('\n');
    fs.writeFileSync(HISTORY_FILE, body ? `${body}\n` : '');
    return;
  }
  const count = show.latestEpisode || show.episodeCount || parseEpisodeCount(show.title);
  const titleName = preferredName(show) || cleanTitle(show.title || show.name);
  const title = count ? `${titleName} (${count} episodes)` : titleName;
  rows.push({ id: show.id, title, lastWatched: normalizedEpisode });
  const body = rows.map((row) => `${row.lastWatched}\t${row.id}\t${row.title}`).join('\n');
  fs.writeFileSync(HISTORY_FILE, body ? `${body}\n` : '');
}

function mergeShow(state, partial, options = {}) {
  if (!partial.id) throw new Error('Missing show id');
  const id = partial.id;
  const existing = state.shows[id] || {};
  const watchedEpisodes = options.replaceWatchedEpisodes
    ? Array.from(new Set(partial.watchedEpisodes || []))
    : Array.from(new Set([...(existing.watchedEpisodes || []), ...(partial.watchedEpisodes || [])]));
  watchedEpisodes.sort(compareEpisodes);
  state.shows[id] = {
    ...existing,
    ...partial,
    id,
    sourceName: partial.sourceName || existing.sourceName || cleanTitle(partial.name || partial.title || existing.name || existing.title || ''),
    name: preferredName(partial, existing),
    title: partial.title || existing.title || partial.name || existing.name || '',
    mode: normalizeMode(partial.mode || existing.mode || state.settings.mode),
    tracked: partial.tracked ?? existing.tracked ?? true,
    watchedEpisodes,
    updatedAt: new Date().toISOString(),
  };
  return state.shows[id];
}

function seedStateFromHistory(state) {
  for (const row of readHistory()) {
    const existing = state.shows[row.id] || {};
    const watchedEpisodes = new Set(existing.watchedEpisodes || []);
    if (row.lastWatched) watchedEpisodes.add(row.lastWatched);
    mergeShow(state, {
      id: row.id,
      title: row.title,
      sourceName: row.name,
      lastWatched: row.lastWatched,
      episodeCount: row.episodeCount,
      latestEpisode: existing.latestEpisode || row.episodeCount,
      tracked: existing.tracked ?? true,
      watchedEpisodes: Array.from(watchedEpisodes),
    });
  }
}

async function graphql(query, variables) {
  const response = await fetch(ALLANIME_API, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'user-agent': USER_AGENT,
      referer: ALLANIME_REFERER,
      origin: ALLANIME_REFERER,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!response.ok) throw new Error(`AllAnime API returned ${response.status}`);
  return processAllAnimeResponse(await response.text());
}

function processAllAnimeResponse(raw) {
  const parsed = JSON.parse(raw);
  if (!parsed.tobeparsed) return parsed;

  const key = crypto.createHash('sha256').update('Xot36i3lK3:v1').digest();
  const data = Buffer.from(parsed.tobeparsed, 'base64');
  const iv = data.subarray(1, 13);
  const payload = data.subarray(13, data.length - 16);
  const counter = Buffer.concat([iv, Buffer.from([0, 0, 0, 2])]);
  const decipher = crypto.createDecipheriv('aes-256-ctr', key, counter);
  const plain = Buffer.concat([decipher.update(payload), decipher.final()]).toString('utf8');
  return JSON.parse(plain);
}

async function searchAnime(query, mode = 'sub') {
  const q = String(query || '').trim();
  if (!q) return [];
  const searchQuery = 'query( $search: SearchInput $limit: Int $page: Int $translationType: VaildTranslationTypeEnumType $countryOrigin: VaildCountryOriginEnumType ) { shows( search: $search limit: $limit page: $page translationType: $translationType countryOrigin: $countryOrigin ) { edges { _id name englishName nativeName thumbnail banner thumbnails availableEpisodes relatedShows __typename } }}';
  const json = await graphql(searchQuery, {
    search: { allowAdult: false, allowUnknown: false, query: q },
    limit: 40,
    page: 1,
    translationType: normalizeMode(mode),
    countryOrigin: 'ALL',
  });
  const edges = json?.data?.shows?.edges || [];
  return edges
    .map((edge, index) => showSummary(edge, index, mode))
    .filter((show) => show.id && show.episodeCount);
}

async function popularAnime(range = '0', mode = 'sub') {
  const dateRange = Number(range);
  const popularQuery = 'query($type: VaildPopularTypeEnumType!, $size: Int!, $page: Int, $dateRange: Int) { queryPopular(type: $type, size: $size, page: $page, dateRange: $dateRange, allowAdult: false, allowUnknown: false, denyEcchi: true) { recommendations { anyCard { _id name englishName nativeName thumbnail banner thumbnails availableEpisodes episodeCount score popularity type status relatedShows } } } }';
  const json = await graphql(popularQuery, {
    type: 'anime',
    size: 40,
    page: 1,
    dateRange: Number.isFinite(dateRange) ? dateRange : 0,
  });
  const cards = (json?.data?.queryPopular?.recommendations || [])
    .map((item) => item.anyCard)
    .filter(Boolean);
  return cards
    .map((card, index) => showSummary(card, index, mode))
    .filter((show) => show.id && show.episodeCount);
}

function showSummary(edge, index, mode = 'sub') {
  const episodeCount = edge.availableEpisodes?.[normalizeMode(mode)] || edge.episodeCount || 0;
  const name = preferredName(edge);
  const relatedShows = normalizeRelatedShows(edge.relatedShows);
  return {
    index: index + 1,
    id: edge._id,
    name,
    sourceName: edge.name,
    englishName: edge.englishName,
    nativeName: edge.nativeName,
    thumbnail: edge.thumbnail || edge.thumbnails?.[0] || '',
    banner: edge.banner || '',
    thumbnails: edge.thumbnails || [],
    score: edge.score || null,
    popularity: edge.popularity || null,
    type: edge.type || '',
    status: edge.status || '',
    relatedShows,
    hasNextSeason: hasNextSeason(relatedShows),
    title: `${name} (${episodeCount} episodes)`,
    episodeCount,
    mode: normalizeMode(mode),
  };
}

async function getShowSummaryById(id, mode = 'sub') {
  const summaryQuery = 'query ($showId: String!) { show( _id: $showId ) { _id name englishName nativeName thumbnail banner thumbnails score type status availableEpisodes episodeCount franchiseKey franchiseName }}';
  const json = await graphql(summaryQuery, { showId: id });
  const show = json?.data?.show || {};
  const episodeCount = show.availableEpisodes?.[normalizeMode(mode)] || show.episodeCount || 0;
  const name = preferredName(show);
  return {
    id: show._id || id,
    name,
    sourceName: show.name,
    englishName: show.englishName,
    nativeName: show.nativeName,
    thumbnail: show.thumbnail || show.thumbnails?.[0] || '',
    banner: show.banner || '',
    thumbnails: show.thumbnails || [],
    score: show.score || null,
    type: show.type || '',
    status: show.status || '',
    franchiseKey: show.franchiseKey || '',
    franchiseName: show.franchiseName || '',
    title: episodeCount ? `${name} (${episodeCount} episodes)` : name,
    episodeCount,
    latestEpisode: episodeCount || null,
    mode: normalizeMode(mode),
  };
}

function normalizeRelatedShows(relatedShows) {
  const seen = new Set();
  return (Array.isArray(relatedShows) ? relatedShows : [])
    .map((relation) => ({
      relation: String(relation?.relation || 'related').trim() || 'related',
      showId: String(relation?.showId || '').trim(),
    }))
    .filter((relation) => {
      if (!relation.showId || seen.has(relation.showId)) return false;
      seen.add(relation.showId);
      return true;
    });
}

function hasNextSeason(relatedShows) {
  return normalizeRelatedShows(relatedShows).some((relation) => relation.relation.toLowerCase() === 'sequel');
}

async function getNextSeasonSummary(relatedShows, mode = 'sub') {
  const sequel = normalizeRelatedShows(relatedShows)
    .find((relation) => relation.relation.toLowerCase() === 'sequel');
  if (!sequel) return null;
  try {
    return {
      relation: sequel.relation,
      ...(await getShowSummaryById(sequel.showId, mode)),
    };
  } catch {
    return {
      relation: sequel.relation,
      id: sequel.showId,
      name: sequel.showId,
      title: sequel.showId,
      mode: normalizeMode(mode),
    };
  }
}

async function getRelatedShowSummaries(relatedShows, mode = 'sub') {
  const summaries = [];
  for (const relation of normalizeRelatedShows(relatedShows).slice(0, 10)) {
    try {
      summaries.push({
        relation: relation.relation,
        ...(await getShowSummaryById(relation.showId, mode)),
      });
    } catch {
      summaries.push({
        relation: relation.relation,
        id: relation.showId,
        name: relation.showId,
        title: relation.showId,
        mode: normalizeMode(mode),
      });
    }
  }
  return summaries;
}

async function getShowDetails(id, mode = 'sub', options = {}) {
  const episodesQuery = 'query ($showId: String!) { show( _id: $showId ) { _id name englishName nativeName thumbnail banner thumbnails description genres score type status availableEpisodes availableEpisodesDetail lastEpisodeInfo franchiseKey franchiseName relatedShows }}';
  const json = await graphql(episodesQuery, { showId: id });
  const show = json?.data?.show || {};
  const list = show.availableEpisodesDetail?.[normalizeMode(mode)] || [];
  const episodes = list.map(String).sort(compareEpisodes);
  const episodeCount = show.availableEpisodes?.[normalizeMode(mode)] || episodes.length;
  const name = preferredName(show);
  const lastInfo = show.lastEpisodeInfo?.[normalizeMode(mode)] || show.lastEpisodeInfo?.sub || show.lastEpisodeInfo?.raw || {};
  const episodeTitles = {};
  if (lastInfo.episodeString && lastInfo.notes) {
    episodeTitles[normalizeEpisode(lastInfo.episodeString)] = String(lastInfo.notes).split('<note-split>')[0].trim();
  }
  const details = {
    id,
    name,
    sourceName: show.name,
    englishName: show.englishName,
    nativeName: show.nativeName,
    thumbnail: show.thumbnail || show.thumbnails?.[0] || '',
    banner: show.banner || '',
    thumbnails: show.thumbnails || [],
    description: show.description || '',
    genres: show.genres || [],
    score: show.score || null,
    type: show.type || '',
    status: show.status || '',
    franchiseKey: show.franchiseKey || '',
    franchiseName: show.franchiseName || '',
    relatedShows: normalizeRelatedShows(show.relatedShows),
    title: `${name} (${episodeCount} episodes)`,
    episodeCount,
    episodeTitles,
    episodes,
    latestEpisode: highestEpisode(episodes),
  };
  if (options.includeRelations) {
    details.relations = await getRelatedShowSummaries(show.relatedShows, mode);
    details.nextSeason = details.relations.find((relation) => relation.relation.toLowerCase() === 'sequel') || null;
  } else if (options.includeNextSeason) {
    details.nextSeason = await getNextSeasonSummary(show.relatedShows, mode);
  }
  return details;
}

async function getCachedShowDetails(state, id, mode = 'sub', options = {}) {
  const flavor = options.includeRelations ? 'relations' : options.includeNextSeason ? 'next' : 'base';
  const key = `${normalizeMode(mode)}:${flavor}:${id}`;
  if (!options.force) {
    const cached = cacheGet(state, 'details', key, DETAIL_CACHE_TTL_MS);
    if (cached) return cached;
  }
  const details = await getShowDetails(id, mode, options);
  cacheSet(state, 'details', key, details);
  trimCache(state, 'details', 160);
  return details;
}

function genreWeights(shows) {
  const weights = new Map();
  for (const show of shows) {
    const progressBoost = Number(show.watchedCount || 0) > 0 || show.lastWatched ? 1 : 0;
    for (const genre of show.genres || []) {
      const key = String(genre || '').trim();
      if (!key) continue;
      weights.set(key, (weights.get(key) || 0) + 2 + progressBoost);
    }
  }
  return weights;
}

function recommendationScore(show, weights) {
  const matches = (show.genres || [])
    .map((genre) => ({ genre, weight: weights.get(genre) || 0 }))
    .filter((match) => match.weight > 0)
    .sort((a, b) => b.weight - a.weight);
  const score = matches.reduce((total, match) => total + match.weight, 0) + Number(show.score || 0) / 10;
  return {
    score,
    reason: matches.slice(0, 2).map((match) => match.genre).join(' + '),
  };
}

async function recommendedAnime(state, mode = 'sub') {
  const key = normalizeMode(mode);
  const cached = cacheGet(state, 'recommendations', key, RECOMMENDATION_CACHE_TTL_MS);
  if (cached) return cached;

  seedStateFromHistory(state);
  const tracked = Object.values(state.shows).filter((show) => show.tracked !== false);
  const trackedIds = new Set(tracked.map((show) => show.id));
  const libraryDetails = [];
  for (const show of tracked.slice(0, 30)) {
    try {
      libraryDetails.push({
        ...presentShow(show),
        ...(await getCachedShowDetails(state, show.id, show.mode || mode)),
      });
    } catch {
      libraryDetails.push(presentShow(show));
    }
  }

  const weights = genreWeights(libraryDetails);
  const candidateMap = new Map();
  for (const range of ['0', '1', '7', '30']) {
    const results = await popularAnime(range, mode);
    for (const result of results.slice(0, 16)) {
      if (!trackedIds.has(result.id) && !candidateMap.has(result.id)) candidateMap.set(result.id, result);
    }
  }

  const candidates = [];
  for (const candidate of Array.from(candidateMap.values()).slice(0, 48)) {
    try {
      candidates.push({
        ...candidate,
        ...(await getCachedShowDetails(state, candidate.id, mode)),
      });
    } catch {
      candidates.push(candidate);
    }
  }

  const ranked = candidates
    .map((candidate) => {
      const rankedCandidate = recommendationScore(candidate, weights);
      return {
        ...candidate,
        recommendationScore: rankedCandidate.score,
        recommendationReason: rankedCandidate.reason,
      };
    })
    .sort((a, b) => (b.recommendationScore - a.recommendationScore) || Number(b.score || 0) - Number(a.score || 0))
    .slice(0, 24)
    .map((candidate, index) => ({
      ...candidate,
      index: index + 1,
      recommendationReason: candidate.recommendationReason || 'Popular with anime viewers',
    }));

  cacheSet(state, 'recommendations', key, ranked);
  trimCache(state, 'recommendations', 8);
  return ranked;
}

function normalizeWatchQuery(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function releaseWatchId(query, mode) {
  return crypto.createHash('sha1').update(`${normalizeMode(mode)}:${normalizeWatchQuery(query).toLowerCase()}`).digest('hex').slice(0, 16);
}

function presentReleaseWatch(watch) {
  return {
    id: watch.id,
    query: watch.query,
    mode: normalizeMode(watch.mode),
    status: watch.status || 'watching',
    createdAt: watch.createdAt || null,
    updatedAt: watch.updatedAt || null,
    lastCheckedAt: watch.lastCheckedAt || null,
    foundAt: watch.foundAt || null,
    matchedShow: watch.matchedShow || null,
  };
}

function createReleaseWatch(state, query, mode = state.settings.mode) {
  const cleanQuery = normalizeWatchQuery(query);
  if (!cleanQuery) throw new Error('Missing search query');
  const normalizedMode = normalizeMode(mode);
  const id = releaseWatchId(cleanQuery, normalizedMode);
  const now = new Date().toISOString();
  const existing = state.releaseWatches[id] || {};
  state.releaseWatches[id] = {
    ...existing,
    id,
    query: existing.query || cleanQuery,
    mode: existing.mode || normalizedMode,
    status: existing.status || 'watching',
    createdAt: existing.createdAt || now,
    updatedAt: now,
  };
  return state.releaseWatches[id];
}

async function checkReleaseWatch(state, watch) {
  const now = new Date().toISOString();
  const results = await searchAnime(watch.query, watch.mode || state.settings.mode);
  const match = results[0] || null;
  state.releaseWatches[watch.id] = {
    ...watch,
    status: match ? 'found' : 'watching',
    matchedShow: match,
    foundAt: match ? (watch.foundAt || now) : null,
    lastCheckedAt: now,
    updatedAt: now,
  };
  return state.releaseWatches[watch.id];
}

async function refreshShow(state, show) {
  const details = await getCachedShowDetails(state, show.id, show.mode || state.settings.mode, {
    includeNextSeason: true,
    force: true,
  });
  const merged = mergeShow(state, {
    ...show,
    ...details,
    lastCheckedAt: new Date().toISOString(),
  });
  return presentShow(merged);
}

function presentShow(show) {
  const watched = new Set(show.watchedEpisodes || []);
  const latest = show.latestEpisode || show.episodeCount || null;
  const lastWatched = show.lastWatched || highestEpisode(show.watchedEpisodes || []);
  const relatedShows = normalizeRelatedShows(show.relatedShows);
  return {
    ...show,
    relatedShows,
    hasNextSeason: show.hasNextSeason ?? hasNextSeason(relatedShows),
    nextSeason: show.nextSeason || null,
    name: preferredName(show),
    lastWatched,
    latestEpisode: latest,
    newCount: latest && lastWatched ? Math.max(0, Math.floor(Number(latest) - Number(lastWatched))) : 0,
    watchedCount: watched.size,
    canContinue: Boolean(latest),
  };
}

function commandExists(cmd) {
  return spawnSync('sh', ['-c', 'command -v "$1" >/dev/null 2>&1', 'sh', cmd], { encoding: 'utf8' }).status === 0;
}

function stripAnsi(value) {
  return String(value || '').replace(/\x1b\[[0-9;]*m/g, '');
}

function parseDebugPlayback(output) {
  const text = stripAnsi(output);
  const selected = text.match(/Selected link:\s*\n([^\s]+)/);
  const url = selected?.[1]?.trim();
  if (!url) throw new Error('ani-cli did not find a playable link');

  const linkLine = text
    .split(/\r?\n/)
    .find((line) => line.includes(`>${url}`) || line.endsWith(url)) || '';
  let referrer = ALLANIME_REFERER;
  if (/mp4upload/i.test(linkLine)) referrer = 'https://www.mp4upload.com';
  if (/sharepoint/i.test(linkLine)) referrer = '';

  return { url, referrer };
}

async function buildAniCliArgs(payload) {
  const state = readState();
  const mode = normalizeMode(payload.mode || state.settings.mode);
  const queryTitle = cleanTitle(payload.sourceName || payload.englishName || payload.title || payload.name);
  if (!queryTitle) throw new Error('Missing title');

  let index = Number(payload.index || 0);
  if (!index && payload.id) {
    const results = await searchAnime(queryTitle, mode);
    const found = results.find((item) => item.id === payload.id);
    if (!found) throw new Error('Could not find the anime in the ani-cli search right now');
    index = found.index;
  }
  if (!index) index = 1;

  const args = [];
  if (mode === 'dub') args.push('--dub');
  if (payload.quality) args.push('-q', String(payload.quality));
  if (payload.player === 'vlc') args.push('--vlc');
  if (payload.skipIntro) args.push('--skip');
  if (payload.download) args.push('--download');
  args.push('-S', String(index));
  if (payload.episode) args.push('-e', normalizeEpisode(payload.episode));
  args.push(queryTitle);
  return args;
}

function startJob(label, args, envPatch = {}, wait = false) {
  const id = crypto.randomUUID();
  const job = {
    id,
    label,
    args,
    status: 'running',
    output: '',
    startedAt: new Date().toISOString(),
  };
  jobs.set(id, job);

  const child = spawn(ANI_CLI, args, {
    cwd: os.homedir(),
    env: { ...process.env, ANI_CLI_EXTERNAL_MENU: '0', ...envPatch },
    stdio: wait ? ['ignore', 'pipe', 'pipe'] : 'ignore',
    detached: !wait,
  });

  job.pid = child.pid;
  child.on('error', (err) => {
    job.status = 'failed';
    job.error = err.message;
    job.finishedAt = new Date().toISOString();
  });

  if (!wait) {
    child.unref();
    job.status = 'launched';
    job.finishedAt = new Date().toISOString();
    return job;
  }

  const append = (chunk) => {
    job.output = `${job.output}${chunk.toString('utf8')}`.slice(-16000);
  };
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  child.on('close', (code, signal) => {
    job.status = code === 0 ? 'done' : 'failed';
    job.exitCode = code;
    job.signal = signal;
    job.finishedAt = new Date().toISOString();
  });
  return job;
}

function startPtyJob(label, args, envPatch = {}) {
  const id = crypto.randomUUID();
  const logFile = path.join(JOB_LOG_DIR, `${id}.log`);
  const job = {
    id,
    label,
    args,
    status: 'running',
    output: 'Starting ani-cli in a pseudo-terminal via script',
    logFile,
    startedAt: new Date().toISOString(),
  };
  jobs.set(id, job);

  const child = spawn('timeout', ['-k', '5', '45', 'script', '-q', '-e', '-O', logFile, '--', ANI_CLI, ...args], {
    cwd: os.homedir(),
    env: { ...process.env, ANI_CLI_EXTERNAL_MENU: '0', ...envPatch },
    stdio: 'ignore',
    detached: true,
  });

  job.pid = child.pid;
  child.on('error', (err) => {
    job.status = 'failed';
    job.error = err.message;
    job.finishedAt = new Date().toISOString();
  });
  child.unref();
  job.status = 'launched';
  job.finishedAt = new Date().toISOString();
  return job;
}

function startBackgroundJob(label, args, envPatch = {}, onUpdate = null) {
  const id = crypto.randomUUID();
  const logFile = path.join(JOB_LOG_DIR, `${id}.log`);
  const job = {
    id,
    label,
    args,
    status: 'queued',
    output: 'Queued for download',
    logFile,
    queuedAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
  };
  jobs.set(id, job);
  downloadQueue.push({ job, args, envPatch, onUpdate, cancelled: false });
  setImmediate(processDownloadQueue);
  return job;
}

function processDownloadQueue() {
  while (activeDownloads < DOWNLOAD_CONCURRENCY && downloadQueue.length) {
    activeDownloads += 1;
    runBackgroundJob(downloadQueue.shift());
  }
}

function runBackgroundJob(item) {
  const { job, args, envPatch, onUpdate } = item;
  if (item.cancelled || job.status === 'cancelled') {
    onUpdate?.(job);
    return;
  }
  job.status = 'running';
  job.output = 'Download running';
  job.runStartedAt = new Date().toISOString();
  onUpdate?.(job);

  fs.writeFileSync(job.logFile, `${job.output}\n`, { flag: 'a' });
  const usePtyLog = commandExists('script');
  const output = usePtyLog ? null : fs.openSync(job.logFile, 'a');
  const child = usePtyLog
    ? spawn('script', ['-q', '-e', '-O', job.logFile, '--', ANI_CLI, ...args], {
      cwd: os.homedir(),
      env: { ...process.env, ANI_CLI_EXTERNAL_MENU: '0', ...envPatch },
      stdio: 'ignore',
    })
    : spawn(ANI_CLI, args, {
      cwd: os.homedir(),
      env: { ...process.env, ANI_CLI_EXTERNAL_MENU: '0', ...envPatch },
      stdio: ['ignore', output, output],
    });

  job.pid = child.pid;
  job.child = child;
  let outputClosed = false;
  let finished = false;
  const closeOutput = () => {
    if (outputClosed) return;
    outputClosed = true;
    if (output !== null) fs.closeSync(output);
  };
  const finish = () => {
    if (finished) return;
    finished = true;
    activeDownloads = Math.max(0, activeDownloads - 1);
    processDownloadQueue();
  };
  child.on('error', (err) => {
    closeOutput();
    job.status = 'failed';
    job.error = err.message;
    job.finishedAt = new Date().toISOString();
    onUpdate?.(job);
    finish();
  });
  child.on('close', (code, signal) => {
    closeOutput();
    job.status = job.status === 'cancelled' ? 'cancelled' : code === 0 ? 'done' : 'failed';
    job.exitCode = code;
    job.signal = signal;
    job.finishedAt = new Date().toISOString();
    onUpdate?.(job);
    finish();
  });
}

function hydrateJobLog(job) {
  if (!job?.logFile) return job;
  try {
    const output = fs.readFileSync(job.logFile, 'utf8');
    return {
      ...job,
      output: `${job.output || ''}${output ? `\n${output}` : ''}`.slice(-16000),
    };
  } catch {
    return job;
  }
}

function clearJobLogs() {
  const entries = fs.readdirSync(JOB_LOG_DIR, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    fs.rmSync(path.join(JOB_LOG_DIR, entry.name), { force: true });
  }
}

function runJobAndWait(label, args, envPatch = {}) {
  const id = crypto.randomUUID();
  const job = {
    id,
    label,
    args,
    status: 'running',
    output: '',
    startedAt: new Date().toISOString(),
  };
  jobs.set(id, job);

  return new Promise((resolve) => {
    const child = spawn(ANI_CLI, args, {
      cwd: os.homedir(),
      env: { ...process.env, ANI_CLI_EXTERNAL_MENU: '0', ...envPatch },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    job.pid = child.pid;
    const append = (chunk) => {
      job.output = `${job.output}${chunk.toString('utf8')}`.slice(-16000);
    };

    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.on('error', (err) => {
      job.status = 'failed';
      job.error = err.message;
      job.finishedAt = new Date().toISOString();
      resolve(job);
    });
    child.on('close', (code, signal) => {
      job.status = code === 0 ? 'done' : 'failed';
      job.exitCode = code;
      job.signal = signal;
      job.finishedAt = new Date().toISOString();
      resolve(job);
    });
  });
}

function parseArgsLine(input) {
  const args = [];
  let current = '';
  let quote = '';
  let escaped = false;
  for (const char of String(input || '')) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = '';
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        args.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }
  if (current) args.push(current);
  if (quote) throw new Error('Unclosed quote');
  return args;
}

async function handleApi(req, res, url) {
  try {
    if (req.method === 'GET' && url.pathname === '/api/status') {
      const version = spawnSync(ANI_CLI, ['--version'], { encoding: 'utf8' });
      return sendJson(res, 200, {
        ok: true,
        aniCli: ANI_CLI,
        aniCliVersion: version.stdout.trim() || null,
        historyFile: HISTORY_FILE,
        host: HOST,
        port: PORT,
        deps: {
          node: process.version,
          aniCli: version.status === 0,
          mpv: commandExists('mpv'),
          androidActivityManager: commandExists('am'),
        },
      });
    }

    if (req.method === 'GET' && url.pathname === '/api/settings') {
      return sendJson(res, 200, readState().settings);
    }

    if (req.method === 'POST' && url.pathname === '/api/settings') {
      const body = await readBody(req);
      const state = readState();
      state.settings = { ...state.settings, ...body };
      saveState(state);
      return sendJson(res, 200, state.settings);
    }

    if (req.method === 'GET' && url.pathname === '/api/library') {
      const state = readState();
      seedStateFromHistory(state);
      const refresh = url.searchParams.get('refresh') === '1';
      let shows = Object.values(state.shows).filter((show) => show.tracked !== false);
      if (refresh) {
        const refreshed = [];
        for (const show of shows) {
          try {
            refreshed.push(await refreshShow(state, show));
          } catch (err) {
            refreshed.push({ ...presentShow(show), refreshError: err.message });
          }
        }
        saveState(state);
        shows = refreshed;
      } else {
        shows = shows.map(presentShow);
      }
      shows.sort((a, b) => (b.newCount - a.newCount) || String(a.name).localeCompare(String(b.name)));
      return sendJson(res, 200, { shows });
    }

    if (req.method === 'GET' && url.pathname === '/api/search') {
      const results = await searchAnime(url.searchParams.get('q'), url.searchParams.get('mode') || readState().settings.mode);
      return sendJson(res, 200, { results });
    }

    if (req.method === 'GET' && url.pathname === '/api/popular') {
      const mode = url.searchParams.get('mode') || readState().settings.mode;
      const range = url.searchParams.get('range') || '0';
      const results = await popularAnime(range, mode);
      return sendJson(res, 200, { results });
    }

    if (req.method === 'GET' && url.pathname === '/api/recommendations') {
      const state = readState();
      const mode = url.searchParams.get('mode') || state.settings.mode;
      const results = await recommendedAnime(state, mode);
      saveState(state);
      return sendJson(res, 200, { results });
    }

    if (req.method === 'GET' && url.pathname === '/api/release-watches') {
      const state = readState();
      const watches = Object.values(state.releaseWatches)
        .map(presentReleaseWatch)
        .sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')));
      return sendJson(res, 200, { watches });
    }

    if (req.method === 'POST' && url.pathname === '/api/release-watches') {
      const body = await readBody(req);
      const state = readState();
      const watch = createReleaseWatch(state, body.query, body.mode || state.settings.mode);
      saveState(state);
      return sendJson(res, 200, { watch: presentReleaseWatch(watch) });
    }

    if (req.method === 'POST' && url.pathname === '/api/release-watches/check') {
      const state = readState();
      const watches = Object.values(state.releaseWatches || {});
      const checked = [];
      for (const watch of watches) {
        checked.push(await checkReleaseWatch(state, watch));
      }
      saveState(state);
      return sendJson(res, 200, {
        watches: checked.map(presentReleaseWatch),
        found: checked.filter((watch) => watch.status === 'found').map(presentReleaseWatch),
      });
    }

    const releaseWatchMatch = url.pathname.match(/^\/api\/release-watches\/([^/]+)$/);
    if (req.method === 'DELETE' && releaseWatchMatch) {
      const id = decodeURIComponent(releaseWatchMatch[1]);
      const state = readState();
      if (!state.releaseWatches[id]) return sendError(res, 404, 'Release watch not found');
      delete state.releaseWatches[id];
      saveState(state);
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === 'GET' && url.pathname === '/api/downloads') {
      const state = readState();
      const downloads = refreshDownloadRecords(state);
      saveState(state);
      return sendJson(res, 200, {
        downloadDir: DOWNLOAD_DIR,
        downloads: Object.fromEntries(Object.entries(downloads).map(([key, record]) => [key, downloadStatus(record)])),
      });
    }

    const episodeMatch = url.pathname.match(/^\/api\/shows\/([^/]+)\/episodes$/);
    if (req.method === 'GET' && episodeMatch) {
      const id = decodeURIComponent(episodeMatch[1]);
      const mode = url.searchParams.get('mode') || readState().settings.mode;
      const details = await getShowDetails(id, mode);
      const episodes = details.episodes;
      const state = readState();
      if (state.shows[id]) {
        mergeShow(state, {
          ...state.shows[id],
          ...details,
          lastCheckedAt: new Date().toISOString(),
        });
        saveState(state);
      }
      return sendJson(res, 200, { ...details, episodes, latestEpisode: highestEpisode(episodes) });
    }

    const detailsMatch = url.pathname.match(/^\/api\/shows\/([^/]+)\/details$/);
    if (req.method === 'GET' && detailsMatch) {
      const id = decodeURIComponent(detailsMatch[1]);
      const mode = url.searchParams.get('mode') || readState().settings.mode;
      const state = readState();
      const details = await getCachedShowDetails(state, id, mode, { includeRelations: true });
      if (state.shows[id]) {
        mergeShow(state, {
          ...state.shows[id],
          ...details,
          lastCheckedAt: new Date().toISOString(),
        });
        saveState(state);
      }
      return sendJson(res, 200, { show: presentShow(details) });
    }

    if (req.method === 'POST' && url.pathname === '/api/track') {
      const body = await readBody(req);
      const state = readState();
      const show = mergeShow(state, { ...body, tracked: body.tracked ?? true });
      saveState(state);
      return sendJson(res, 200, { show: presentShow(show) });
    }

    const showMatch = url.pathname.match(/^\/api\/shows\/([^/]+)$/);
    if (req.method === 'DELETE' && showMatch) {
      const id = decodeURIComponent(showMatch[1]);
      const state = readState();
      const existing = state.shows[id] || { id };
      const show = mergeShow(state, { ...existing, id, tracked: false });
      saveState(state);
      return sendJson(res, 200, { show: presentShow(show) });
    }

    if (req.method === 'PATCH' && showMatch) {
      const id = decodeURIComponent(showMatch[1]);
      const body = await readBody(req);
      const state = readState();
      const existing = state.shows[id] || { id };
      const show = mergeShow(state, {
        ...existing,
        customName: body.name ? cleanTitle(body.name) : '',
      });
      saveState(state);
      return sendJson(res, 200, { show: presentShow(show) });
    }

    if (req.method === 'POST' && url.pathname === '/api/mark') {
      const body = await readBody(req);
      const state = readState();
      const existing = state.shows[body.id] || {};
      const watched = new Set(existing.watchedEpisodes || []);
      const ep = episodeKey(body.episode);
      if (!ep) throw new Error('Missing episode');
      if (body.watched === false) watched.delete(ep);
      else watched.add(ep);
      const lastWatched = highestEpisode(Array.from(watched)) || '';
      const show = mergeShow(state, {
        ...existing,
        ...body,
        watchedEpisodes: Array.from(watched),
        lastWatched,
        tracked: true,
      }, { replaceWatchedEpisodes: true });
      writeHistoryEntry(show, lastWatched);
      saveState(state);
      return sendJson(res, 200, { show: presentShow(show) });
    }

    if (req.method === 'POST' && url.pathname === '/api/mark-range') {
      const body = await readBody(req);
      const state = readState();
      const existing = state.shows[body.id] || {};
      const mode = normalizeMode(body.mode || existing.mode || state.settings.mode);
      const target = episodeKey(body.episode);
      if (!body.id) throw new Error('Missing show id');
      if (!target) throw new Error('Missing episode');
      const targetValue = Number(target);

      if (Number.isFinite(targetValue) && targetValue <= 0) {
        const watched = (existing.watchedEpisodes || []).filter((episode) => !Number.isFinite(Number(episode)));
        const show = mergeShow(state, {
          ...existing,
          ...body,
          mode,
          watchedEpisodes: watched,
          lastWatched: '',
          tracked: true,
        }, { replaceWatchedEpisodes: true });
        writeHistoryEntry(show, '');
        saveState(state);
        return sendJson(res, 200, { show: presentShow(show) });
      }

      let details = {};
      try {
        details = await getShowDetails(body.id, mode);
      } catch {
        details = { episodes: existing.episodes || [] };
      }

      const watched = new Set(
        (existing.watchedEpisodes || []).filter((episode) => !Number.isFinite(Number(episode)))
      );
      for (const episode of episodesThrough(details.episodes || existing.episodes || [], target)) {
        watched.add(episodeKey(episode));
      }

      const show = mergeShow(state, {
        ...existing,
        ...details,
        ...body,
        mode,
        watchedEpisodes: Array.from(watched),
        lastWatched: target,
        tracked: true,
      }, { replaceWatchedEpisodes: true });
      writeHistoryEntry(show, target);
      saveState(state);
      return sendJson(res, 200, { show: presentShow(show) });
    }

    if (req.method === 'POST' && url.pathname === '/api/download') {
      const body = await readBody(req);
      const state = readState();
      const mode = normalizeMode(body.mode || state.settings.mode);
      if (!body.id) throw new Error('Missing show id');
      if (!body.episode) throw new Error('Missing episode');

      const details = await getShowDetails(body.id, mode);
      if (!details.episodes.includes(normalizeEpisode(body.episode))) {
        return sendError(res, 422, `Episode ${body.episode} is not available yet`, {
          latestEpisode: details.latestEpisode,
          episodeCount: details.episodeCount,
        });
      }
      if (state.shows[body.id]) {
        mergeShow(state, { ...state.shows[body.id], ...details, lastCheckedAt: new Date().toISOString() });
      }

      const args = await buildAniCliArgs({
        ...body,
        ...details,
        mode,
        download: true,
        player: 'default',
        quality: body.quality || state.settings.quality,
      });
      const label = `Download ${details.name || body.title || body.name} ep ${body.episode}`;
      const key = downloadKey(body.id, body.episode);
      const job = startBackgroundJob(label, args, {}, (updatedJob) => updateDownloadRecord(key, updatedJob));
      createDownloadRecord(state, details, body.episode, mode, job);
      saveState(state);
      return sendJson(res, 200, { job, download: state.downloads[key] });
    }

    if (req.method === 'POST' && url.pathname === '/api/download-season') {
      const body = await readBody(req);
      const state = readState();
      const mode = normalizeMode(body.mode || state.settings.mode);
      if (!body.id) throw new Error('Missing show id');

      const details = await getShowDetails(body.id, mode);
      if (!details.episodes.length) throw new Error('No episodes found');
      if (state.shows[body.id]) {
        mergeShow(state, { ...state.shows[body.id], ...details, lastCheckedAt: new Date().toISOString() });
      }

      let index = Number(body.index || 0);
      if (!index) {
        const results = await searchAnime(details.sourceName || details.englishName || details.name, mode);
        index = results.find((item) => item.id === body.id)?.index || 1;
      }

      refreshDownloadRecords(state);
      const queued = [];
      for (const episode of details.episodes.sort(compareEpisodes)) {
        const key = downloadKey(body.id, episode);
        const existing = downloadStatus(state.downloads[key]);
        if (existing && ['queued', 'running', 'done'].includes(existing.status)) continue;
        const args = await buildAniCliArgs({
          ...body,
          ...details,
          episode,
          index,
          mode,
          download: true,
          player: 'default',
          quality: body.quality || state.settings.quality,
        });
        const label = `Download ${details.name || body.title || body.name} ep ${episode}`;
        const job = startBackgroundJob(label, args, {}, (updatedJob) => updateDownloadRecord(key, updatedJob));
        queued.push(createDownloadRecord(state, details, episode, mode, job));
      }
      saveState(state);
      return sendJson(res, 200, { queued, concurrency: DOWNLOAD_CONCURRENCY });
    }

    const downloadPlaybackMatch = url.pathname.match(/^\/api\/downloads\/([^/]+)\/([^/]+)\/playback$/);
    if (req.method === 'GET' && downloadPlaybackMatch) {
      const showId = decodeURIComponent(downloadPlaybackMatch[1]);
      const episode = decodeURIComponent(downloadPlaybackMatch[2]);
      const key = downloadKey(showId, episode);
      const state = readState();
      const existing = downloadStatus(state.downloads?.[key]);
      if (!existing || existing.status !== 'done' || !existing.file?.path) return sendError(res, 404, 'Downloaded episode not found');
      if (!isInsideDownloadDir(existing.file.path)) return sendError(res, 403, 'Download path is outside the download directory');
      return sendJson(res, 200, {
        playback: {
          local: true,
          url: `/api/downloads/${encodeURIComponent(showId)}/${encodeURIComponent(episode)}/file`,
          title: `${existing.showName || 'Video'} ep ${existing.episode}`,
        },
      });
    }

    const downloadFileMatch = url.pathname.match(/^\/api\/downloads\/([^/]+)\/([^/]+)\/file$/);
    if (req.method === 'GET' && downloadFileMatch) {
      const showId = decodeURIComponent(downloadFileMatch[1]);
      const episode = decodeURIComponent(downloadFileMatch[2]);
      const key = downloadKey(showId, episode);
      const state = readState();
      const existing = downloadStatus(state.downloads?.[key]);
      if (!existing || existing.status !== 'done' || !existing.file?.path) return sendError(res, 404, 'Downloaded episode not found');
      if (!isInsideDownloadDir(existing.file.path)) return sendError(res, 403, 'Download path is outside the download directory');
      return streamDownloadFile(req, res, existing.file.path);
    }

    const downloadMatch = url.pathname.match(/^\/api\/downloads\/([^/]+)\/([^/]+)$/);
    if (req.method === 'DELETE' && downloadMatch) {
      const showId = decodeURIComponent(downloadMatch[1]);
      const episode = decodeURIComponent(downloadMatch[2]);
      const key = downloadKey(showId, episode);
      const state = readState();
      const existing = downloadStatus(state.downloads?.[key]);
      if (!existing) return sendError(res, 404, 'Download not found');
      cancelQueuedDownload(existing.jobId);
      cancelRunningDownload(existing.jobId);
      removeDownloadFiles(existing);
      state.downloads[key] = {
        ...existing,
        status: 'deleted',
        file: null,
        deletedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      saveState(state);
      return sendJson(res, 200, { download: state.downloads[key] });
    }

    const downloadsShowMatch = url.pathname.match(/^\/api\/downloads\/([^/]+)$/);
    if (req.method === 'DELETE' && downloadsShowMatch) {
      const showId = decodeURIComponent(downloadsShowMatch[1]);
      const state = readState();
      refreshDownloadRecords(state);
      let deleted = 0;
      let cancelled = 0;
      for (const [key, record] of Object.entries(state.downloads || {})) {
        if (record.showId !== showId || record.status === 'deleted') continue;
        if (isDownloadBusy(record.status)) {
          if (cancelQueuedDownload(record.jobId) || cancelRunningDownload(record.jobId)) cancelled += 1;
        }
        removeDownloadFiles(record);
        state.downloads[key] = {
          ...record,
          status: 'deleted',
          file: null,
          deletedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        deleted += 1;
      }
      saveState(state);
      return sendJson(res, 200, { deleted, cancelled });
    }

    if (req.method === 'POST' && url.pathname === '/api/play') {
      const body = await readBody(req);
      const state = readState();
      const mode = normalizeMode(body.mode || state.settings.mode);
      let details = null;

      if (body.id && body.episode) {
        details = await getShowDetails(body.id, mode);
        if (!details.episodes.includes(normalizeEpisode(body.episode))) {
          return sendError(res, 422, `Episode ${body.episode} is not available yet`, {
            latestEpisode: details.latestEpisode,
            episodeCount: details.episodeCount,
          });
        }
        if (state.shows[body.id]) {
          mergeShow(state, { ...state.shows[body.id], ...details, lastCheckedAt: new Date().toISOString() });
          saveState(state);
        }
      }

      const playPayload = { ...body, ...(details || {}) };
      let args = await buildAniCliArgs(playPayload);
      const env = {};
      const useBrowserPlayback = !body.download && (
        body.player === 'android_mpv' ||
        body.player === 'vlc' ||
        (!body.player || body.player === 'default') && commandExists('am')
      );
      const usePtyAniCli = !body.download && !useBrowserPlayback && (
        body.player === 'android_mpv' ||
        (!body.player || body.player === 'default') && commandExists('am')
      );
      if (body.player && body.player !== 'default' && body.player !== 'vlc') env.ANI_CLI_PLAYER = body.player;

      let job;
      let playback = null;
      if (useBrowserPlayback) {
        args = await buildAniCliArgs({ ...playPayload, player: 'default' });
        job = await runJobAndWait(`Play ${body.title}`, args, { ANI_CLI_PLAYER: 'debug' });
        if (job.status !== 'done') {
          return sendError(res, 422, 'ani-cli could not fetch the video link', job.output || job.error || job);
        }
        try {
          playback = parseDebugPlayback(job.output || '');
          job.output = `${job.output || ''}\nPlayback URL sent to browser`;
        } catch (err) {
          job.status = 'failed';
          job.error = err.message;
          return sendError(res, 422, 'Could not fetch a playable link', err.message);
        }
      } else if (usePtyAniCli) {
        job = startPtyJob(`Play ${body.title}`, args, env);
      } else {
        job = await runJobAndWait(body.download ? `Download ${body.title}` : `Play ${body.title}`, args, env);
        if (job.status !== 'done') {
          return sendError(res, 422, 'ani-cli could not start the episode', job.output || job.error || job);
        }

        if (/failed to open \/dev\/tty/i.test(job.output || '')) {
          return sendError(res, 422, 'ani-cli got stuck in interactive mode without a terminal', job.output || job);
        }
        if (!/Links Fetched|Playing episode/i.test(job.output || '')) {
          return sendError(res, 422, 'ani-cli exited without clear playback confirmation', job.output || job);
        }
      }

      if (state.settings.autoTrackPlayed !== false && !body.resolveOnly && body.id && body.episode) {
        const existing = state.shows[body.id] || {};
        const watched = new Set(existing.watchedEpisodes || []);
        watched.add(episodeKey(body.episode));
        const show = mergeShow(state, {
          ...existing,
          ...(details || {}),
          ...body,
          mode,
          watchedEpisodes: Array.from(watched),
          lastWatched: body.episode,
          tracked: true,
        });
        writeHistoryEntry(show, body.episode);
        saveState(state);
      }
      return sendJson(res, 200, { job, playback });
    }

    if (req.method === 'GET' && url.pathname === '/api/jobs') {
      const state = readState();
      return sendJson(res, 200, { jobs: recentJobs(Array.from(jobs.values()), state.jobs || []).map(hydrateJobLog) });
    }

    if (req.method === 'DELETE' && url.pathname === '/api/jobs') {
      jobs.clear();
      const state = readState();
      state.jobs = [];
      saveState(state);
      clearJobLogs();
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === 'POST' && url.pathname === '/api/command') {
      const body = await readBody(req);
      const args = Array.isArray(body.args) ? body.args.map(String) : parseArgsLine(body.command);
      const job = startJob(`ani-cli ${args.join(' ')}`, args, {}, true);
      return sendJson(res, 200, { job });
    }

    sendError(res, 404, 'API endpoint missing');
  } catch (err) {
    sendError(res, 500, err.message, process.env.NODE_ENV === 'development' ? err.stack : undefined);
  }
}

function serveStatic(req, res, url) {
  const requested = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
  const filePath = path.normalize(path.join(PUBLIC_DIR, requested));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, {
      'content-type': mimeTypes[ext] || 'application/octet-stream',
      'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
    });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
  if (url.pathname.startsWith('/api/')) {
    handleApi(req, res, url);
    return;
  }
  serveStatic(req, res, url);
});

server.listen(PORT, HOST, () => {
  console.log(`Ani Web running at http://${HOST}:${PORT}`);
  console.log(`History: ${HISTORY_FILE}`);
});
