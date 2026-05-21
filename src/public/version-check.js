// Detect new server version and prompt the user to refresh.
// Compares the page's data-app-version (set at render time) with whatever
// /api/version returns. Mismatch ⇒ shows a sticky toast at top.
(function () {
  "use strict";
  const local = document.documentElement.getAttribute("data-app-version") || "0";
  if (!local || local === "0") return;
  let dismissedFor = null;
  let banner = null;

  function showBanner(remote) {
    if (banner) return;
    banner = document.createElement("div");
    banner.id = "bwc-update-banner";
    banner.setAttribute("role", "status");
    banner.className = "fixed top-3 left-1/2 -translate-x-1/2 z-[60] flex items-center gap-3 rounded-full bg-slate-900 text-white text-sm shadow-lg px-4 py-2 pointer-events-auto";
    banner.innerHTML = `
      <span>🔄 新版本已发布</span>
      <button type="button" data-act="refresh" class="rounded-full bg-white text-slate-900 px-3 py-0.5 text-xs font-medium hover:bg-slate-100">立即更新</button>
      <button type="button" data-act="dismiss" class="text-slate-300 hover:text-white text-xs px-1" aria-label="稍后">稍后</button>
    `;
    document.body.appendChild(banner);
    banner.querySelector('[data-act="refresh"]').addEventListener("click", () => doRefresh());
    banner.querySelector('[data-act="dismiss"]').addEventListener("click", () => {
      dismissedFor = remote;
      banner.remove();
      banner = null;
    });
  }

  async function doRefresh() {
    try {
      // Tell any waiting SW to take over.
      if ("serviceWorker" in navigator) {
        const reg = await navigator.serviceWorker.getRegistration();
        if (reg && reg.waiting) reg.waiting.postMessage({ type: "SKIP_WAITING" });
      }
      // Clear all caches so the next load is fresh.
      if (window.caches) {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
      }
    } catch (e) { /* ignore */ }
    // Force-reload bypassing HTTP cache.
    window.location.reload();
  }

  async function check() {
    try {
      const resp = await fetch("/api/version", { cache: "no-store", credentials: "same-origin" });
      if (!resp.ok) return;
      const data = await resp.json();
      const remote = String(data.version || "");
      if (!remote || remote === local) return;
      if (remote === dismissedFor) return;
      showBanner(remote);
    } catch (e) { /* offline / blocked, ignore */ }
  }

  // Check on load, on tab focus, and every 5 minutes.
  window.addEventListener("load", check);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) check(); });
  setInterval(check, 5 * 60 * 1000);
})();
