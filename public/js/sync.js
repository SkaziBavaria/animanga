import { api, toast, withBusy } from './api.js';
import { els } from './dom.js';
import { loadLibrary, loadSettings } from './library.js';
import { loadProgress } from './progress.js';

let syncConfig = null;

function formatSyncTime(value) {
  if (!value) return 'Never synced';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Never synced' : `Last synced ${date.toLocaleString()}`;
}

function renderSyncConfig(value) {
  syncConfig = value;
  const form = els.syncForm;
  form.elements.deviceName.value = value.deviceName || '';
  form.elements.clientId.value = value.clientId || '';
  form.elements.clientSecret.value = '';
  form.elements.callbackUrl.value = value.callbackUrl || '';
  els.syncConnectBtn.disabled = !value.clientId || !value.hasClientSecret;
  els.syncNowBtn.disabled = !value.connected;
  els.syncDisconnectBtn.disabled = !value.connected;
  els.syncStatus.textContent = value.connected
    ? `${formatSyncTime(value.lastSyncAt)}${value.lastSyncError ? ` · ${value.lastSyncError}` : ''}`
    : value.clientId ? 'Configured · connect Google Drive' : 'Not configured';
  els.syncStatus.classList.toggle('error', Boolean(value.lastSyncError));
}

export async function loadSyncConfig() {
  renderSyncConfig(await api('/api/sync'));
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

async function refreshSyncedState() {
  await Promise.all([loadSettings(), loadProgress(), loadLibrary(false)]);
}

export function bindSyncControls() {
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
}

async function autoSync() {
  if (!syncConfig?.connected || !navigator.onLine || document.hidden) return;
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
