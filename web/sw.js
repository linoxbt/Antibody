// Antibody service worker: makes the console installable and lets its shell
// open offline. Network first, always: a cached page is shown only when the
// network is unreachable. API answers (/api/*) are never cached, so state,
// payments and quarantines are always live or plainly unavailable.
const CACHE = 'antibody-shell-v1';
const SHELL = ['/app', '/login', '/offline.html', '/assets/css/brand.css', '/assets/css/app.css', '/assets/img/mark.svg', '/assets/img/icon-192.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/') || url.pathname.startsWith('/owner/')) return;
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok && (req.mode === 'navigate' || url.pathname.startsWith('/assets/'))) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(async () => (await caches.match(req)) ?? (req.mode === 'navigate' ? (await caches.match(url.pathname.startsWith('/app') ? '/app' : '/offline.html')) ?? Response.error() : Response.error())),
  );
});
