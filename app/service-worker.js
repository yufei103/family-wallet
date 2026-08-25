const CACHE = 'family-wallet-v2-cloud-23';
const ASSETS = [
  './', './index.html', './styles.css', './main.js', './ledger.js', './items.js', './item-media.js', './items-view.js', './cloud-sync.js',
  './backup-restore.js', './wallet-features.js', './firebase-config.js', './firebase-client.js', './manifest.webmanifest',
  './icons/favicon-32.png', './icons/apple-touch-icon.png', './icons/icon-192.png', './icons/icon-512.png', './icons/icon-maskable-512.png'
];

self.addEventListener('install', event => event.waitUntil(
  caches.open(CACHE)
    .then(cache => cache.addAll(ASSETS.map(asset => new Request(asset, { cache:'reload' }))))
    .then(() => self.skipWaiting())
));

self.addEventListener('activate', event => event.waitUntil(
  caches.keys()
    .then(cacheNames => Promise.all(cacheNames
      .filter(cacheName => cacheName !== CACHE)
      .map(cacheName => caches.delete(cacheName))))
    .then(() => self.clients.claim())
    .then(() => self.clients.matchAll({ type:'window', includeUncontrolled:true }))
    .then(windowClients => Promise.all(windowClients.map(client => client.postMessage({
      type:'FAMILY_WALLET_UPDATE_READY',
      cache:CACHE
    }))))
));

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          const copy = response.clone();
          event.waitUntil(caches.open(CACHE).then(cache => cache.put('./index.html', copy)));
          return response;
        })
        .catch(() => caches.match('./index.html'))
    );
    return;
  }
  event.respondWith(
    caches.match(event.request)
      .then(cached => cached || fetch(event.request))
      .catch(() => Response.error())
  );
});
