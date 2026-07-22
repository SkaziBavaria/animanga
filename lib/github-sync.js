'use strict';

const { getAppValue, setAppValue, deviceId, syncBundle, mergeSyncBundles } = require('./state');
const { fetchWithTimeout } = require('./upstream');

const DEVICE_CODE_URL = 'https://github.com/login/device/code';
const ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const API_URL = 'https://api.github.com';
const REPO_NAME = 'aniweb-sync-data';
const API_VERSION = '2022-11-28';
let rawFetcher = (url, options) => fetch(url, options);

function setRawFetcher(fetcher) {
  rawFetcher = fetcher || ((url, options) => fetch(url, options));
}

function config() {
  return getAppValue('sync_github', {});
}

function saveConfig(patch) {
  return setAppValue('sync_github', { ...config(), ...patch });
}

function publicConfig() {
  const value = config();
  return {
    clientId: value.clientId || '',
    deviceName: value.deviceName || '',
    connected: Boolean(value.token),
    account: value.account || '',
    repo: value.account ? `${value.account}/${REPO_NAME}` : '',
    lastSyncAt: value.lastSyncAt || null,
    lastSyncError: value.lastSyncError || '',
    deviceAuth: value.deviceAuth ? {
      status: value.deviceAuth.status,
      userCode: value.deviceAuth.userCode,
      verificationUri: value.deviceAuth.verificationUri,
      expiresAt: value.deviceAuth.expiresAt,
      interval: value.deviceAuth.interval,
      error: value.deviceAuth.error || '',
    } : { status: 'idle' },
  };
}

function configure({ clientId, deviceName }) {
  const existing = config();
  const nextClientId = String(clientId || '').trim();
  if (!nextClientId) throw new Error('GitHub OAuth Client ID is required');
  const changed = existing.clientId && existing.clientId !== nextClientId;
  saveConfig({
    clientId: nextClientId,
    deviceName: String(deviceName || existing.deviceName || '').trim(),
    ...(changed ? { token: '', account: '', deviceAuth: { status: 'idle' } } : {}),
  });
  return publicConfig();
}

function disconnect() {
  const existing = config();
  setAppValue('sync_github', {
    clientId: existing.clientId || '',
    deviceName: existing.deviceName || '',
    deviceAuth: { status: 'idle' },
  });
  return publicConfig();
}

async function jsonRequest(url, options = {}) {
  const response = await fetchWithTimeout(rawFetcher, url, options, 20_000);
  const payload = await response.json().catch(() => ({}));
  return { response, payload };
}

async function startDeviceAuthorization() {
  const value = config();
  if (!value.clientId) throw new Error('Save a GitHub OAuth Client ID first');
  const { response, payload } = await jsonRequest(DEVICE_CODE_URL, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: value.clientId, scope: 'repo' }),
  });
  if (!response.ok || !payload.device_code) throw new Error(payload.error_description || payload.error || `GitHub device login HTTP ${response.status}`);
  saveConfig({
    deviceAuth: {
      status: 'pending',
      deviceCode: payload.device_code,
      userCode: payload.user_code,
      verificationUri: payload.verification_uri,
      expiresAt: Date.now() + Number(payload.expires_in || 900) * 1000,
      interval: Math.max(5, Number(payload.interval || 5)),
      error: '',
    },
  });
  return publicConfig().deviceAuth;
}

