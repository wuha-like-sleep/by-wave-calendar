// Detect new server version + warn when the page is stuck on a stale
// cache (server unreachable / SW serving from cache).
//
// Two banner states:
//   "update"  — server has a newer version than this page. Auto-reloads
//               after a 5s countdown (button to skip the wait). Clears
//               all caches + unregisters waiting SW before reloading
//               so the next load isn't poisoned by the old cached files.
//   "offline" — /api/version has failed 3+ times in a row, meaning the
//               user is probably staring at a service-worker-cached
//               page that the server can no longer refresh. Offers an
//               "强制清缓存重试" button.
//
// Polls every 30s when the tab is visible, plus immediately on
// load / visibilitychange / pageshow. Stops polling when hidden so
// background tabs don't burn battery.

(function () {
  "use strict";
  const local = document.documentElement.getAttribute("data-app-version") || "0";
  if (!local || local === "0") return;

  let banner = null;
  let bannerKind = null;       // "update" | "offline" | null
  let dismissedFor = null;     // version string the user dismissed
  let failures = 0;            // consecutive /api/version failures
  let pollTimer = null;
  let autoReloadTimer = null;

  // ---- DOM ----

  function buildBanner(kind) {
    removeBanner();
    bannerKind = kind;
    banner = document.createElement("div");
    banner.id = "bwc-update-banner";
    banner.setAttribute("role", "status");
    const bg = kind === "update" ? "bg-emerald-600" : "bg-amber-600";
    banner.className =
      "fixed top-0 inset-x-0 z-[70] " + bg + " text-white shadow-md " +
      "px-4 py-2.5 flex flex-wrap items-center justify-center gap-3 text-sm";
    document.body.appendChild(banner);
    return banner;
  }
  function removeBanner() {
    if (banner) { banner.remove(); banner = null; bannerKind = null; }
    if (autoReloadTimer) { clearInterval(autoReloadTimer); autoReloadTimer = null; }
  }

  function showUpdateBanner(remote) {
    if (bannerKind === "update") return;
    const b = buildBanner("update");
    let countdown = 5;
    b.innerHTML =
      '<span>🎉 新版本已发布</span>' +
      '<span id="bwc-countdown" class="text-xs opacity-90">' + countdown + ' 秒后自动刷新</span>' +
      '<button type="button" data-act="refresh" class="rounded-full bg-white text-emerald-700 px-3 py-0.5 text-xs font-semibold hover:bg-slate-100">立即更新</button>' +
      '<button type="button" data-act="dismiss" class="text-white/70 hover:text-white text-xs px-1" aria-label="跳过本次">本次跳过</button>';
    b.querySelector('[data-act="refresh"]').addEventListener("click", function () { doRefresh(); });
    b.querySelector('[data-act="dismiss"]').addEventListener("click", function () {
      dismissedFor = remote;
      removeBanner();
    });
    autoReloadTimer = setInterval(function () {
      countdown--;
      const el = document.getElementById("bwc-countdown");
      if (el) el.textContent = countdown + " 秒后自动刷新";
      if (countdown <= 0) {
        clearInterval(autoReloadTimer);
        autoReloadTimer = null;
        doRefresh();
      }
    }, 1000);
  }

  function showOfflineBanner() {
    if (bannerKind === "offline") return;
    const b = buildBanner("offline");
    b.innerHTML =
      '<span>⚠️ 服务器似乎不可达，你看到的可能是缓存版本</span>' +
      '<button type="button" data-act="purge" class="rounded-full bg-white text-amber-700 px-3 py-0.5 text-xs font-semibold hover:bg-slate-100">强制清缓存重试</button>' +
      '<button type="button" data-act="dismiss" class="text-white/70 hover:text-white text-xs px-1" aria-label="忽略">忽略</button>';
    b.querySelector('[data-act="purge"]').addEventListener("click", function () { doRefresh(); });
    b.querySelector('[data-act="dismiss"]').addEventListener("click", function () {
      // Dismiss for this tab session only; next failure will bring it back
      // if the user reloads or switches tabs.
      removeBanner();
    });
  }

  // ---- Action: clear everything, reload ----

  async function doRefresh() {
    removeBanner();
    try {
      // 1) Tell any waiting SW to take over immediately.
      if ("serviceWorker" in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations();
        for (const r of regs) {
          if (r.waiting) r.waiting.postMessage({ type: "SKIP_WAITING" });
        }
      }
      // 2) Nuke every cache so the next load is fresh from the network.
      if (window.caches) {
        const keys = await caches.keys();
        await Promise.all(keys.map(function (k) { return caches.delete(k); }));
      }
    } catch (e) { /* ignore */ }
    // 3) Hard reload bypassing HTTP cache.
    window.location.reload();
  }

  // ---- Polling ----

  async function check() {
    try {
      const resp = await fetch("/api/version", { cache: "no-store", credentials: "same-origin" });
      if (!resp.ok) throw new Error("status " + resp.status);
      const data = await resp.json();
      failures = 0;
      // Network is back — if we were showing the "offline" banner, drop it.
      if (bannerKind === "offline") removeBanner();
      const remote = String(data.version || "");
      if (!remote || remote === local) return;
      if (remote === dismissedFor) return;
      showUpdateBanner(remote);
    } catch (e) {
      failures++;
      if (failures >= 3 && bannerKind !== "update") showOfflineBanner();
    }
  }

  function startPolling() {
    if (pollTimer) return;
    // Run once immediately, then every 30s.
    check();
    pollTimer = setInterval(check, 30 * 1000);
  }
  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  window.addEventListener("load", startPolling);
  document.addEventListener("visibilitychange", function () {
    if (document.hidden) stopPolling(); else startPolling();
  });
  // iOS Safari fires pageshow (not load) when returning from bfcache —
  // without this we'd miss the version drift after switching apps.
  window.addEventListener("pageshow", check);
})();
