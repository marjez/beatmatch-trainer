// sw.js — offline support. App shell is precached; fonts cached on first use.
// Audio never touches the network: it lives in IndexedDB.
const CACHE = 'bmt-v33';

self.addEventListener('message', e => {
  if (e.data === 'skipWaiting') self.skipWaiting();
});
// The build stamp index.html puts on its script and stylesheet URLs. The
// precache must fetch the SAME urls the page asks for, or the two disagree.
const V = CACHE;
const SHELL = [
  './',
  './index.html',
  './css/app.css',
  './js/app.js',
  './js/db.js',
  './js/beats.js',
  './js/vendor/web-audio-beat-detector.mjs',
  './manifest.webmanifest',
  './demo/crate.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];

// Versioned copies of the files index.html requests with ?v=. Precaching the
// bare urls with addAll used the HTTP cache, and GitHub Pages serves
// max-age=600 — so a worker installing within ten minutes of the previous
// deploy could precache the PREVIOUS build's JS with zero server hits, and
// the offline app then ran new HTML against old JS. `cache: 'reload'` bypasses
// the HTTP cache; the versioned urls keep the two in step.
const VERSIONED = ['./css/app.css', './js/app.js', './js/db.js', './js/beats.js'];
const precacheList = () => [
  ...SHELL,
  ...VERSIONED.map(u => `${u}?v=${V}`),
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => Promise.all(
    precacheList().map(u => fetch(new Request(u, { cache: 'reload' }))
      .then(res => { if (res.ok) return c.put(u, res); throw new Error(`precache ${u}: ${res.status}`); }))
  )));
  // NOTE: no skipWaiting() here. It made the message gate and the "Check for
  // update" button cosmetic — every new worker took over at once and the page
  // reloaded under the user's thumb, mid-round, or during the first-run file
  // picker. The page decides when to take an update now.
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
  // Network-first, but not network-forever: iOS waits 60 s on a request that
  // never answers, and a fully cached app sat blank for the whole of it on a
  // slow link (measured 18 s to boot with 6 s responses). After NET_TIMEOUT_MS
  // the cache answers and the network copy still refreshes the cache.
  const NET_TIMEOUT_MS = 2500;
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('slow')), NET_TIMEOUT_MS));
  const fromCache = () => caches.match(e.request)
    .then(hit => hit || caches.match(e.request, { ignoreSearch: true }))
    .then(hit => hit || (e.request.mode === 'navigate' ? caches.match('./index.html') : undefined));
  const network = fetch(e.request)
    .then(res => {
        if (res && res.ok && e.request.method === 'GET') {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
        }
        return res;
      });
  // fromCache matches EXACTLY first: with both `app.js` and `app.js?v=…` in
  // the cache, ignoreSearch returns whichever was inserted first — the
  // unversioned precache — so a stale copy beat the newer versioned one.
  e.respondWith(
    Promise.race([network, timeout])
      .catch(() => fromCache().then(hit => hit || network))
  );
});
