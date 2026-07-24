'use strict';

const fs = require('node:fs');
const pkg = require('../package.json');

const CHECK_TTL_MS = 6 * 60 * 60 * 1000;
const CHECK_TIMEOUT_MS = 2500;
const RELEASES_URL = 'https://api.github.com/repos/SkaziBavaria/animanga/releases/latest';

let cached = null;
let inflight = null;

function currentVersion() {
  return String(pkg.version || '0.0.0');
}

function installMethod() {
  if (process.env.ANIMANGA_INSTALL === 'docker' || fs.existsSync('/.dockerenv')) return 'docker';
  return 'npm';
}

function normalizeVersion(value) {
  const match = String(value || '').trim().match(/v?(\d+(?:\.\d+){0,2})/i);
  return match ? match[1] : '';
}

function compareVersions(left, right) {
  const a = normalizeVersion(left).split('.').map((part) => Number(part) || 0);
  const b = normalizeVersion(right).split('.').map((part) => Number(part) || 0);
  const length = Math.max(a.length, b.length, 3);
  for (let index = 0; index < length; index += 1) {
    const delta = (a[index] || 0) - (b[index] || 0);
    if (delta) return delta < 0 ? -1 : 1;
  }
  return 0;
}

function updateHint(method, latest) {
  if (method === 'docker') {
    return `Update available (${latest}). In the repo folder: git pull --ff-only && docker compose up -d --build`;
  }
  return `Update available (${latest}). Run: npm install -g animanga@latest`;
}

async function fetchLatestRelease(fetcher = fetch) {
  const response = await fetcher(RELEASES_URL, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': `animanga/${currentVersion()}`,
    },
    signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`GitHub releases HTTP ${response.status}`);
  const body = await response.json();
  const latest = normalizeVersion(body.tag_name || body.name);
  if (!latest) return null;
  return {
    latest,
    url: body.html_url || 'https://github.com/SkaziBavaria/animanga/releases',
    publishedAt: body.published_at || null,
  };
}

async function refreshUpdateInfo(fetcher = fetch) {
  const version = currentVersion();
  const install = installMethod();
  try {
    const release = await fetchLatestRelease(fetcher);
    if (!release || compareVersions(version, release.latest) >= 0) {
      cached = { at: Date.now(), value: null };
      return null;
    }
    const value = {
      latest: release.latest,
      url: release.url,
      publishedAt: release.publishedAt,
      hint: updateHint(install, release.latest),
    };
    cached = { at: Date.now(), value };
    return value;
  } catch {
    if (!cached) cached = { at: Date.now(), value: null };
    else cached = { ...cached, at: Date.now() };
    return cached.value;
  }
}

function startRefresh(fetcher = fetch) {
  if (inflight) return inflight;
  inflight = refreshUpdateInfo(fetcher).finally(() => {
    inflight = null;
  });
  return inflight;
}

async function getUpdateInfo({ waitMs = 0, fetcher = fetch, now = Date.now() } = {}) {
  if (cached && now - cached.at < CHECK_TTL_MS) return cached.value;
  const pending = startRefresh(fetcher);
  if (!waitMs) {
    pending.catch(() => {});
    return cached?.value ?? null;
  }
  let timer;
  try {
    return await Promise.race([
      pending,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(cached?.value ?? null), waitMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function resetUpdateCheckForTests() {
  cached = null;
  inflight = null;
}

module.exports = {
  CHECK_TTL_MS,
  compareVersions,
  currentVersion,
  getUpdateInfo,
  installMethod,
  normalizeVersion,
  refreshUpdateInfo,
  resetUpdateCheckForTests,
  updateHint,
};
