/**
 * Opengravity Service Worker — PWA offline support + caching
 */
const CACHE_NAME = 'og-v3';
const STATIC_ASSETS = [
    '/',
    '/css/styles.css',
    '/js/app.js',
    '/manifest.json',
    '/icons/icon-192.svg',
];

// Install — cache static assets
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_ASSETS))
    );
    self.skipWaiting();
});

// Activate — clean old caches
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then(keys =>
            Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
        )
    );
    self.clients.claim();
});

// Fetch — network-first for API, cache-first for static
self.addEventListener('fetch', (event) => {
    const { request } = event;
    const url = new URL(request.url);

    // API requests — network only (never cache)
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/snapshot/') || url.pathname.startsWith('/send/')) {
        return;
    }

    // WebSocket — don't intercept
    if (request.headers.get('upgrade') === 'websocket') return;

    // Static assets — stale-while-revalidate
    event.respondWith(
        caches.match(request).then(cached => {
            const networkFetch = fetch(request).then(response => {
                if (response.ok) {
                    const clone = response.clone();
                    caches.open(CACHE_NAME).then(cache => cache.put(request, clone));
                }
                return response;
            }).catch(() => cached);

            return cached || networkFetch;
        })
    );
});

// Push notifications
self.addEventListener('push', (event) => {
    const data = event.data?.json() || {};
    event.waitUntil(
        self.registration.showNotification(data.title || 'Opengravity', {
            body: data.body || 'Task update',
            icon: '/icons/icon-192.svg',
            badge: '/icons/icon-192.svg',
            tag: data.tag || 'og-notification',
            data: data.url || '/',
        })
    );
});

self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    event.waitUntil(
        clients.openWindow(event.notification.data || '/')
    );
});
