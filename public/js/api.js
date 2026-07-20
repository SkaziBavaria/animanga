import { els } from './dom.js';

export async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const json = await res.json().catch(() => ({}));
  if (res.headers.get('x-ani-web-cache') === 'offline' && json && typeof json === 'object') {
    json.offline = true;
    json.offlineAgeSeconds = Number(res.headers.get('x-ani-web-cache-age')) || 0;
  }
  if (!res.ok || json.error) {
    const detail = typeof json.details === 'string'
      ? json.details.replace(/\x1b\[[0-9;]*m/g, '').trim().split('\n').filter(Boolean).slice(-3).join(' · ')
      : '';
    throw new Error(detail ? `${json.error}: ${detail}` : json.error || `HTTP ${res.status}`);
  }
  return json;
}

export function toast(message) {
  els.toast.textContent = message;
  els.toast.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => els.toast.classList.remove('show'), 2600);
}

export async function withBusy(button, label, task) {
  if (!button) return task();
  const previous = button.textContent;
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  button.classList.add('busy');
  if (label) button.textContent = label;
  try {
    return await task();
  } finally {
    button.disabled = false;
    button.removeAttribute('aria-busy');
    button.classList.remove('busy');
    button.textContent = previous;
  }
}

export async function runAction(button, label, task) {
  try {
    return await withBusy(button, label, task);
  } catch (err) {
    toast(err.message);
    return undefined;
  }
}

export function postBeacon(path, payload) {
  const body = JSON.stringify(payload);
  if (navigator.sendBeacon) {
    const blob = new Blob([body], { type: 'application/json' });
    if (navigator.sendBeacon(path, blob)) return;
  }
  fetch(path, {
    method: 'POST',
    body,
    headers: { 'content-type': 'application/json' },
    keepalive: true,
  }).catch(() => {});
}
