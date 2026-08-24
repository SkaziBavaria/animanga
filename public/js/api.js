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
  if (res.headers.get('x-animanga-cache') === 'offline' && json && typeof json === 'object') {
    json.offline = true;
    json.offlineAgeSeconds = Number(res.headers.get('x-animanga-cache-age')) || 0;
  }
  if (!res.ok || json.error) {
    const detail = typeof json.details === 'string'
      ? json.details.replace(new RegExp('\\u001b\\[[0-9;]*m', 'g'), '').trim().split('\n').filter(Boolean).slice(-3).join(' · ')
      : '';
    throw new Error(detail ? `${json.error}: ${detail}` : json.error || `HTTP ${res.status}`);
  }
  return json;
}

function raiseToast() {
  if (typeof els.toast.showPopover !== 'function') return;
  try {
    if (els.toast.matches(':popover-open')) els.toast.hidePopover();
    els.toast.showPopover();
  } catch {}
}

export function toast(message, options = {}) {
  clearTimeout(toast.timer);
  clearTimeout(toast.hideTimer);
  els.toast.replaceChildren(document.createTextNode(message));
  if (options.actionLabel && typeof options.onAction === 'function') {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'toast-action';
    button.textContent = options.actionLabel;
    button.addEventListener('click', async () => {
      button.disabled = true;
      try { await options.onAction(); } catch (error) { toast(error.message); }
    }, { once: true });
    els.toast.append(button);
  }
  raiseToast();
  els.toast.classList.add('show');
  // Reinsert the toast after any dialog opened in the same task so it stays
  // above both anime and manga overlays in the browser's top layer.
  queueMicrotask(() => {
    if (els.toast.classList.contains('show')) raiseToast();
  });
  toast.timer = setTimeout(() => {
    els.toast.classList.remove('show');
    toast.hideTimer = setTimeout(() => {
      try {
        if (els.toast.matches(':popover-open')) els.toast.hidePopover();
      } catch {}
    }, 200);
  }, options.duration || (options.actionLabel ? 6000 : 2600));
}

export function reportBackgroundError(context, error) {
  console.warn(`[AniManga] ${context}:`, error);
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
  }).catch((error) => reportBackgroundError(`Background request to ${path} failed`, error));
}
