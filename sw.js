/* ══════════════════════════════════════════
   TelecomLab — Service Worker
   Strategia: Cache-First per assets statici,
   Network-First per le chiamate API
══════════════════════════════════════════ */

const CACHE_NAME = 'telecomlab-v1.1';
const CACHE_DURATION = 7 * 24 * 60 * 60 * 1000; // 7 giorni

// File da mettere in cache all'installazione
const PRECACHE_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  'https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&family=Outfit:wght@300;400;500;600;700;900&display=swap',
];

/* ── INSTALL ── */
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      console.log('[SW] Pre-caching assets...');
      return cache.addAll(PRECACHE_ASSETS).catch(err => {
        console.warn('[SW] Pre-cache partial failure (ok):', err);
      });
    }).then(() => self.skipWaiting())
  );
});

/* ── ACTIVATE ── */
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key !== CACHE_NAME)
          .map(key => {
            console.log('[SW] Deleting old cache:', key);
            return caches.delete(key);
          })
      )
    ).then(() => self.clients.claim())
  );
});

/* ── FETCH ── */
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // Non intercettare chiamate API esterne (Gemini, Anthropic) — sempre network
  if (url.hostname === 'api.anthropic.com' ||
      url.hostname === 'generativelanguage.googleapis.com') {
    event.respondWith(fetch(request));
    return;
  }

  // Non intercettare chiamate al backend Vercel /api/*
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(fetch(request));
    return;
  }

  // Non intercettare richieste non-GET
  if (request.method !== 'GET') return;

  // Strategia Cache-First per tutto il resto
  event.respondWith(
    caches.match(request).then(cached => {
      if (cached) {
        // Aggiorna la cache in background (stale-while-revalidate)
        fetch(request).then(response => {
          if (response && response.status === 200) {
            caches.open(CACHE_NAME).then(cache => cache.put(request, response));
          }
        }).catch(() => {});
        return cached;
      }

      // Non in cache: fetch dal network e metti in cache
      return fetch(request).then(response => {
        if (!response || response.status !== 200 || response.type === 'opaque') {
          return response;
        }
        const toCache = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(request, toCache));
        return response;
      }).catch(() => {
        // Fallback per pagine HTML offline
        if (request.destination === 'document') {
          return caches.match('./index.html');
        }
      });
    })
  );
});

/* ── BACKGROUND SYNC (opzionale) ── */
self.addEventListener('sync', event => {
  if (event.tag === 'sync-results') {
    console.log('[SW] Background sync: results');
  }
});

/* ── PUSH NOTIFICATIONS (struttura per future estensioni) ── */
self.addEventListener('push', event => {
  if (!event.data) return;
  const data = event.data.json();
  event.waitUntil(
    self.registration.showNotification(data.title || 'TelecomLab', {
      body: data.body || 'Hai un nuovo esercizio disponibile!',
      icon: './icons/icon-192.png',
      badge: './icons/icon-192.png',
      tag: 'telecomlab-notification',
      renotify: false,
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    clients.openWindow('./')
  );
});
