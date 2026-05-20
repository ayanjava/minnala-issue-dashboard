/* Minnala Issue Dashboard — service worker.
 *
 * Strategy:
 *   - Shell (HTML/CSS/JS/icons/manifest) → cache-first with network
 *     fallback. Lets the app open instantly + install as a PWA, and
 *     keeps it usable offline (read-only — data won't refresh).
 *   - GitHub API + taxonomy.json → network-only, never cached. Data
 *     must always be fresh; stale issues would mislead the user.
 *
 * Bump CACHE_VERSION on every shell change so old caches are evicted.
 */
const CACHE_VERSION = 'minnala-dashboard-v3-2026-05-17';
const SHELL_ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.json',
  './icon.svg',
  './icon-192.png',
  './icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(SHELL_ASSETS)),
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))),
    ),
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Network-only: live data must not be cached.
  if (
    url.hostname === 'api.github.com' ||
    url.hostname === 'raw.githubusercontent.com' ||
    url.pathname.endsWith('taxonomy.json')
  ) {
    return;   // let the browser handle it without SW interference
  }

  // Cache-first for the shell. Falls through to network on miss.
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((resp) => {
        // Best-effort cache populate for same-origin GETs.
        if (
          resp.ok && event.request.method === 'GET' &&
          url.origin === self.location.origin
        ) {
          const clone = resp.clone();
          caches.open(CACHE_VERSION).then((c) => c.put(event.request, clone));
        }
        return resp;
      });
    }),
  );
});
