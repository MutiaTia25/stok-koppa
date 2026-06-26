// ===== KOPPA STOK - Service Worker =====
const CACHE_NAME = 'koppa-stok-v1';
const OFFLINE_URL = '/';

// File yang di-cache saat install (app shell)
const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/app.js',
  '/manifest.json',
  'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js',
  'https://unpkg.com/html5-qrcode',
  'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap'
];

// ===== INSTALL: cache semua file penting =====
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(PRECACHE_URLS).catch(err => {
        console.warn('[SW] Beberapa file tidak bisa di-cache:', err);
      });
    }).then(() => self.skipWaiting())
  );
});

// ===== ACTIVATE: hapus cache lama =====
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// ===== FETCH: strategi cerdas per tipe request =====
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // API request → Network first, fallback ke response offline
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(networkFirstAPI(event.request));
    return;
  }

  // File statis (JS, CSS, font, gambar) → Cache first
  if (
    event.request.destination === 'script' ||
    event.request.destination === 'style' ||
    event.request.destination === 'font' ||
    event.request.destination === 'image'
  ) {
    event.respondWith(cacheFirst(event.request));
    return;
  }

  // HTML / navigasi → Network first, fallback ke cache
  event.respondWith(networkFirstHTML(event.request));
});

// ===== STRATEGI: Network first untuk API =====
async function networkFirstAPI(request) {
  try {
    const response = await fetch(request.clone());
    // Simpan response API ke cache (biar bisa dilihat offline)
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    // Offline → kembalikan data cache terakhir
    const cached = await caches.match(request);
    if (cached) return cached;
    // Tidak ada cache → kembalikan JSON error yang ramah
    return new Response(
      JSON.stringify({ error: 'Tidak ada koneksi internet. Data tidak dapat diperbarui.' }),
      { status: 503, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

// ===== STRATEGI: Cache first untuk aset statis =====
async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    return new Response('', { status: 408 });
  }
}

// ===== STRATEGI: Network first untuk HTML =====
async function networkFirstHTML(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(request) || await caches.match('/');
    return cached || new Response('<h1>Tidak ada koneksi internet</h1>', {
      headers: { 'Content-Type': 'text/html' }
    });
  }
}
