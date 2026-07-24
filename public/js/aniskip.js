import { api } from './api.js';

const cache = new Map();

export function skipShowTitle(show) {
  return String(show?.englishName || show?.name || show?.title || '').trim();
}

export async function loadSkipTimes(title, episode, duration) {
  const cleanedTitle = String(title || '').trim();
  const ep = String(episode || '').trim();
  if (!cleanedTitle || !ep) return { op: null, ed: null };

  const roundedDuration = Math.round(duration || 0);
  const key = `${cleanedTitle}::${ep}::${roundedDuration}`;
  if (cache.has(key)) return cache.get(key);

  const promise = api(
    `/api/skip-times?title=${encodeURIComponent(cleanedTitle)}&episode=${encodeURIComponent(ep)}&duration=${roundedDuration}`
  )
    .then((data) => {
      const skip = data?.skip || { op: null, ed: null };
      if (!skip.op && !skip.ed) cache.delete(key);
      return skip;
    })
    .catch(() => {
      cache.delete(key);
      return { op: null, ed: null };
    });

  cache.set(key, promise);
  return promise;
}
