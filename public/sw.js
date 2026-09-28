// Service worker: keeps the app itself (HTML/JS/CSS/icons) available offline.
// Data is NOT cached here — the client/job data lives in IndexedDB (src/data.js). /api is never touched.
const BUILD = '__BUILD_ID__'; // replaced at build time so every deploy gets a fresh cache
const CACHE = `tt-shell-${BUILD}`;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    const res = await fetch('/index.html', { cache: 'reload' });
    const html = await res.clone().text();
    await cache.put('/index.html', res);
    // Precache everything the page needs (hashed JS/CSS, icons, manifest) so the FIRST offline launch works.
    const urls = [...new Set([...html.matchAll(/(?:src|href)="(\/[^"/][^"]*)"/g)].map((m) => m[1]))];
    await Promise.all(urls.map((u) => cache.add(u).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('tt-shell-') && k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/.netlify/')) return; // straight to the network

  if (req.mode === 'navigate') { // app launch: fresh copy when there is signal, cached copy when there isn't
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      try {
        const ctl = new AbortController();
        const t = setTimeout(() => ctl.abort(), 4000); // weak signal: don't make the user wait on a hung request
        const res = await fetch('/index.html', { signal: ctl.signal });
        clearTimeout(t);
        if (res.ok) { cache.put('/index.html', res.clone()); return res; }
      } catch { /* offline or slow */ }
      return (await cache.match('/index.html')) || Response.error();
    })());
    return;
  }

  event.respondWith((async () => { // static files: cached first (hashed names never change), else network + remember
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req);
    if (hit) return hit;
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  })());
});
