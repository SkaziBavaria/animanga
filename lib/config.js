'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.resolve(process.env.ANIMANGA_DATA_DIR || process.env.ANI_WEB_DATA_DIR || path.join(ROOT, 'data'));
const JOB_LOG_DIR = path.join(DATA_DIR, 'job-logs');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const ANIMANGA_DATABASE_FILE = path.join(DATA_DIR, 'animanga.sqlite');
const LEGACY_DATABASE_FILE = path.join(DATA_DIR, 'ani-web.sqlite');
const DATABASE_FILE = fs.existsSync(ANIMANGA_DATABASE_FILE) || !fs.existsSync(LEGACY_DATABASE_FILE)
  ? ANIMANGA_DATABASE_FILE
  : LEGACY_DATABASE_FILE;
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const BACKUP_RETENTION = 7;
const HOST = process.env.ANIMANGA_HOST || process.env.ANI_WEB_HOST || '127.0.0.1';
const PORT = Number(process.env.ANIMANGA_PORT || process.env.ANI_WEB_PORT || process.env.PORT || 7831);
const ANI_CLI = process.env.ANI_CLI_BIN || 'ani-cli';
const HISTORY_DIR = process.env.ANI_CLI_HIST_DIR || path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'ani-cli');
const HISTORY_FILE = path.join(HISTORY_DIR, 'ani-hsts');
const DOWNLOAD_DIR = path.resolve(process.env.ANI_CLI_DOWNLOAD_DIR || os.homedir());
const ALLANIME_BASE = process.env.ANIMANGA_ALLANIME_BASE || process.env.ANI_WEB_ALLANIME_BASE || 'allanime.day';
const ALLANIME_API = `https://api.${ALLANIME_BASE}/api`;
const ALLANIME_REFERER = 'https://youtu-chan.com';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:150.0) Gecko/20100101 Firefox/150.0';
const MAX_BODY = 1024 * 1024;
const DETAIL_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const RECOMMENDATION_CACHE_TTL_MS = 45 * 60 * 1000;
const DOWNLOAD_CONCURRENCY = Math.max(1, Number(process.env.ANIMANGA_DOWNLOAD_CONCURRENCY || process.env.ANI_WEB_DOWNLOAD_CONCURRENCY || 2));

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
  DATA_DIR,
  JOB_LOG_DIR,
  STATE_FILE,
  DATABASE_FILE,
  BACKUP_DIR,
  BACKUP_INTERVAL_MS,
  BACKUP_RETENTION,
  HOST,
  PORT,
  ANI_CLI,
  HISTORY_DIR,
  HISTORY_FILE,
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
