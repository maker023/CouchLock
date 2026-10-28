/**
 * CouchLock — Service Worker
 *
 * Handles caching for offline PWA support.
 * Network-first for navigations, cache-first for static assets.
 * Shows the laptop's push notifications while the app is closed.
 */
var CACHE_NAME = 'couchlock-v10';
// Scripts are cache-first, so index.html loads them with a ?v= version. Bump it
// (here and in index.html) whenever a script changes, or an installed app can
// pair a new page with an old cached script.
var STATIC_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './transport.js?v=4',
  './discovery.js?v=1'
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

  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).then(function (response) {
        if (response.ok && url.origin === self.location.origin) {
          var copy = response.clone();
          caches.open(CACHE_NAME).then(function (cache) { cache.put('./index.html', copy); });
        }
        return response;
      }).catch(function () { return caches.match('./index.html'); })
    );
    return;
  }

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

// ── Push notifications ──
// Sent by the laptop's extension only while the app is off screen (it toasts
// in-app otherwise). iOS revokes subscriptions whose pushes show nothing, so
// every push becomes a visible notification.
self.addEventListener('push', function (event) {
  var note = {};
  try {
    note = event.data ? event.data.json() : {};
  } catch (e) {
    // Unreadable payload: still show something.
  }
  event.waitUntil(self.registration.showNotification(note.title || 'CouchLock', {
    body: note.body || '',
    tag: note.kind || 'couchlock',
    icon: 'icons/icon-192.png',
    data: { kind: note.kind || '' }
  }));
});

// Playback notifications open the remote on Media; "laptop connected" opens
// wherever the user left it.
self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  var kind = event.notification.data ? event.notification.data.kind : '';
  var mode = kind && kind !== 'connected' ? 'media' : '';
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (windows) {
    if (windows.length > 0) {
      if (mode) windows[0].postMessage({ type: 'open_mode', mode: mode });
      return windows[0].focus();
    }
    return self.clients.openWindow(new URL('./index.html' + (mode ? '#' + mode : ''), self.registration.scope).href);
  }));
});
