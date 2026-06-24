/* =========================================================
 *  Service Worker — ระบบแจ้งเตือนวันหมดอายุและนัดหมาย
 *  ทำให้แอปเปิดได้แบบออฟไลน์ (cache app shell)
 *  *** เปลี่ยนเลข CACHE_VERSION ทุกครั้งที่แก้ไฟล์ เพื่อบังคับอัปเดต ***
 * ========================================================= */
const CACHE_VERSION = 'v10';
const CACHE_NAME = `reminder-app-${CACHE_VERSION}`;

// ไฟล์หลักของแอป (App Shell) ที่ต้อง cache ไว้ให้ใช้ออฟไลน์
const CORE_ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

// ----- ติดตั้ง: cache ไฟล์หลัก -----
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(CORE_ASSETS))
  );
  self.skipWaiting(); // เปิดใช้ SW ใหม่ทันที
});

// ----- เปิดใช้งาน: ลบ cache เวอร์ชันเก่า -----
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

// ----- จัดการ request -----
self.addEventListener('fetch', (event) => {
  const req = event.request;

  // ข้ามทุกอย่างที่ไม่ใช่ GET (เช่น POST ไป Google Apps Script)
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // ข้อมูลจาก Google Apps Script -> network-only เสมอ (ต้องสดใหม่)
  if (url.hostname.includes('script.google.com')) return;

  // ไฟล์ของแอปเอง (same-origin) -> cache-first
  if (url.origin === location.origin) {
    event.respondWith(
      caches.match(req).then((cached) => cached || fetchAndCache(req))
    );
    return;
  }

  // ทรัพยากรภายนอก (Tailwind CDN, Google Fonts) -> stale-while-revalidate
  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetchAndCache(req).catch(() => cached);
      return cached || network;
    })
  );
});

// helper: โหลดจาก network แล้วเก็บลง cache
function fetchAndCache(req) {
  return fetch(req).then((res) => {
    // เก็บเฉพาะ response ที่ใช้ได้ (กัน opaque error ที่ขนาด 0)
    if (res && (res.ok || res.type === 'opaque')) {
      const copy = res.clone();
      caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
    }
    return res;
  });
}
