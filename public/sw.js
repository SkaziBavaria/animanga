const SHELL_CACHE = 'animanga-shell-v46';
const API_CACHE = 'animanga-api-v4';
const ASSETS = [
  '/', '/index.html', '/styles.css', '/manifest.webmanifest', '/icon.svg', '/animanga-logo.png',
  '/js/app.js', '/js/api.js', '/js/aniskip.js', '/js/details.js', '/js/discover.js',
  '/js/dom.js', '/js/download-helpers.js', '/js/downloads.js', '/js/episodes.js',
  '/js/events.js', '/js/jobs.js', '/js/library.js', '/js/playback.js',
  '/js/manga.js', '/js/manga-release-watches.js',
  '/js/player-gestures.js', '/js/progress.js', '/js/release-watches.js', '/js/shows.js',
  '/js/state.js', '/js/status.js', '/js/util.js',
  '/js/sync.js',
];

function isVideoOrProxy(url) {
  return url.pathname === '/api/proxy' || /^\/api\/downloads\/[^/]+\/[^/]+\/file$/.test(url.pathname);
}

function isCacheableApi(request, url) {
  return request.method === 'GET' && url.pathname.startsWith('/api/') && !isVideoOrProxy(url);
}

async function cachedOfflineResponse(request, cacheName) {
  const cached = await caches.match(request, { cacheName });
  if (!cached) return null;
  const headers = new Headers(cached.headers);
  headers.set('x-animanga-cache', 'offline');
  headers.set('x-ani-web-cache', 'offline');
  const cachedAt = Date.parse(headers.get('x-animanga-cached-at') || headers.get('x-ani-web-cached-at') || '');
  if (Number.isFinite(cachedAt)) {
    const age = String(Math.max(0, Math.floor((Date.now() - cachedAt) / 1000)));
    headers.set('x-animanga-cache-age', age);
    headers.set('x-ani-web-cache-age', age);
  }
  return new Response(await cached.blob(), {
    status: cached.status,
    statusText: cached.statusText,
    headers,
  });
}

async function networkFirst(request, cacheName, fallbackRequest = null) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(cacheName);
      const copy = response.clone();
      const headers = new Headers(copy.headers);
      const cachedAt = new Date().toISOString();
      headers.set('x-animanga-cached-at', cachedAt);
      headers.set('x-ani-web-cached-at', cachedAt);
      const cachedResponse = new Response(await copy.blob(), {
        status: copy.status,
        statusText: copy.statusText,
        headers,
      });
      await cache.put(request, cachedResponse).catch(() => {});
    }
    return response;
  } catch (err) {
    const cached = await cachedOfflineResponse(request, cacheName);
    if (cached) return cached;
    if (fallbackRequest) {
      const fallback = await cachedOfflineResponse(fallbackRequest, cacheName);
      if (fallback) return fallback;
    }
    throw err;
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  const active = new Set([SHELL_CACHE, API_CACHE]);
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((key) => !active.has(key)).map((key) => caches.delete(key))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (isVideoOrProxy(url) || (url.pathname.startsWith('/api/') && event.request.method !== 'GET')) return;
  if (isCacheableApi(event.request, url)) {
    event.respondWith(networkFirst(event.request, API_CACHE));
    return;
  }
  const fallback = event.request.mode === 'navigate' ? new Request('/index.html') : null;
  event.respondWith(networkFirst(event.request, SHELL_CACHE, fallback));
});
