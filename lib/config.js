'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');

function userDataDir() {
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'AniManga');
  }
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'AniManga');
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'animanga');
}

const LOCAL_DATA_DIR = path.join(ROOT, 'data');
const DEFAULT_DATA_DIR = fs.existsSync(LOCAL_DATA_DIR) ? LOCAL_DATA_DIR : userDataDir();
const DATA_DIR = path.resolve(process.env.ANIMANGA_DATA_DIR || DEFAULT_DATA_DIR);
const JOB_LOG_DIR = path.join(DATA_DIR, 'job-logs');
const DATABASE_FILE = path.join(DATA_DIR, 'animanga.sqlite');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const BACKUP_RETENTION = 7;
const HOST = process.env.ANIMANGA_HOST || '127.0.0.1';
const PORT = Number(process.env.ANIMANGA_PORT || process.env.PORT || 7831);
const ACCESS_TOKEN = String(process.env.ANIMANGA_ACCESS_TOKEN || '');
const ACCESS_USERNAME = String(process.env.ANIMANGA_ACCESS_USERNAME || 'animanga');
const TRUST_PROXY = process.env.ANIMANGA_TRUST_PROXY === '1';

function publicOrigin(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('ANIMANGA_PUBLIC_URL must be a valid http(s) URL');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('ANIMANGA_PUBLIC_URL must be an http(s) origin without credentials');
  }
  if (url.pathname !== '/' || url.search || url.hash) {
    throw new Error('ANIMANGA_PUBLIC_URL must contain only an origin, without a path or query');
  }
  return url.origin;
}

const PUBLIC_URL = publicOrigin(process.env.ANIMANGA_PUBLIC_URL);
if (TRUST_PROXY && !PUBLIC_URL) {
  throw new Error('ANIMANGA_PUBLIC_URL is required when ANIMANGA_TRUST_PROXY=1');
}
const DOWNLOAD_DIR = path.resolve(process.env.ANIMANGA_DOWNLOAD_DIR || path.join(DATA_DIR, 'downloads'));
const ALLANIME_BASE = process.env.ANIMANGA_ALLANIME_BASE || 'allanime.day';
const ALLANIME_API = `https://api.${ALLANIME_BASE}/api`;
const ALLANIME_REFERER = 'https://youtu-chan.com';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:150.0) Gecko/20100101 Firefox/150.0';
const MAX_BODY = 1024 * 1024;
const DETAIL_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const RECOMMENDATION_CACHE_TTL_MS = 45 * 60 * 1000;
const DOWNLOAD_CONCURRENCY = Math.max(1, Number(process.env.ANIMANGA_DOWNLOAD_CONCURRENCY || 2));

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

module.exports = {
  ROOT,
  PUBLIC_DIR,
  userDataDir,
  DATA_DIR,
  JOB_LOG_DIR,
  DATABASE_FILE,
  BACKUP_DIR,
  BACKUP_INTERVAL_MS,
  BACKUP_RETENTION,
  HOST,
  PORT,
  ACCESS_TOKEN,
  ACCESS_USERNAME,
  TRUST_PROXY,
  PUBLIC_URL,
  publicOrigin,
  DOWNLOAD_DIR,
  ALLANIME_BASE,
  ALLANIME_API,
  ALLANIME_REFERER,
  USER_AGENT,
  MAX_BODY,
  DETAIL_CACHE_TTL_MS,
  RECOMMENDATION_CACHE_TTL_MS,
  DOWNLOAD_CONCURRENCY,
  mimeTypes,
};
