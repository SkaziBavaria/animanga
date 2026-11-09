'use strict';

const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./config');

const LOG_FILE = path.join(DATA_DIR, 'application.log');
const MAX_ENTRIES = 500;
const MAX_BYTES = 1024 * 1024;
let entries = null;

function load() {
  if (entries) return entries;
  try {
    entries = fs.readFileSync(LOG_FILE, 'utf8').trim().split('\n').filter(Boolean)
      .map((line) => JSON.parse(line)).slice(-MAX_ENTRIES);
  } catch {
    entries = [];
  }
  return entries;
}

function text(value) {
  if (value instanceof Error) return value.stack || value.message;
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); } catch { return String(value); }
}

function appLog(level, ...values) {
  const entry = { timestamp: new Date().toISOString(), level, message: values.map(text).join(' ') };
  load().push(entry);
  entries = entries.slice(-MAX_ENTRIES);
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, `${JSON.stringify(entry)}\n`);
    if (fs.statSync(LOG_FILE).size > MAX_BYTES) {
      fs.writeFileSync(LOG_FILE, entries.map((item) => JSON.stringify(item)).join('\n') + '\n');
    }
  } catch { /* logging must never bring down the server */ }
  const output = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  output(`[${level}]`, entry.message);
}

function recentLogs(limit = 200) { return load().slice(-Math.max(1, Math.min(500, Number(limit) || 200))); }

function clearLogs() {
  entries = [];
  try { fs.rmSync(LOG_FILE, { force: true }); } catch { /* best effort */ }
}

module.exports = { appLog, recentLogs, clearLogs };
