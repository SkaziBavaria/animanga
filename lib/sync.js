'use strict';

const crypto = require('crypto');
const {
  getAppValue,
  setAppValue,
  deviceId,
  syncBundle,
  mergeSyncBundles,
} = require('./state');
const githubSync = require('./github-sync');
const { fetchWithTimeout } = require('./upstream');

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
let activeSync = null;

function config() {
  return getAppValue('sync_google', {});
}

function publicConfig(callbackUrl = '') {
  const value = config();
  return {
    deviceId: deviceId(),
    clientId: value.clientId || '',
    deviceName: value.deviceName || '',
    hasClientSecret: Boolean(value.clientSecret),
    connected: Boolean(value.refreshToken),
    account: value.account || '',
    lastSyncAt: value.lastSyncAt || null,
    lastSyncError: value.lastSyncError || '',
    callbackUrl,
    provider: getAppValue('sync_provider', 'google'),
    github: githubSync.publicConfig(),
  };
}

function setProvider(provider) {
  const normalized = provider === 'github' ? 'github' : 'google';
  setAppValue('sync_provider', normalized);
  return normalized;
}

function configureGithub(input) {
  const result = githubSync.configure(input);
  setProvider('github');
  return result;
}

function saveConfig(patch) {
  return setAppValue('sync_google', { ...config(), ...patch });
}

function configure({ clientId, clientSecret, deviceName }) {
  const existing = config();
  const nextClientId = String(clientId || '').trim();
  const nextSecret = String(clientSecret || '').trim() || existing.clientSecret || '';
  if (!nextClientId) throw new Error('Google OAuth Client ID is required');
  if (!nextSecret) throw new Error('Google OAuth Client Secret is required');
  const credentialsChanged = existing.clientId && existing.clientId !== nextClientId;
  saveConfig({
    clientId: nextClientId,
    clientSecret: nextSecret,
    deviceName: String(deviceName || existing.deviceName || '').trim(),
    ...(credentialsChanged ? { refreshToken: '', accessToken: '', expiresAt: 0, account: '' } : {}),
  });
  return publicConfig();
}

function disconnect() {
  const existing = config();
  setAppValue('sync_google', {
    clientId: existing.clientId || '',
    clientSecret: existing.clientSecret || '',
    deviceName: existing.deviceName || '',
  });
  return publicConfig();
}

function authorizationUrl(callbackUrl) {
  const value = config();
  if (!value.clientId || !value.clientSecret) throw new Error('Save Google OAuth credentials first');
  const oauthState = crypto.randomBytes(24).toString('base64url');
  saveConfig({ oauthState, callbackUrl });
  const url = new URL(AUTH_URL);
  url.searchParams.set('client_id', value.clientId);
  url.searchParams.set('redirect_uri', callbackUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', DRIVE_SCOPE);
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('state', oauthState);
  return url.href;
}

async function tokenRequest(params) {
  const response = await fetchWithTimeout(fetch, TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error_description || payload.error || `Google token HTTP ${response.status}`);
  return payload;
}

async function finishAuthorization({ code, state }) {
  const value = config();
  if (!code || !state || state !== value.oauthState) throw new Error('Invalid Google OAuth callback state');
  if (!value.callbackUrl) throw new Error('Google OAuth callback URL is missing; reconnect first');
  const token = await tokenRequest({
    code,
    client_id: value.clientId,
    client_secret: value.clientSecret,
    redirect_uri: value.callbackUrl,
    grant_type: 'authorization_code',
  });
  if (!token.refresh_token) throw new Error('Google did not return a refresh token; reconnect and grant access');
  saveConfig({
    refreshToken: token.refresh_token,
    accessToken: token.access_token,
    expiresAt: Date.now() + Number(token.expires_in || 3600) * 1000,
    oauthState: '',
    callbackUrl: value.callbackUrl,
    lastSyncError: '',
  });
  return publicConfig(value.callbackUrl);
}

async function accessToken() {
  let value = config();
  if (value.accessToken && Number(value.expiresAt) > Date.now() + 60_000) return value.accessToken;
  if (!value.refreshToken) throw new Error('Google Drive is not connected');
  const token = await tokenRequest({
    refresh_token: value.refreshToken,
    client_id: value.clientId,
    client_secret: value.clientSecret,
    grant_type: 'refresh_token',
  });
  value = saveConfig({
    accessToken: token.access_token,
    expiresAt: Date.now() + Number(token.expires_in || 3600) * 1000,
  });
  return value.accessToken;
}

async function driveFetch(url, options = {}) {
  const token = await accessToken();
  const response = await fetchWithTimeout(fetch, url, {
    ...options,
    headers: { authorization: `Bearer ${token}`, ...(options.headers || {}) },
  }, 30_000);
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error?.message || `Google Drive HTTP ${response.status}`);
  }
  return response;
}

