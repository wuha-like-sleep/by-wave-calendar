// Minimal service worker — registered for PWA install eligibility.
// __ASSET_VERSION__ is replaced server-side by ASSET_VERSION on every boot
// so each deploy gets a fresh cache bucket and the old ones are evicted in activate().
const CACHE = "bwc-shell-__ASSET_VERSION__";
const SHELL = ["/", "/app", "/static/css/styles.css"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => undefined),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter((k) => k !== CACHE && k.startsWith("bwc-shell-")).map((k) => caches.delete(k)),
    )),
  );
  self.clients.claim();
});

// Allow the page to ask the SW to take over immediately after a new version installs.
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});

// ---------- Web Push ----------
// Display the push payload as an OS notification. Payload format is
// our own (set in pushToUser): { title, body, url, tag }.
self.addEventListener("push", (event) => {
  let data = { title: "ByWave", body: "" };
  try {
    if (event.data) data = event.data.json();
  } catch { /* malformed payload; just show the defaults */ }
  const opts = {
    body: data.body || "",
    icon: "/static/icons/icon-192.png",
    // No dedicated badge yet — browsers fall back to icon. If we want
    // monochrome small-badge later, add /static/icons/badge-72.png.
    tag: data.tag || "bwc-default",
    data: { url: data.url || "/app" },
    requireInteraction: false,
  };
  event.waitUntil(self.registration.showNotification(data.title || "ByWave", opts));
});

// On click, open the target URL (focus existing tab if already open).
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || "/app";
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of all) {
      // Same origin and already pointing to our app — just focus it.
      if (c.url.startsWith(self.location.origin) && "focus" in c) {
        c.navigate(targetUrl).catch(() => undefined);
        return c.focus();
      }
    }
    return self.clients.openWindow(targetUrl);
  })());
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
