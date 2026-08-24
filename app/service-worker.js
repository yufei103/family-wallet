const CACHE = 'family-wallet-v2-cloud-11';
const ASSETS = [
  './', './index.html', './styles.css', './main.js', './ledger.js', './items.js', './item-media.js', './items-view.js', './cloud-sync.js',
  './firebase-config.js', './firebase-client.js', './manifest.webmanifest',
  './icons/favicon-32.png', './icons/apple-touch-icon.png', './icons/icon-192.png', './icons/icon-512.png', './icons/icon-maskable-512.png'
];

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
