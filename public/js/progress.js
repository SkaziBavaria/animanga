import { api, postBeacon } from './api.js';
import { state } from './state.js';

export function positionKey(showId, episode) {
  return `${showId}:${String(episode || '').trim()}`;
}

export function positionFor(showId, episode) {
  return state.positions[positionKey(showId, episode)] || null;
}

export function latestPositionForShow(showId) {
  const entries = Object.values(state.positions || {}).filter((entry) => entry.showId === showId);
  if (!entries.length) return null;
  return entries.sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0))[0];
}

export async function loadProgress() {
  const data = await api('/api/progress');
  state.positions = data.positions || {};
}

export function saveProgress(showId, episode, position, duration) {
  if (!showId || !episode) return;
  const key = positionKey(showId, episode);
  const pos = Number(position);
  const dur = Number(duration);
  const nearEnd = Number.isFinite(dur) && dur > 0 && (pos >= dur - 15 || pos / dur >= 0.95);

  if (!Number.isFinite(pos) || pos < 5 || nearEnd) {
    delete state.positions[key];
  } else {
    state.positions[key] = {
      showId,
      episode: String(episode).trim(),
      position: pos,
      duration: Number.isFinite(dur) && dur > 0 ? dur : null,
      updatedAt: new Date().toISOString(),
    };
  }

  postBeacon('/api/progress', { id: showId, episode, position: pos, duration: dur });
}

export function formatClock(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
