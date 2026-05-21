(function () {
  "use strict";

  const root = () => document.getElementById("toast-root");

  function toast(message, kind = "info") {
    const el = document.createElement("div");
    const colors = {
      info: "bg-slate-900 text-white",
      success: "bg-emerald-600 text-white",
      error: "bg-red-600 text-white",
    };
    el.className =
      "bwc-toast inline-flex items-center gap-2 max-w-xs sm:max-w-sm rounded-lg shadow-lg px-4 py-2.5 text-sm " +
      (colors[kind] || colors.info);
    el.textContent = message;
    const r = root();
    if (!r) return;
    r.appendChild(el);
    setTimeout(() => {
      el.style.opacity = "0";
      el.style.transition = "opacity 200ms";
      setTimeout(() => el.remove(), 220);
    }, 2200);
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
