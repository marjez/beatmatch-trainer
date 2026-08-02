// sw.js — offline support. App shell is precached; fonts cached on first use.
// Audio never touches the network: it lives in IndexedDB.
const CACHE = 'bmt-v3';
const SHELL = [
  './',
  './index.html',
  './css/app.css',
  './js/app.js',
  './js/db.js',
  './js/vendor/web-audio-beat-detector.mjs',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // Fonts: cache-first with network fill
  if (url.hostname.includes('fonts.g')) {
    e.respondWith(
      caches.match(e.request).then(hit => hit || fetch(e.request).then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
        return res;
      }).catch(() => new Response('', { status: 503 })))
    );
    return;
  }
  // Shell: cache-first, network fallback (so updates arrive when online)
  e.respondWith(
    caches.match(e.request).then(hit => hit || fetch(e.request))
  );
});
