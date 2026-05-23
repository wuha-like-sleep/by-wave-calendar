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

  // ---------- bwc.confirm: in-page replacement for window.confirm ----------
  // Returns a Promise<boolean>. Renders a styled modal so destructive
  // actions don't look like an ugly OS-native dialog. Usage:
  //   if (!await bwc.confirm({ message: "删除？" })) return;
  //   if (!await bwc.confirm({ message: "永久删除", danger: true })) return;
  function confirmDialog(opts) {
    const o = opts || {};
    const message = o.message || "确定？";
    const title = o.title || null;
    const confirmLabel = o.confirmLabel || "确定";
    const cancelLabel = o.cancelLabel || "取消";
    const danger = !!o.danger;
    return new Promise(function (resolve) {
      const overlay = document.createElement("div");
      overlay.className =
        "fixed inset-0 z-[100] flex items-end sm:items-center justify-center bg-slate-900/60 p-0 sm:p-4";
      const card = document.createElement("div");
      card.className =
        "w-full sm:max-w-sm sm:rounded-2xl rounded-t-2xl bg-white shadow-2xl";
      // Title is optional — when omitted, message itself reads as the prompt.
      // We escape both via textContent to avoid HTML injection from caller.
      const titleNode = title
        ? '<h3 class="text-base font-semibold text-slate-900 mb-1" data-bwc-title></h3>'
        : "";
      card.innerHTML =
        '<div class="px-5 pt-5 pb-3">' +
          titleNode +
          '<p class="text-sm text-slate-700 whitespace-pre-line" data-bwc-msg></p>' +
        '</div>' +
        '<div class="px-5 pb-5 flex flex-col-reverse sm:flex-row sm:justify-end gap-2">' +
          '<button type="button" data-bwc-cancel ' +
            'class="rounded-lg border border-slate-300 bg-white px-4 py-2.5 sm:py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"></button>' +
          '<button type="button" data-bwc-ok ' +
            'class="rounded-lg px-4 py-2.5 sm:py-2 text-sm font-semibold text-white ' +
            (danger
              ? "bg-red-600 hover:bg-red-700"
              : "bg-brand-600 hover:bg-brand-700") +
            '"></button>' +
        '</div>';
      overlay.appendChild(card);
      const cancelBtn = card.querySelector("[data-bwc-cancel]");
      const okBtn = card.querySelector("[data-bwc-ok]");
      const msgEl = card.querySelector("[data-bwc-msg]");
      const titleEl = card.querySelector("[data-bwc-title]");
      cancelBtn.textContent = cancelLabel;
      okBtn.textContent = confirmLabel;
      msgEl.textContent = message;
      if (titleEl) titleEl.textContent = title;
      function close(result) {
        try { overlay.remove(); } catch (_e) {}
        document.removeEventListener("keydown", onKey);
        resolve(result);
      }
      function onKey(e) {
        if (e.key === "Escape") { e.preventDefault(); close(false); }
        if (e.key === "Enter") { e.preventDefault(); close(true); }
      }
      cancelBtn.addEventListener("click", function () { close(false); });
      okBtn.addEventListener("click", function () { close(true); });
      overlay.addEventListener("click", function (e) { if (e.target === overlay) close(false); });
      document.addEventListener("keydown", onKey);
      document.body.appendChild(overlay);
      // Move keyboard focus to the primary action so Enter confirms.
      setTimeout(function () { okBtn.focus(); }, 30);
    });
  }

  // Global form interceptor: forms tagged with `data-confirm="text"` show
  // a styled confirmation before submitting. Replaces the older
  // `onsubmit="return confirm('...')"` pattern (ugly native dialog).
  // Optional attributes:
  //   data-confirm-title="…" — heading above the message
  //   data-confirm-danger="1" — red confirm button
  //   data-confirm-ok="…" / data-confirm-cancel="…" — button labels
  document.body.addEventListener(
    "submit",
    async function (e) {
      const form = e.target;
      if (!form || !form.dataset || !form.dataset.confirm) return;
      // Reentry guard: once the user has confirmed and we resubmit
      // programmatically, the listener fires again — skip it.
      if (form.__bwcConfirmed) {
        form.__bwcConfirmed = false;
        return;
      }
      e.preventDefault();
      const ok = await confirmDialog({
        title: form.dataset.confirmTitle || null,
        message: form.dataset.confirm,
        danger: form.dataset.confirmDanger === "1",
        confirmLabel: form.dataset.confirmOk || undefined,
        cancelLabel: form.dataset.confirmCancel || undefined,
      });
      if (!ok) return;
      form.__bwcConfirmed = true;
      // Need to clone-and-submit because form.submit() bypasses our
      // listener but also bypasses any other submit handlers. We instead
      // refire the same event so HTMX / other libraries see it normally.
      if (typeof form.requestSubmit === "function") {
        form.requestSubmit(e.submitter || undefined);
      } else {
        form.submit();
      }
    },
    true, // capture phase — beat any per-form handler
  );

  // Buttons (outside <form>) with data-confirm: intercept clicks the
  // same way. Used for things like a standalone "delete" <button> that
  // triggers an HTMX request.
  document.body.addEventListener(
    "click",
    async function (e) {
      const btn = e.target.closest && e.target.closest("button[data-confirm], a[data-confirm]");
      if (!btn) return;
      if (btn.__bwcConfirmed) { btn.__bwcConfirmed = false; return; }
      // Don't intercept buttons that are also inside a [data-confirm] form
      // — the form handler above takes care of those.
      if (btn.form && btn.form.dataset && btn.form.dataset.confirm) return;
      e.preventDefault();
      e.stopPropagation();
      const ok = await confirmDialog({
        title: btn.dataset.confirmTitle || null,
        message: btn.dataset.confirm,
        danger: btn.dataset.confirmDanger === "1",
        confirmLabel: btn.dataset.confirmOk || undefined,
        cancelLabel: btn.dataset.confirmCancel || undefined,
      });
      if (!ok) return;
      btn.__bwcConfirmed = true;
      btn.click();
    },
    true,
  );

  // ---------- Boot splash ----------
  // The splash element is rendered inline at the top of <body> by
  // layout.ejs. It's visible by default; we hide it once the DOM is
  // parsed + first paint is committed. Body class drives the CSS fade.
  //
  // Why double-rAF? Adding the class on DOMContentLoaded sometimes
  // races the first layout; one rAF guarantees the browser has painted
  // the rest of the page, the second guarantees the fade starts on a
  // separate frame so the transition actually runs (instead of jumping).
  function hideBootSplash() {
    if (document.body.classList.contains("bwc-booted")) return;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        document.body.classList.add("bwc-booted");
      });
    });
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", hideBootSplash, { once: true });
  } else {
    hideBootSplash();
  }

  // Safety net: even if some script throws during boot, never leave
  // the user stuck on the splash. Force-hide after 5 seconds no
  // matter what — they'll get the broken page underneath, which is
  // still better than an infinite spinner.
  setTimeout(() => {
    if (!document.body.classList.contains("bwc-booted")) {
      document.body.classList.add("bwc-booted");
    }
  }, 5000);

  // Programmatic loader: same splash, used for long async operations
  // (route navigation in /app/, heavy imports, network-slow saves).
  // Usage:
  //   bwc.loading.show("正在导入…");
  //   await heavyWork();
  //   bwc.loading.hide();
  function loadingShow(message) {
    const splash = document.getElementById("bwc-boot-splash");
    const msg = document.getElementById("bwc-boot-splash-msg");
    if (!splash) return;
    if (msg) msg.textContent = message || "";
    document.body.classList.remove("bwc-booted");
  }
  function loadingHide() {
    const msg = document.getElementById("bwc-boot-splash-msg");
    if (msg) msg.textContent = "";
    document.body.classList.add("bwc-booted");
  }

  // Show the splash on outbound link clicks (same-origin only) so the
  // brief delay before the next page paints feels intentional rather
  // than frozen. The new page's own splash takes over once HTML lands.
  // Skip when the View Transitions API is doing the cross-fade — its
  // animation is smoother than ours.
  document.addEventListener(
    "click",
    function (e) {
      // Only handle plain left clicks without modifier keys.
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = e.target.closest && e.target.closest("a[href]");
      if (!a) return;
      if (a.target && a.target !== "_self") return;
      if (a.hasAttribute("download")) return;
      // Skip mailto:/tel:/javascript:/anchor#.
      const href = a.getAttribute("href") || "";
      if (!href || href.startsWith("#") || href.startsWith("javascript:") || /^[a-z]+:/i.test(href) && !href.startsWith(location.origin) && !href.startsWith("/")) return;
      // Skip when host differs (external link).
      try {
        const url = new URL(href, location.href);
        if (url.origin !== location.origin) return;
      } catch (_e) { return; }
      // If the browser supports View Transitions API, it will handle
      // the cross-fade itself — don't double up with our splash.
      if ("startViewTransition" in document) return;
      loadingShow();
      // If for some reason the navigation never happens (e.g. blocked
      // by beforeunload), restore the page after a beat.
      setTimeout(loadingHide, 1500);
    },
    true,
  );

  window.bwc = { toast, copy, confirm: confirmDialog, loading: { show: loadingShow, hide: loadingHide } };
})();
