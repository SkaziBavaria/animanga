import { els } from './dom.js';

export async function api(path, options = {}) {
  let res;
  try {
    res = await fetch(path, {
      ...options,
      headers: {
        'content-type': 'application/json',
        ...(options.headers || {}),
      },
    });
  } catch (error) {
    toastError(error);
    throw error;
  }
  const json = await res.json().catch(() => ({}));
  if (res.headers.get('x-animanga-cache') === 'offline' && json && typeof json === 'object') {
    json.offline = true;
    json.offlineAgeSeconds = Number(res.headers.get('x-animanga-cache-age')) || 0;
  }
  if (!res.ok || json.error) {
    const detail = typeof json.details === 'string'
      ? json.details.replace(new RegExp('\\u001b\\[[0-9;]*m', 'g'), '').trim().split('\n').filter(Boolean).slice(-3).join(' · ')
      : '';
    const error = new Error(publicErrorMessage(
      detail ? `${json.error}: ${detail}` : json.error || `HTTP ${res.status}`,
    ));
    toastError(error);
    throw error;
  }
  return json;
}

export function publicErrorMessage(value) {
  const message = String(value || 'Something went wrong');
  const isAniDbPlayback = /AniManga could not fetch a playable link|AniDB/i.test(message);
  const leaksCurlInternals = /upstream curl failed|curl:\s*\(\d+\)|curl_(?:chrome|firefox)|curl-impersonate/i.test(message);
  if (isAniDbPlayback && leaksCurlInternals) {
    const status = message.match(/(?:HTTP|error:)\s*(\d{3})/i)?.[1];
    return status ? `AniDB unavailable (HTTP ${status})` : 'AniDB unavailable';
  }
  return message;
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
  const text = publicErrorMessage(message);
  const inheritedError = text === toast.lastErrorMessage && Date.now() < (toast.lastErrorUntil || 0);
  const isError = options.error === true || inheritedError;
  els.toast.classList.toggle('error', isError);
  els.toast.setAttribute('role', isError ? 'alert' : 'status');
  els.toast.setAttribute('aria-live', isError ? 'assertive' : 'polite');
  const content = document.createElement('span');
  content.className = 'toast-message';
  content.textContent = text;
  els.toast.replaceChildren(content);
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
  if (isError) {
    toast.lastErrorMessage = text;
    toast.lastErrorUntil = Date.now() + 15_000;
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'toast-close';
    close.textContent = '×';
    close.title = 'Dismiss error';
    close.setAttribute('aria-label', 'Dismiss error');
    close.addEventListener('click', () => hideToast(), { once: true });
    els.toast.append(close);
  }
  raiseToast();
  els.toast.classList.add('show');
  // Reinsert the toast after any dialog opened in the same task so it stays
  // above both anime and manga overlays in the browser's top layer.
  queueMicrotask(() => {
    if (els.toast.classList.contains('show')) raiseToast();
  });
  toast.timer = setTimeout(hideToast, options.duration || (isError ? 12_000 : options.actionLabel ? 6000 : 2600));
}

function hideToast() {
  clearTimeout(toast.timer);
  els.toast.classList.remove('show');
  toast.hideTimer = setTimeout(() => {
    try {
      if (els.toast.matches(':popover-open')) els.toast.hidePopover();
    } catch {}
  }, 200);
}

export function toastError(error) {
  const message = error?.message || error || 'Something went wrong';
  toast(message, { error: true });
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
    toastError(err);
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
