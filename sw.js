// sw.js — offline support. App shell is precached; fonts cached on first use.
// Audio never touches the network: it lives in IndexedDB.
const CACHE = 'bmt-v21';

self.addEventListener('message', e => {
  if (e.data === 'skipWaiting') self.skipWaiting();
});
const SHELL = [
  './',
  './index.html',
  './css/app.css',
  './js/app.js',
  './js/db.js',
  './js/vendor/web-audio-beat-detector.mjs',
  './manifest.webmanifest',
  './demo/crate.json',
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
  // Anything else cross-origin (the demo crate's audio on archive.org) goes
  // straight to the network: it lands in IndexedDB as a track, so a copy in the
  // cache would only double the storage.
  if (url.origin !== self.location.origin) return;
  // Shell: network-first, cache fallback. Cache-first left users stranded on a
  // stale build — an iOS home-screen app resumed from the switcher never
  // navigates, so a new worker never installs and the old HTML/JS lives on.
  // Still fully offline: any network failure falls straight back to the cache.
  e.respondWith(
    fetch(e.request)
      .then(res => {
        if (res && res.ok && e.request.method === 'GET') {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
        }
        return res;
      })
      // ignoreSearch: the shell is precached without the ?v= build stamp that
      // index.html puts on its script and stylesheet URLs.
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then(hit => hit || caches.match('./index.html')))
  );
});
