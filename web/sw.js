// Antibody service worker: makes the console installable and lets its shell
// open offline. Network first, always: a cached page is shown only when the
// network is unreachable. API answers (/api/*) are never cached, so state,
// payments and quarantines are always live or plainly unavailable.
// The cache is versioned by the build id the page registers with (/sw.js?v=…).
const VERSION = new URL(self.location.href).searchParams.get('v') || 'dev';
const CACHE = 'antibody-shell-' + VERSION;
const SHELL = ['/app', '/login', '/offline.html', '/assets/css/brand.css', '/assets/css/app.css', '/assets/img/mark.svg', '/assets/img/icon-192.png'];
const MAX_ENTRIES = 60;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('antibody-shell-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

const isApp = (p) => p === '/app' || p.startsWith('/app/');

/** The cache key for a response worth keeping, or null. Every /app route is the same page. */
function keyFor(req, url) {
  if (req.mode === 'navigate') return isApp(url.pathname) ? '/app' : url.search ? null : url.pathname;
  if (url.pathname.startsWith('/assets/') || url.pathname === '/demo.json') return url.pathname;
  return null;
}

/** Drop the oldest entries past the cap; the shell itself is never evicted. */
async function trim(c) {
  const extra = (await c.keys()).filter((r) => !SHELL.includes(new URL(r.url).pathname));
  const over = extra.length - (MAX_ENTRIES - SHELL.length);
  await Promise.all(extra.slice(0, Math.max(over, 0)).map((r) => c.delete(r)));
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  const key = keyFor(req, url);
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok && key) {
          const copy = res.clone();
          e.waitUntil(caches.open(CACHE).then(async (c) => (await c.put(key, copy), trim(c))));
        }
        return res;
      })
      .catch(async () => (await caches.match(key ?? (isApp(url.pathname) ? '/app' : url.pathname))) ?? (req.mode === 'navigate' ? ((await caches.match('/offline.html')) ?? Response.error()) : Response.error())),
  );
});