async function listSyncFiles() {
  const url = new URL(`${DRIVE_API}/files`);
  url.searchParams.set('spaces', 'appDataFolder');
  url.searchParams.set('q', "(name contains 'animanga-sync-' or name contains 'ani-web-sync-') and trashed = false");
  url.searchParams.set('fields', 'files(id,name,modifiedTime)');
  url.searchParams.set('pageSize', '100');
  return (await (await driveFetch(url)).json()).files || [];
}

async function downloadBundle(file) {
  const response = await driveFetch(`${DRIVE_API}/files/${encodeURIComponent(file.id)}?alt=media`);
  return response.json();
}

async function uploadBundle(file, bundle) {
  let id = file?.id;
  if (!id) {
    const created = await driveFetch(`${DRIVE_API}/files`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: `animanga-sync-${deviceId()}.json`,
        parents: ['appDataFolder'],
        mimeType: 'application/json',
      }),
    });
    id = (await created.json()).id;
  }
  await driveFetch(`${DRIVE_UPLOAD}/files/${encodeURIComponent(id)}?uploadType=media`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(bundle),
  });
}

async function performSync() {
  const value = config();
  if (!value.refreshToken) throw new Error('Google Drive is not connected');
  const files = await listSyncFiles();
  const bundles = [];
  for (const file of files) {
    try {
      bundles.push(await downloadBundle(file));
    } catch {}
  }
  const merged = mergeSyncBundles(bundles);
  const ownNames = [`animanga-sync-${deviceId()}.json`, `ani-web-sync-${deviceId()}.json`];
  const ownFile = files.find((file) => ownNames.includes(file.name));
  await uploadBundle(ownFile, syncBundle());
  const lastSyncAt = new Date().toISOString();
  saveConfig({ lastSyncAt, lastSyncError: '' });
  return { ok: true, lastSyncAt, applied: merged.applied, files: files.length + (ownFile ? 0 : 1) };
}

async function syncGoogleNow({ silent = false } = {}) {
  if (!config().refreshToken) {
    if (silent) return { ok: false, disabled: true };
    throw new Error('Google Drive is not connected');
  }
  if (activeSync) return activeSync;
  activeSync = performSync()
    .catch((err) => {
      saveConfig({ lastSyncError: err.message });
      if (!silent) throw err;
      return { ok: false, error: err.message };
    })
    .finally(() => { activeSync = null; });
  return activeSync;
}

async function syncNow({ silent = false } = {}) {
  const provider = getAppValue('sync_provider', 'google');
  if (provider === 'github') {
    if (activeSync) return activeSync;
    activeSync = githubSync.syncNow()
      .catch((err) => {
        if (!silent) throw err;
        return { ok: false, error: err.message };
      })
      .finally(() => { activeSync = null; });
    return activeSync;
  }
  return syncGoogleNow({ silent });
}

module.exports = {
  publicConfig,
  configure,
  disconnect,
  authorizationUrl,
  finishAuthorization,
  syncNow,
  setProvider,
  configureGithub,
  disconnectGithub: githubSync.disconnect,
  startGithubAuthorization: githubSync.startDeviceAuthorization,
  pollGithubAuthorization: githubSync.pollDeviceAuthorization,
};
