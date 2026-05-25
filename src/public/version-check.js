// Silent background update — detects a new server version and reloads
// the page on the user's behalf at a moment that won't destroy their
// work. No countdown banner, no "click to refresh" — just appear with
// the new version next time they look.
//
// Reload triggers (first one that hits wins):
//   1. visibilitychange → hidden  — they switched tab / backgrounded
//      the APP / locked their phone. Best window: when they come back
//      they see the new version, and nothing was on screen anyway.
//   2. Idle ≥ 120s — no mousemove / keydown / touchstart / scroll.
//      They're not actively working, safe to swap underneath.
//   3. After 30 min of holding a pending update with no safe window —
//      show a tiny bottom-right chip "↻ 新版本就绪" they can click.
//      Last resort to escape an indefinitely-active tab.
//
// Safety check before any reload: bail (and retry on next trigger) if
//   - an <input> / <textarea> / contenteditable is focused, OR
//   - a <dialog> / [role=dialog] / .modal is currently open, OR
//   - any <form> has data-bwc-dirty="true".
// We'd rather take 5 more minutes than discard their half-written event.
//
// "offline" banner is still useful — when /api/version 3xx-fails in a
// row, the user is staring at a stale SW cache. We tell them.

(function () {
  "use strict";
  const local = document.documentElement.getAttribute("data-app-version") || "0";
  if (!local || local === "0") return;

  let pendingVersion = null;     // remote version we've decided to reload to
  let pendingSince = 0;          // ms timestamp when we first noticed it
  let failures = 0;              // consecutive /api/version failures
  let pollTimer = null;
  let idleTimer = null;
  let chipShown = false;
  let offlineBanner = null;

  const IDLE_MS = 120 * 1000;       // 2 min of no input → safe to reload
  const POLL_MS = 30 * 1000;        // server probe cadence
  const CHIP_AFTER_MS = 30 * 60_000; // 30 min of pending → show chip
  const HIDE_DELAY_MS = 250;        // wait a beat after hidden, in case it's a flicker

  // ---- Safety: is "now" a safe moment to reload? ----

  function isSafeToReload() {
    const ae = document.activeElement;
    if (ae) {
      const tag = ae.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return false;
      if (ae.isContentEditable) return false;
    }
    // Any modal-ish element open? The APP uses `id="modal-*"` containers
    // that toggle Tailwind's .hidden — when one is visible, the user
    // is mid-task and we must not yank the page.
    if (document.querySelector('[id^="modal-"]:not(.hidden)')) return false;
    if (document.querySelector("dialog[open]")) return false;
    if (document.querySelector('[role="dialog"]:not([aria-hidden="true"])')) return false;
    if (document.querySelector(".modal.show, .modal[open], .modal.is-open")) return false;
    // Forms marked dirty by the APP.
    if (document.querySelector('form[data-bwc-dirty="true"]')) return false;
    return true;
  }

  // ---- Reload (clears caches + unregisters waiting SW first) ----

  async function doSilentReload() {
    if (!pendingVersion) return;
    try {
      if ("serviceWorker" in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations();
        for (const r of regs) {
          if (r.waiting) r.waiting.postMessage({ type: "SKIP_WAITING" });
        }
      }
      if (window.caches) {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
      }
    } catch (_e) { /* ignore — reload regardless */ }
    window.location.reload();
  }

  function tryReload() {
    if (!pendingVersion) return false;
    if (!isSafeToReload()) return false;
    doSilentReload();
    return true;
  }

  // ---- Triggers ----

  function onVisibilityChange() {
    if (document.hidden && pendingVersion) {
      // Page just got hidden. Give it a brief moment then reload silently.
      // The user comes back to the new version with no perceived friction.
      setTimeout(() => {
        if (document.hidden) tryReload();
      }, HIDE_DELAY_MS);
    }
  }

  function resetIdleTimer() {
    if (idleTimer) clearTimeout(idleTimer);
    if (!pendingVersion) return;
    idleTimer = setTimeout(() => {
      if (pendingVersion) tryReload();
    }, IDLE_MS);
  }

  function bindIdleEvents() {
    const events = ["mousemove", "keydown", "touchstart", "scroll", "click"];
    for (const e of events) {
      window.addEventListener(e, resetIdleTimer, { passive: true });
    }
  }

  // ---- The "I've been waiting a long time" escape hatch chip ----

  function maybeShowChip() {
    if (chipShown || !pendingVersion) return;
    if (Date.now() - pendingSince < CHIP_AFTER_MS) return;
    chipShown = true;
    const chip = document.createElement("button");
    chip.type = "button";
    chip.id = "bwc-update-chip";
    chip.className =
      "fixed bottom-4 right-4 z-[70] rounded-full bg-emerald-600 text-white " +
      "shadow-lg px-3 py-1.5 text-xs font-medium hover:bg-emerald-700 " +
      "flex items-center gap-1.5";
    chip.innerHTML = '<span aria-hidden="true">↻</span><span>新版本就绪</span>';
    chip.title = "点击刷新到最新版本";
    chip.addEventListener("click", () => { doSilentReload(); });
    document.body.appendChild(chip);
  }

  // ---- Offline banner (unchanged in intent, minor tidy) ----

  function showOfflineBanner() {
    if (offlineBanner) return;
    offlineBanner = document.createElement("div");
    offlineBanner.id = "bwc-offline-banner";
    offlineBanner.setAttribute("role", "status");
    offlineBanner.className =
      "fixed top-0 inset-x-0 z-[70] bg-amber-600 text-white shadow-md " +
      "px-4 py-2.5 flex flex-wrap items-center justify-center gap-3 text-sm";
    offlineBanner.innerHTML =
      '<span>⚠️ 服务器似乎不可达，你看到的可能是缓存版本</span>' +
      '<button type="button" data-act="purge" class="rounded-full bg-white text-amber-700 px-3 py-0.5 text-xs font-semibold hover:bg-slate-100">强制清缓存重试</button>' +
      '<button type="button" data-act="dismiss" class="text-white/70 hover:text-white text-xs px-1" aria-label="忽略">忽略</button>';
    offlineBanner.querySelector('[data-act="purge"]').addEventListener("click", () => {
      // Same "nuke + reload" path as the silent update, but user-initiated.
      pendingVersion = pendingVersion || "force";
      doSilentReload();
    });
    offlineBanner.querySelector('[data-act="dismiss"]').addEventListener("click", () => {
      removeOfflineBanner();
    });
    document.body.appendChild(offlineBanner);
  }
  function removeOfflineBanner() {
    if (offlineBanner) { offlineBanner.remove(); offlineBanner = null; }
  }

  // ---- Polling ----

  async function check() {
    try {
      const resp = await fetch("/api/version", { cache: "no-store", credentials: "same-origin" });
      if (!resp.ok) throw new Error("status " + resp.status);
      const data = await resp.json();
      failures = 0;
      if (offlineBanner) removeOfflineBanner();
      const remote = String(data.version || "");
      if (!remote || remote === local) return;
      if (remote !== pendingVersion) {
        // First time we notice this new version.
        pendingVersion = remote;
        pendingSince = Date.now();
        resetIdleTimer();
      }
      // Try reloading right now — works if e.g. the user is idle on
      // a clean view with no modal/input. Most cases will fall through
      // here and reload on the next visibility/idle trigger instead.
      tryReload();
      maybeShowChip();
    } catch (_e) {
      failures++;
      if (failures >= 3 && !pendingVersion) showOfflineBanner();
    }
  }

  function startPolling() {
    if (pollTimer) return;
    check();
    pollTimer = setInterval(check, POLL_MS);
  }
  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  // ---- Wire up ----

  window.addEventListener("load", () => {
    startPolling();
    bindIdleEvents();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      // Don't keep polling in background tabs (battery), but DO try one
      // last reload now if we already have a pending version.
      onVisibilityChange();
      stopPolling();
    } else {
      startPolling();
    }
  });
  // iOS Safari bfcache: pageshow without a fresh load. Re-check.
  window.addEventListener("pageshow", check);
})();
