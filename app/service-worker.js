const CACHE = 'family-wallet-v2-cloud-6';
const ASSETS = ['./', './index.html', './styles.css', './main.js', './ledger.js', './firebase-config.js', './firebase-client.js', './manifest.webmanifest'];

self.addEventListener('install', event => event.waitUntil(
  caches.open(CACHE)
    .then(cache => cache.addAll(ASSETS))
    .then(() => self.skipWaiting())
));

self.addEventListener('activate', event => event.waitUntil(
  caches.keys()
    .then(cacheNames => Promise.all(cacheNames
      .filter(cacheName => cacheName !== CACHE)
      .map(cacheName => caches.delete(cacheName))))
    .then(() => self.clients.claim())
));

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    caches.match(event.request)
      .then(cached => cached || fetch(event.request))
      .catch(() => event.request.mode === 'navigate'
        ? caches.match('./index.html')
        : Response.error())
  );
});
