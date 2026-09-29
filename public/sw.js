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

// Alerts: the push itself carries no text. Ask the server (with the owner's own sign-in) what happened, then show it.
self.addEventListener('push', (event) => {
  event.waitUntil((async () => {
    let title = 'Quote accepted', body = 'A customer accepted your quote. Open the app to see who.';
    try {
      const res = await fetch('/api/push/latest', { credentials: 'same-origin' });
      const d = res.ok ? await res.json() : {};
      if (d.name && d.kind === 'declined') {
        title = `${d.name} declined your quote`;
        body = 'Open the app to see why and follow up.';
      } else if (d.name) {
        title = `${d.name} accepted your quote`;
        body = d.total_cents != null ? `${(d.total_cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })}. Call them to schedule the job.` : 'Call them to schedule the job.';
      }
    } catch { /* offline: the generic message is fine */ }
    await self.registration.showNotification(title, { body, icon: '/icons/icon-192.png', badge: '/icons/icon-192.png', tag: 'quote-accepted', renotify: true });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const open = all.find((c) => new URL(c.url).origin === self.location.origin);
    if (open) return open.focus();
    return self.clients.openWindow('/');
  })());
});
