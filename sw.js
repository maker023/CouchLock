/**
 * CouchLock — Service Worker
 *
 * Handles caching for offline PWA support.
 * Cache-first for static assets, network-first for transport.
 */
var CACHE_NAME = 'couchlock-v2';
var STATIC_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './transport.js'
];

// Install — pre-cache static assets
self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      return cache.addAll(STATIC_ASSETS);
    })
  );
  self.skipWaiting();
});

// Activate — clean old caches
self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (names) {
      return Promise.all(
        names.filter(function (name) {
          return name !== CACHE_NAME;
        }).map(function (name) {
          return caches.delete(name);
        })
      );
    })
  );
  self.clients.claim();
});

// Fetch — cache-first for static, network-first for everything else
self.addEventListener('fetch', function (event) {
  var url = new URL(event.request.url);

  // Skip non-GET and WebSocket requests
  if (event.request.method !== 'GET') return;
  if (url.protocol === 'wss:' || url.protocol === 'ws:') return;

  event.respondWith(
    caches.match(event.request).then(function (cached) {
      if (cached) return cached;

      return fetch(event.request).then(function (response) {
        // Cache successful responses for same-origin
        if (response.ok && url.origin === self.location.origin) {
          var clone = response.clone();
          caches.open(CACHE_NAME).then(function (cache) {
            cache.put(event.request, clone);
          });
        }
        return response;
      }).catch(function () {
        // Offline fallback — return cached index for navigation
        if (event.request.mode === 'navigate') {
          return caches.match('./index.html');
        }
      });
    })
  );
});
