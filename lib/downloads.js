'use strict';

const fs = require('fs');
const path = require('path');
const { DOWNLOAD_DIR } = require('./config');
const registry = require('./registry');
const { readState, saveState } = require('./state');
const {
  aniCliQueryTitle,
  cleanTitle,
  normalizeEpisode,
  episodeKey,
} = require('./episodes');
const { stripAnsi } = require('./process');

function downloadKey(showId, episode) {
  return `${showId}:${episodeKey(episode)}`;
}

function safeDownloadBase(value) {
  return String(value || '')
    .replace(/[\\/:*?"<>|]/g, '')
    .trim();
}

function downloadBaseName(title) {
  const cleaned = safeDownloadBase(
    String(title || '')
      .replace(/\([^)]*\)/g, '')
      .replace(/[!"#$%&'()*+,./:;<=>?@[\\\]^_`{|}~-]/g, '')
  );
  return cleaned || safeDownloadBase(title);
}

function showFolderName(show) {
  const title = cleanTitle(
    show.name || show.englishName || aniCliQueryTitle(show) || show.showName || show.title || ''
  );
  return safeDownloadBase(title) || 'Anime';
}

function showDownloadDir(show) {
  return path.join(DOWNLOAD_DIR, showFolderName(show));
}

function ensureShowDownloadDir(show) {
  const dir = showDownloadDir(show);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {}
  return dir;
}

function expectedDownloadPath(show, episode) {
  const title = aniCliQueryTitle(show) || cleanTitle(show.title || '');
  const base = downloadBaseName(title) || 'Anime';
  return path.join(showDownloadDir(show), `${base} Episode ${normalizeEpisode(episode)}.mp4`);
}

function listDownloadFiles() {
  const files = [];
  let rootEntries;
  try {
    rootEntries = fs.readdirSync(DOWNLOAD_DIR, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of rootEntries) {
    if (!entry.isDirectory()) continue;
    const subDir = path.join(DOWNLOAD_DIR, entry.name);
    let subEntries;
    try {
      subEntries = fs.readdirSync(subDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const sub of subEntries) {
      if (sub.isFile() && sub.name.endsWith('.mp4')) {
        files.push({ name: sub.name, dir: subDir, folder: entry.name, fullPath: path.join(subDir, sub.name) });
      }
    }
  }
  return files;
}

function reconcileDownloads(state) {
  state.downloads ||= {};
  const files = listDownloadFiles();
  if (!files.length) return state.downloads;

  try {
    require('./library').seedStateFromHistory(state);
  } catch {}

  const folderToShow = new Map();
  for (const show of Object.values(state.shows || {})) {
    const folder = showFolderName(show);
    if (folder && !folderToShow.has(folder)) folderToShow.set(folder, show);
  }

  const takenPaths = new Set(
    Object.values(state.downloads)
      .filter((record) => record.status !== 'deleted')
      .map((record) => record.filePath)
      .filter(Boolean)
  );

  for (const file of files) {
    if (!file.folder) continue;
    const match = file.name.match(/^(.*) Episode (\S+)\.mp4$/);
    if (!match) continue;
    const [, , episodeRaw] = match;
    const show = folderToShow.get(file.folder);
    if (!show) continue;
    const episode = normalizeEpisode(episodeRaw);
    const key = downloadKey(show.id, episode);
    const existing = state.downloads[key];
    if (existing && existing.status !== 'deleted') continue;
    if (takenPaths.has(file.fullPath)) continue;
    takenPaths.add(file.fullPath);
    const now = new Date().toISOString();
    state.downloads[key] = downloadStatus({
      key,
      showId: show.id,
      episode,
      showName: show.name || show.title || '',
      mode: show.mode || 'sub',
      filePath: file.fullPath,
      downloadDir: file.dir,
      status: 'done',
      startedAt: now,
      finishedAt: now,
      updatedAt: now,
      reconciled: true,
    });
  }
  return state.downloads;
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

function episodeFilePattern(episode) {
  const normalized = normalizeEpisode(episode);
  return new RegExp(`Episode\\s+${normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.mp4$`, 'i');
}

function parseDownloadPathFromLog(record) {
  const logFile = record?.job?.logFile || record?.logFile;
  if (!logFile) return null;
  try {
    const output = stripAnsi(fs.readFileSync(logFile, 'utf8'));
    const match = output.match(/Download complete:\s*(.+?\.mp4)(?:\r?\n|$)/i);
    if (!match) return null;
    const filePath = match[1].trim();
    if (!isInsideDownloadDir(filePath)) return null;
    return fileInfo(filePath);
  } catch {
    return null;
  }
}

function findDownloadFile(record) {
  const fromLog = parseDownloadPathFromLog(record);
  if (fromLog) return fromLog;

  if (record?.filePath) {
    const direct = fileInfo(record.filePath);
    if (direct) return direct;
  }

  const files = listDownloadFiles();
  if (!files.length) return null;

  const pattern = episodeFilePattern(record.episode);
  const startedMs = record.startedAt ? Date.parse(record.startedAt) : 0;
  const finishedMs = record.finishedAt
    ? Date.parse(record.finishedAt)
    : (record.job?.finishedAt ? Date.parse(record.job.finishedAt) : 0);
  const windowStart = startedMs ? startedMs - 5000 : 0;
  const windowEnd = finishedMs ? finishedMs + 120000 : 0;
  const showName = safeDownloadBase(record.showName || '').toLowerCase();
  const recordDir = record.downloadDir ? path.resolve(record.downloadDir) : null;

  let best = null;
  let bestScore = -1;

  for (const file of files) {
    if (!pattern.test(file.name)) continue;
    const info = fileInfo(file.fullPath);
    if (!info) continue;

    let score = 0;
    const mtime = Date.parse(info.updatedAt);
    if (windowStart && windowEnd && mtime >= windowStart && mtime <= windowEnd) score += 100;
    if (record.filePath && path.resolve(record.filePath) === path.resolve(file.fullPath)) score += 60;
    if (recordDir && path.resolve(file.dir) === recordDir) score += 40;
    if (record.filePath && path.basename(record.filePath) === file.name) score += 30;
    if (showName && file.name.toLowerCase().includes(showName.slice(0, Math.min(6, showName.length)))) score += 20;
    if (!windowStart && !best) score += 1;

    if (score > bestScore) {
      bestScore = score;
      best = info;
    }
  }

  if (bestScore < 50) return null;
  return best;
}

function resolveDownloadPath(record) {
  return findDownloadFile(record)?.path || record?.filePath || null;
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
  if (record.status === 'deleted') {
    return {
      ...record,
      status: 'deleted',
      progress: null,
      downloadedBytes: null,
      downloadedLabel: '',
      file: null,
      job: null,
    };
  }
  const job = registry.jobs.get(record.jobId);
  const current = job || record.job || {};
  const file = findDownloadFile(record);
  let status = record.status || current.status || 'queued';
  if (current.status === 'running') status = 'running';
  else if (file && status !== 'deleted') status = current.status === 'failed' ? 'failed' : 'done';
  else if (['done', 'failed'].includes(current.status) || ['done', 'failed'].includes(record.status)) {
    status = current.status === 'failed' || record.status === 'failed' ? 'failed' : 'unknown';
  }
  if (!file && ['queued', 'running'].includes(status) && !job) status = 'unknown';
  return {
    ...record,
    filePath: file?.path || record.filePath,
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
  const merged = { ...existing, job, finishedAt: job.finishedAt || existing.finishedAt };
  const fromLog = parseDownloadPathFromLog(merged);
  state.downloads ||= {};
  state.downloads[key] = downloadStatus({
    ...existing,
    job,
    filePath: fromLog?.path || existing.filePath,
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
    downloadDir: showDownloadDir(show),
    jobId: job.id,
    job,
    status: job.status,
    startedAt: job.startedAt,
    updatedAt: new Date().toISOString(),
  });
  return state.downloads[key];
}

function cancelQueuedDownload(jobId) {
  const index = registry.downloadQueue.findIndex((item) => item.job.id === jobId);
  if (index === -1) return false;
  const [item] = registry.downloadQueue.splice(index, 1);
  item.cancelled = true;
  item.job.status = 'cancelled';
  item.job.finishedAt = new Date().toISOString();
  item.onUpdate?.(item.job);
  return true;
}

function cancelRunningDownload(jobId) {
  const job = registry.jobs.get(jobId);
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
  const filePath = resolveDownloadPath(record);
  if (!filePath || !isInsideDownloadDir(filePath)) return false;
  let removed = false;
  for (const candidate of [filePath, `${filePath}.part.mp4`, `${filePath}.aria2`]) {
    if (fs.existsSync(candidate)) {
      fs.rmSync(candidate, { force: true });
      removed = true;
    }
  }
  const dir = path.dirname(path.resolve(filePath));
  if (removed && dir !== DOWNLOAD_DIR && isInsideDownloadDir(dir)) {
    try {
      if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
    } catch {}
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

module.exports = {
  downloadKey,
  downloadStatus,
  isDownloadBusy,
  refreshDownloadRecords,
  updateDownloadRecord,
  createDownloadRecord,
  cancelQueuedDownload,
  cancelRunningDownload,
  removeDownloadFiles,
  streamDownloadFile,
  resolveDownloadPath,
  findDownloadFile,
  reconcileDownloads,
  isInsideDownloadDir,
  showDownloadDir,
  ensureShowDownloadDir,
  expectedDownloadPath,
};
