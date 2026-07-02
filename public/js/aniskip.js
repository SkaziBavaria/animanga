import { api } from './api.js';

const cache = new Map();

export function skipShowTitle(show) {
  return String(show?.englishName || show?.name || show?.title || '').trim();
}

export async function loadSkipTimes(title, episode, duration) {
  const cleanedTitle = String(title || '').trim();
  const ep = String(episode || '').trim();
  if (!cleanedTitle || !ep) return { op: null, ed: null };

  const key = `${cleanedTitle}::${ep}`;
  if (cache.has(key)) return cache.get(key);

  const promise = api(
    `/api/skip-times?title=${encodeURIComponent(cleanedTitle)}&episode=${encodeURIComponent(ep)}&duration=${Math.round(duration || 0)}`
  )
    .then((data) => data?.skip || { op: null, ed: null })
    .catch(() => ({ op: null, ed: null }));

  cache.set(key, promise);
  return promise;
}
