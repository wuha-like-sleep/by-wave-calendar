// Handles two flash-like banners injected by partials/banners.ejs:
//   #bwc-verify-banner   — email-verification CTA for unverified accounts
//   #bwc-pwa-banner      — "install to desktop" PWA prompt
// Both have a [data-dismiss=ID] close button (uses localStorage to hide for 7 days)
// and the PWA banner activates only after the browser fires beforeinstallprompt.
(function () {
  "use strict";
  const DISMISS_TTL_MS = 7 * 24 * 60 * 60 * 1000;

  function isDismissed(id) {
    try {
      const v = Number(localStorage.getItem("bwc-banner-dismiss-" + id) || "0");
      return v && Date.now() - v < DISMISS_TTL_MS;
    } catch { return false; }
  }
  function dismiss(id) {
    try { localStorage.setItem("bwc-banner-dismiss-" + id, String(Date.now())); } catch {}
    const el = document.getElementById(id);
    if (el) el.remove();
  }

  // Generic dismiss buttons.
  document.querySelectorAll("[data-dismiss]").forEach((btn) => {
    const id = btn.getAttribute("data-dismiss");
    if (isDismissed(id)) {
      const el = document.getElementById(id);
      if (el) el.remove();
      return;
    }
    btn.addEventListener("click", () => dismiss(id));
  });

  // ---------- PWA install prompt ----------
  // The browser fires beforeinstallprompt only when the site is eligible
  // (manifest + sw + visited a few times). Capture it, show our banner, and
  // forward the click to the captured event.
  let deferredPrompt = null;
  const pwaBanner = document.getElementById("bwc-pwa-banner");
  const pwaBtn = document.getElementById("bwc-pwa-install");

  // Don't show if already installed (running in standalone) or dismissed.
  const isStandalone = window.matchMedia && window.matchMedia("(display-mode: standalone)").matches
                       || window.navigator.standalone;
  if (isStandalone || isDismissed("bwc-pwa-banner") || !pwaBanner || !pwaBtn) {
    if (pwaBanner) pwaBanner.remove();
  } else {
    window.addEventListener("beforeinstallprompt", (e) => {
      e.preventDefault();
      deferredPrompt = e;
      pwaBanner.classList.remove("hidden");
    });
    pwaBtn.addEventListener("click", async () => {
      if (!deferredPrompt) {
        // No browser-provided prompt — Safari/Firefox or already prompted.
        // Show a hint instead.
        window.bwc && window.bwc.toast && window.bwc.toast(
          "iOS：分享 → 添加到主屏幕；Firefox：菜单 → 安装。Chrome 浏览器右上角应该有「安装」图标。",
          "info",
        );
        return;
      }
      deferredPrompt.prompt();
      const { outcome } = await deferredPrompt.userChoice;
      if (outcome === "accepted") dismiss("bwc-pwa-banner");
      deferredPrompt = null;
    });
    window.addEventListener("appinstalled", () => dismiss("bwc-pwa-banner"));
  }
})();
