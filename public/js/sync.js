import { api, toast, withBusy } from './api.js';
import { els } from './dom.js';
import { loadLibrary, loadSettings } from './library.js';
import { loadProgress } from './progress.js';

let syncConfig = null;
let githubPollTimer = null;

function formatSyncTime(value) {
  if (!value) return 'Never synced';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Never synced' : `Last synced ${date.toLocaleString()}`;
}

function renderSyncConfig(value) {
  syncConfig = value;
  const provider = value.provider || 'google';
  const github = value.github || {};
  const form = els.syncForm;
  form.elements.deviceName.value = value.deviceName || '';
  form.elements.clientId.value = value.clientId || '';
  form.elements.clientSecret.value = '';
  form.elements.callbackUrl.value = value.callbackUrl || '';
  els.githubSyncForm.elements.deviceName.value = github.deviceName || '';
  els.githubSyncForm.elements.clientId.value = github.clientId || '';
  els.syncProvider.value = provider;
  els.syncForm.hidden = provider !== 'google';
  els.githubSyncForm.hidden = provider !== 'github';
  els.syncConnectBtn.disabled = !value.clientId || !value.hasClientSecret;
  els.syncDisconnectBtn.disabled = !value.connected;
  els.githubConnectBtn.disabled = !github.clientId || github.deviceAuth?.status === 'pending';
  els.githubDisconnectBtn.disabled = !github.connected;
  const active = provider === 'github' ? github : value;
  els.syncNowBtn.disabled = !active.connected;
  const providerName = provider === 'github' ? 'GitHub' : 'Google Drive';
  els.syncStatus.textContent = active.connected
    ? `${providerName} · ${formatSyncTime(active.lastSyncAt)}${active.lastSyncError ? ` · ${active.lastSyncError}` : ''}`
    : active.clientId ? `${providerName} configured · connect account` : `${providerName} not configured`;
  els.syncStatus.classList.toggle('error', Boolean(active.lastSyncError));
  renderGithubDeviceAuth(github.deviceAuth);
}

function renderGithubDeviceAuth(auth = {}) {
  const pending = auth.status === 'pending' && auth.userCode && auth.verificationUri;
  els.githubDeviceAuth.hidden = !pending;
  if (!pending) return;
  els.githubDeviceCode.textContent = auth.userCode;
  els.githubDeviceUrl.href = auth.verificationUri;
}

export async function loadSyncConfig() {
  const value = await api('/api/sync');
  renderSyncConfig(value);
  const auth = value.github?.deviceAuth;
  if (auth?.status === 'pending' && !githubPollTimer) {
    githubPollTimer = setTimeout(() => pollGithub(auth.interval || 5), Math.max(5, auth.interval || 5) * 1000);
  }
  return syncConfig;
}

async function saveSyncConfig() {
  const data = new FormData(els.syncForm);
  const payload = {
    deviceName: data.get('deviceName'),
    clientId: data.get('clientId'),
    clientSecret: data.get('clientSecret'),
  };
  renderSyncConfig(await api('/api/sync/config', { method: 'POST', body: JSON.stringify(payload) }));
  toast('Sync settings saved');
}

async function saveGithubConfig() {
  const data = new FormData(els.githubSyncForm);
  const value = await api('/api/sync/github/config', {
    method: 'POST',
    body: JSON.stringify({ deviceName: data.get('deviceName'), clientId: data.get('clientId') }),
  });
  renderSyncConfig(value);
  toast('GitHub sync settings saved');
}

function stopGithubPolling() {
  if (githubPollTimer) clearTimeout(githubPollTimer);
  githubPollTimer = null;
}

async function pollGithub(interval = 5) {
  stopGithubPolling();
  try {
    const result = await api('/api/sync/github/poll');
    renderSyncConfig(result.config);
    if (result.deviceAuth?.status === 'success') {
      await api('/api/sync/run', { method: 'POST' });
      await refreshSyncedState();
      await loadSyncConfig();
      toast('GitHub connected and synced');
      return;
    }
    if (result.deviceAuth?.status === 'error') {
      toast(result.deviceAuth.error || 'GitHub login failed');
      return;
    }
    githubPollTimer = setTimeout(() => pollGithub(result.deviceAuth?.interval || interval), Math.max(5, result.deviceAuth?.interval || interval) * 1000);
  } catch (err) {
    toast(err.message);
  }
}

async function refreshSyncedState() {
  await Promise.all([loadSettings(), loadProgress(), loadLibrary(false)]);
}

export function bindSyncControls() {
  els.syncProvider.addEventListener('change', async () => {
    try {
      renderSyncConfig(await api('/api/sync/provider', {
        method: 'POST',
        body: JSON.stringify({ provider: els.syncProvider.value }),
      }));
    } catch (err) {
      toast(err.message);
    }
  });
  els.githubSyncForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await withBusy(els.githubSyncForm.querySelector('[type="submit"]'), 'Saving…', saveGithubConfig);
    } catch (err) {
      toast(err.message);
    }
  });
  els.syncForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await withBusy(els.syncForm.querySelector('[type="submit"]'), 'Saving…', saveSyncConfig);
    } catch (err) {
      toast(err.message);
    }
  });
  els.syncConnectBtn.addEventListener('click', async () => {
    try {
      await saveSyncConfig();
      const data = await api('/api/sync/google/connect');
      window.location.assign(data.url);
    } catch (err) {
      toast(err.message);
    }
  });
  els.githubConnectBtn.addEventListener('click', async () => {
    try {
      await saveGithubConfig();
      const result = await api('/api/sync/github/connect', { method: 'POST' });
      renderGithubDeviceAuth(result.deviceAuth);
      toast('Open GitHub device login and enter the displayed code');
      pollGithub(result.deviceAuth.interval || 5);
    } catch (err) {
      toast(err.message);
    }
  });
  els.syncNowBtn.addEventListener('click', async () => {
    try {
      const result = await withBusy(els.syncNowBtn, 'Syncing…', () => api('/api/sync/run', { method: 'POST' }));
      await refreshSyncedState();
      await loadSyncConfig();
      toast(`Sync complete · ${result.applied || 0} changes applied`);
    } catch (err) {
      await loadSyncConfig().catch(() => {});
      toast(err.message);
    }
  });
  els.syncDisconnectBtn.addEventListener('click', async () => {
    try {
      renderSyncConfig(await api('/api/sync/disconnect', { method: 'POST' }));
      toast('Google Drive disconnected');
    } catch (err) {
      toast(err.message);
    }
  });
  els.githubDisconnectBtn.addEventListener('click', async () => {
    try {
      stopGithubPolling();
      renderSyncConfig(await api('/api/sync/github/disconnect', { method: 'POST' }));
      toast('GitHub disconnected');
    } catch (err) {
      toast(err.message);
    }
  });
}

async function autoSync() {
  const connected = syncConfig?.provider === 'github' ? syncConfig?.github?.connected : syncConfig?.connected;
  if (!connected || !navigator.onLine || document.hidden) return;
  try {
    await api('/api/sync/run', { method: 'POST' });
    await refreshSyncedState();
    await loadSyncConfig();
  } catch {
    await loadSyncConfig().catch(() => {});
  }
}

export function startAutoSync() {
  setTimeout(autoSync, 10_000);
  setInterval(autoSync, 5 * 60_000);
  window.addEventListener('online', autoSync);
}
