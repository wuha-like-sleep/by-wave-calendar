(function () {
  "use strict";

  const root = () => document.getElementById("toast-root");

  // toast(message, kind?)
  // toast(message, kind, { actionLabel, onAction, durationMs })
  // When an action is provided the toast stays visible longer (6s) and
  // shows a button (e.g. "撤销"). Clicking it calls onAction and the
  // toast immediately dismisses.
  function toast(message, kind = "info", opts) {
    const el = document.createElement("div");
    const colors = {
      info: "bg-slate-900 text-white",
      success: "bg-emerald-600 text-white",
      error: "bg-red-600 text-white",
    };
    el.className =
      "bwc-toast inline-flex items-center gap-3 max-w-xs sm:max-w-sm rounded-lg shadow-lg px-4 py-2.5 text-sm " +
      (colors[kind] || colors.info);
    const msgEl = document.createElement("span");
    msgEl.textContent = message;
    el.appendChild(msgEl);
    const r = root();
    if (!r) return;
    const dismiss = () => {
      el.style.opacity = "0";
      el.style.transition = "opacity 200ms";
      setTimeout(() => el.remove(), 220);
    };
    let durationMs = 2200;
    if (opts && opts.actionLabel && typeof opts.onAction === "function") {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "rounded-md bg-white/15 hover:bg-white/25 px-2 py-0.5 text-xs font-medium";
      btn.textContent = opts.actionLabel;
      btn.addEventListener("click", () => {
        try { opts.onAction(); } catch (_e) { /* swallow */ }
        dismiss();
      });
      el.appendChild(btn);
      durationMs = opts.durationMs || 6000;
    } else if (opts && opts.durationMs) {
      durationMs = opts.durationMs;
    }
    r.appendChild(el);
    setTimeout(dismiss, durationMs);
  }

  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
      toast("已复制订阅链接", "success");
    } catch (err) {
      toast("复制失败，请手动选中链接", "error");
    }
  }

  // Inject CSRF header into all HTMX requests
  document.body.addEventListener("htmx:configRequest", function (evt) {
    const meta = document.querySelector('meta[name="csrf-token"]');
    const token = meta && meta.getAttribute("content");
    if (token) {
      evt.detail.headers["X-CSRF-Token"] = token;
    }
  });

  window.bwc = { toast, copy };
})();