async function githubApi(path, options = {}) {
  const value = config();
  if (!value.token) throw new Error('GitHub is not connected');
  const { response, payload } = await jsonRequest(`${API_URL}${path}`, {
    ...options,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${value.token}`,
      'x-github-api-version': API_VERSION,
      ...(options.headers || {}),
    },
  });
  if (!response.ok) {
    const error = new Error(payload.message || `GitHub API HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

async function pollDeviceAuthorization() {
  const value = config();
  const auth = value.deviceAuth || {};
  if (auth.status !== 'pending' || !auth.deviceCode) return publicConfig().deviceAuth;
  if (Number(auth.expiresAt) <= Date.now()) {
    saveConfig({ deviceAuth: { status: 'error', error: 'GitHub device code expired. Start again.' } });
    return publicConfig().deviceAuth;
  }
  const { response, payload } = await jsonRequest(ACCESS_TOKEN_URL, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: value.clientId, device_code: auth.deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }),
  });
  if (payload.error === 'authorization_pending') return publicConfig().deviceAuth;
  if (payload.error === 'slow_down') {
    saveConfig({ deviceAuth: { ...auth, interval: Number(auth.interval || 5) + 5 } });
    return publicConfig().deviceAuth;
  }
  if (!response.ok || !payload.access_token) {
    saveConfig({ deviceAuth: { status: 'error', error: payload.error_description || payload.error || `GitHub token HTTP ${response.status}` } });
    return publicConfig().deviceAuth;
  }
  saveConfig({ token: payload.access_token, deviceAuth: { status: 'success' }, lastSyncError: '' });
  const user = await githubApi('/user');
  saveConfig({ account: user.login || '', deviceAuth: { status: 'success' } });
  return publicConfig().deviceAuth;
}

async function ensureRepo() {
  let value = config();
  if (!value.account) {
    const user = await githubApi('/user');
    value = saveConfig({ account: user.login || '' });
  }
  const owner = value.account;
  const repoPath = `/repos/${encodeURIComponent(owner)}/${REPO_NAME}`;
  try {
    const repo = await githubApi(repoPath);
    if (repo.private !== true) throw new Error(`${REPO_NAME} must be private before sync can continue`);
  } catch (err) {
    if (err.status !== 404) throw err;
    await githubApi('/user/repos', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: REPO_NAME, private: true, auto_init: true, description: 'Private AniManga synchronization data.' }),
    });
  }
  return owner;
}

async function listDeviceFiles(owner) {
  try {
    const files = await githubApi(`/repos/${encodeURIComponent(owner)}/${REPO_NAME}/contents/devices`);
    return Array.isArray(files) ? files.filter((file) => file.type === 'file' && file.name.endsWith('.json')) : [];
  } catch (err) {
    if (err.status === 404) return [];
    throw err;
  }
}

async function downloadBundle(owner, file) {
  const data = await githubApi(`/repos/${encodeURIComponent(owner)}/${REPO_NAME}/contents/${file.path}`);
  return JSON.parse(Buffer.from(String(data.content || '').replace(/\s/g, ''), 'base64').toString('utf8'));
}

async function uploadBundle(owner, file, bundle) {
  const path = `devices/${deviceId()}.json`;
  await githubApi(`/repos/${encodeURIComponent(owner)}/${REPO_NAME}/contents/${path}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      message: `Sync AniManga device ${deviceId()}`,
      content: Buffer.from(JSON.stringify(bundle), 'utf8').toString('base64'),
      ...(file?.sha ? { sha: file.sha } : {}),
    }),
  });
}

async function syncNow() {
  if (!config().token) throw new Error('GitHub is not connected');
  try {
    const owner = await ensureRepo();
    const files = await listDeviceFiles(owner);
    const bundles = [];
    const downloaded = new Map();
    for (const file of files) {
      try {
        const bundle = await downloadBundle(owner, file);
        bundles.push(bundle);
        downloaded.set(file.name, bundle);
      } catch {}
    }
    const merged = mergeSyncBundles(bundles);
    const ownName = `${deviceId()}.json`;
    const localBundle = syncBundle();
    const remoteBundle = downloaded.get(ownName);
    const changed = !remoteBundle || JSON.stringify(remoteBundle.records || []) !== JSON.stringify(localBundle.records || []);
    if (changed) await uploadBundle(owner, files.find((file) => file.name === ownName), localBundle);
    const lastSyncAt = new Date().toISOString();
    saveConfig({ lastSyncAt, lastSyncError: '' });
    return { ok: true, provider: 'github', lastSyncAt, applied: merged.applied, uploaded: changed, files: files.length + (files.some((file) => file.name === ownName) ? 0 : 1) };
  } catch (err) {
    saveConfig({ lastSyncError: err.message });
    throw err;
  }
}

module.exports = {
  publicConfig,
  configure,
  disconnect,
  startDeviceAuthorization,
  pollDeviceAuthorization,
  syncNow,
  setRawFetcher,
};
