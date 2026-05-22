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
  if (url.pathname.startsWith("/embed/")) return;
  if (url.pathname.startsWith("/login") || url.pathname.startsWith("/admin")) return;
  if (url.pathname.startsWith("/reset-pwa")) return;  // never intercept the rescue page

  // Network-first for HTML, cache-first for static assets.
  // BIG ONE: only cache 200-OK responses. Caching 4xx / 5xx / opaque
  // would mean a transient server crash gets pinned to the device
  // forever, and the user sees a stale broken page even after we fix
  // the server. (This bit us hard during the rrule CJS crash loop.)
  const isStatic = url.pathname.startsWith("/static/");
  if (isStatic) {
    event.respondWith(
      caches.match(req).then((cached) => {
        if (cached) return cached;
        return fetch(req).then((resp) => {
          // Only cache successful, same-origin, basic responses.
          if (resp && resp.ok && resp.status === 200 && resp.type === "basic") {
            const copy = resp.clone();
            caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => undefined);
          }
          return resp;
        });
      }),
    );
  } else {
    // HTML: network-first. On network failure, fall back to cache,
    // or to a friendly offline page if even the cache is empty.
    // Don't cache the response — HTML carries per-request CSP nonces
    // and CSRF tokens, caching it serves the wrong nonce/csrf to a
    // later request and breaks every form on the page.
    event.respondWith(
      fetch(req).catch(() =>
        caches.match(req).then((c) => c || offlineHtml(req))),
    );
  }
});

// Pretty offline page. Way better than `new Response("Offline")`,
// which is what the user actually saw before — a stray "Offline"
// string on a blank screen with zero context or recovery path.
// Self-contained: no external CSS, no JS dependencies, works
// regardless of what the rest of the app is doing.
function offlineHtml(req) {
  const path = (() => {
    try { return new URL(req.url).pathname; } catch { return "/"; }
  })();
  const html = `<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>暂时无法连接 · ByWave</title>
<style>
  body { font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
         max-width: 420px; margin: 0 auto; padding: 48px 24px; color: #0f172a;
         background: linear-gradient(180deg, #f8fafc 0%, #f1f5f9 100%); min-height: 100vh; }
  .card { background: #fff; border: 1px solid #e2e8f0; border-radius: 16px;
          padding: 32px 24px; box-shadow: 0 1px 3px rgba(15,23,42,0.04); }
  .emoji { font-size: 48px; margin-bottom: 12px; }
  h1 { font-size: 20px; margin: 0 0 8px; }
  p { color: #475569; margin: 6px 0; }
  .actions { display: flex; flex-direction: column; gap: 10px; margin-top: 24px; }
  button, a.btn { display: block; padding: 12px; text-align: center;
                  border-radius: 10px; font-size: 14px; font-weight: 500;
                  text-decoration: none; cursor: pointer; border: 0; }
  .primary { background: #4f46e5; color: #fff; }
  .primary:hover { background: #4338ca; }
  .secondary { background: #fff; color: #475569; border: 1px solid #e2e8f0; }
  .secondary:hover { background: #f8fafc; }
  code { background: #f1f5f9; padding: 2px 6px; border-radius: 4px; font-size: 13px; }
</style>
</head><body>
<div class="card">
  <div class="emoji">📡</div>
  <h1>暂时连不上服务器</h1>
  <p>正在请求 <code>${path}</code>，但服务器没有响应。可能原因：</p>
  <ul style="color:#475569;font-size:14px;padding-left:20px;margin:8px 0;">
    <li>你的网络断开了</li>
    <li>服务器临时无响应（如重启中）</li>
    <li>运营商或防火墙在丢弃请求</li>
  </ul>
  <div class="actions">
    <button class="primary" onclick="location.reload()">重试</button>
    <a class="btn secondary" href="/reset-pwa">清理缓存重新加载</a>
  </div>
</div>
</body></html>`;
  return new Response(html, {
    status: 503,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}
