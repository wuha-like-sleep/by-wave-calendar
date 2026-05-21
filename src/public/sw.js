// Minimal service worker — registered for PWA install eligibility.
// Cache strategy: network-first for app shell, ignore everything else for now.
const CACHE = "bwc-shell-v1";
const SHELL = ["/", "/app", "/static/css/styles.css"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => undefined),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  // Skip cross-origin and API/dynamic
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return;
  if (url.pathname.startsWith("/ics/")) return;
  if (url.pathname.startsWith("/login") || url.pathname.startsWith("/admin")) return;

  // Network-first for HTML, cache-first for static assets
  const isStatic = url.pathname.startsWith("/static/");
  if (isStatic) {
    event.respondWith(
      caches.match(req).then((cached) => cached || fetch(req).then((resp) => {
        const copy = resp.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => undefined);
        return resp;
      })),
    );
  } else {
    event.respondWith(
      fetch(req).catch(() => caches.match(req).then((c) => c || new Response("Offline", { status: 503 }))),
    );
  }
});
