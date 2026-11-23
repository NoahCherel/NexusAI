const CACHE_NAME = 'nexusai-v2';
const STATIC_ASSETS = ['/', '/chat', '/manifest.json'];

// Install event - cache static assets
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            return cache.addAll(STATIC_ASSETS);
        })
    );
    self.skipWaiting();
});

// Activate event - clean up old caches
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((cacheNames) => {
            return Promise.all(
                cacheNames.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name))
            );
        })
    );
    self.clients.claim();
});

// Fetch event - network first, fallback to cache
self.addEventListener('fetch', (event) => {
    const { request } = event;

    // Only this site's pages: caching every GET (build chunks, other sites, the embedding
    // model) filled the cache forever. A new CACHE_NAME makes `activate` delete the old one.
    if (
        request.method !== 'GET' ||
        request.mode !== 'navigate' ||
        new URL(request.url).origin !== self.location.origin
    )
        return;

    event.respondWith(
        fetch(request)
            .then((response) => {
                // Clone and cache successful responses
                if (response.ok) {
                    const responseClone = response.clone();
                    caches.open(CACHE_NAME).then((cache) => {
                        cache.put(request, responseClone);
                    });
                }
                return response;
            })
            .catch(() => {
                // Fallback to cache on network failure
                return caches.match(request);
            })
    );
});
