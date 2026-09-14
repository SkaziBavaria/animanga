import { els } from './dom.js';
import { state } from './state.js';

function providerForMessage(value) {
  const message = String(value || '');
  if (/\bHiAnime\b/i.test(message)) return 'anime';
  if (/\b(?:Manga provider|ComicK|MangaDex|WeebCentral|MangaPill|MangaTown)\b/i.test(message)) return 'manga';
  return null;
}

function isRelevantMessage(value) {
  const providerMode = providerForMessage(value);
  return !providerMode || providerMode === state.mediaMode;
}

export async function api(path, options = {}) {
  const { background = false, ...fetchOptions } = options;
  let res;
  try {
    res = await fetch(path, {
      ...fetchOptions,
      headers: {
        'content-type': 'application/json',
        ...(options.headers || {}),
      },
    });
  } catch (error) {
    error.background = background;
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
    Object.assign(error, { background, mediaMode: json.mediaMode, provider: json.provider, upstreamStatus: json.upstreamStatus, code: json.code });
    if (json.provider) window.dispatchEvent(new CustomEvent('animanga:provider-failure', { detail: json }));
    toastError(error);
    throw error;
  }
  return json;
}

export function publicErrorMessage(value) {
  return String(value || 'Something went wrong');
}

const ERROR_TOAST_MS = 30_000;

function looksLikeErrorToast(text) {
  return /failed to load|no supported source|no playable stream|could not play|could not load|could not start playback|has no \w* ?sources|no \w+ \w+ source found|this device could not decode|network error while loading the stream|playback was aborted/i.test(String(text || ''));
}

function raiseToast() {
  if (typeof els.toast.showPopover !== 'function') return;
  try {
    if (els.toast.matches(':popover-open')) els.toast.hidePopover();
    els.toast.showPopover();
  } catch {}
}

export function toast(message, options = {}) {
  const text = publicErrorMessage(message);
  const known = toast.lastFailure;
  const failure = known?.message === text && Date.now() < known.until ? known : null;
  if (failure?.background || (failure?.mediaMode && failure.mediaMode !== state.mediaMode)) return;
  if (!failure?.mediaMode && !isRelevantMessage(text)) return;
  clearTimeout(toast.timer);
  clearTimeout(toast.hideTimer);
  toast.mediaMode = failure?.mediaMode || providerForMessage(text);
  const inheritedError = text === toast.lastErrorMessage && Date.now() < (toast.lastErrorUntil || 0);
  const isError = options.error === true || inheritedError || looksLikeErrorToast(text);
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
    toast.lastErrorUntil = Date.now() + ERROR_TOAST_MS;
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
  toast.timer = setTimeout(hideToast, options.duration || (isError ? ERROR_TOAST_MS : options.actionLabel ? 6000 : 2600));
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

window.addEventListener('animanga:media-mode', () => {
  if (toast.mediaMode) {
    if (toast.mediaMode !== state.mediaMode) hideToast();
    return;
  }
  const message = els.toast.querySelector('.toast-message')?.textContent || '';
  if (message && !isRelevantMessage(message)) hideToast();
});

export function toastError(error) {
  const message = publicErrorMessage(error?.message || error || 'Something went wrong');
  toast.lastFailure = { message, background: error?.background, mediaMode: error?.mediaMode, until: Date.now() + ERROR_TOAST_MS };
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
