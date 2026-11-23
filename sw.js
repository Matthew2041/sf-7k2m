// Offline cache. Only static app files are cached; user data lives in encrypted IndexedDB.
const VER = 'sf-v6';
const SHELL = ['./', 'index.html', 'styles.css', 'manifest.json', 'js/app.js', 'js/crypto.js', 'js/db.js', 'js/detect.js', 'js/dom.js', 'js/passkey.js', 'icons/icon-180.png', 'icons/icon-192.png'];

self.addEventListener('install', (e) => { e.waitUntil(caches.open(VER).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VER).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;
  const heavy = /\/(models|vendor)\//.test(u.pathname); // big, immutable: cache-first
  e.respondWith(heavy
    ? caches.match(e.request).then((hit) => hit || fetch(e.request).then((r) => { if (r.ok) caches.open(VER).then((c) => c.put(e.request, r.clone())); return r; }))
    : fetch(e.request).then((r) => { if (r.ok) caches.open(VER).then((c) => c.put(e.request, r.clone())); return r; }).catch(() => caches.match(e.request)));
});
