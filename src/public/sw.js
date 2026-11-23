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
// our own (set in pushToUser): { title, body, url, tag, icon, badge,
// actions }. Title/body are composed server-side in the recipient's
// locale; icon is the brand calendar, badge the monochrome silhouette
// Android uses for the status-bar glyph.
self.addEventListener("push", (event) => {
  let data = { title: "ByWave", body: "" };
  try {
    if (event.data) data = event.data.json();
  } catch { /* malformed payload; just show the defaults */ }
  // 同步唤醒信号（增量同步第三批）：不展示成普通通知，走专门的唤醒路。
  if (data && data.type === "events_sync") {
    event.waitUntil(handleSyncPush(data));
    return;
  }
  const opts = {
    body: data.body || "",
    icon: data.icon || "/static/icons/icon-192.png",
    badge: data.badge || "/static/icons/badge-72.png",
    tag: data.tag || "bwc-default",
    data: { url: data.url || "/app" },
    // Action buttons (e.g. "View"). The spec caps us at two; anything
    // malformed is dropped rather than breaking the whole notification.
    actions: Array.isArray(data.actions)
      ? data.actions
          .filter((a) => a && typeof a.action === "string" && typeof a.title === "string")
          .slice(0, 2)
      : undefined,
    requireInteraction: false,
  };
  event.waitUntil(self.registration.showNotification(data.title || "ByWave", opts));
});

// 同步唤醒信号的处理：载荷里没有任何事件数据（服务端纪律，见
// lib/sync_push.ts），唯一的任务是叫醒打开着的页面，让它自己走带鉴权
// 的增量拉取。页面没打开时什么都不用做 —— 下次打开自会拉齐。
async function handleSyncPush(data) {
  const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const c of all) {
    try { c.postMessage({ type: "bwc-events-sync" }); } catch { /* 窗口正关着就算了 */ }
  }
  // 展示口径：订阅是 userVisibleOnly: true 建的（见设置页），平台要求
  // 每次 push 都得展示一条通知；不展示的话 Chrome 会代劳弹一条「此网
  // 站已在后台更新」的通用通知，反而更打扰、还不受我们控制。所以照
  // 规矩展示一条静默的、同 tag 的（多次信号在通知中心里也只占一格），
  // 然后立刻关掉 —— 页面已经去拉增量了，把「日历有更新」留在通知
  // 中心里只是噪音。
  const tag = data.tag || "bwc-events-sync";
  await self.registration.showNotification(data.title || "ByWave", {
    body: "",
    icon: data.icon || "/static/icons/icon-192.png",
    badge: data.badge || "/static/icons/badge-72.png",
    tag,
    silent: true,
    data: { url: data.url || "/app" },
  });
  const shown = await self.registration.getNotifications({ tag });
  for (const n of shown) n.close();
}

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
