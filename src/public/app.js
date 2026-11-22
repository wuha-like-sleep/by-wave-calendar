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
    // 动作按钮：单个走 actionLabel/onAction（既有调用方），多个走
    // opts.actions = [{ label, onAction }]（如一句话直接保存后的
    // 「打开 / 撤销」）。两者可同时给，actions 在前。
    const actions = [];
    if (opts && Array.isArray(opts.actions)) {
      for (const a of opts.actions) {
        if (a && a.label && typeof a.onAction === "function") actions.push(a);
      }
    }
    if (opts && opts.actionLabel && typeof opts.onAction === "function") {
      actions.push({ label: opts.actionLabel, onAction: opts.onAction });
    }
    if (actions.length) {
      for (const a of actions) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "rounded-md bg-white/15 hover:bg-white/25 px-2 py-0.5 text-xs font-medium";
        btn.textContent = a.label;
        btn.addEventListener("click", () => {
          try { a.onAction(); } catch (_e) { /* swallow */ }
          dismiss();
        });
        el.appendChild(btn);
      }
      durationMs = opts.durationMs || 6000;
    } else if (opts && opts.durationMs) {
      durationMs = opts.durationMs;
    }
    r.appendChild(el);
    setTimeout(dismiss, durationMs);
  }

  // Copy with per-object feedback: callers say WHAT was copied (a booking
  // link is not a subscription link — the old single "已复制订阅链接" text
  // was simply wrong for most entry points). The generic link/failed
  // strings come from window.BWC_COPY_T, injected by layout.ejs in the
  // page's locale; the hardcoded fallbacks only fire on pages that render
  // without the layout.
  async function copy(text, successMsg) {
    const msgs = window.BWC_COPY_T || {};
    try {
      await navigator.clipboard.writeText(text);
      toast(successMsg || msgs.link || "链接已复制", "success");
    } catch (err) {
      toast(msgs.failed || "复制失败，请手动复制", "error");
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
    // Button defaults come from window.BWC_CONFIRM_T (layout.ejs resolves
    // common.confirm / common.cancel in the page's locale); the hardcoded
    // fallbacks only fire on pages that render without the layout.
    const confirmT = window.BWC_CONFIRM_T || {};
    const message = o.message || "确定？";
    const title = o.title || null;
    const confirmLabel = o.confirmLabel || confirmT.confirm || "确定";
    const cancelLabel = o.cancelLabel || confirmT.cancel || "取消";
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

  // Deep-linked <details> (e.g. Settings links to /support#api-token):
  // browsers scroll to the element but leave it collapsed, so the link
  // lands on a closed question. Open the targeted entry and re-scroll —
  // opening it shifts the layout, so the native anchor jump ends up
  // pointing at the wrong spot without the second scroll.
  if (location.hash.length > 1) {
    try {
      const target = document.getElementById(decodeURIComponent(location.hash.slice(1)));
      if (target && target.tagName === "DETAILS" && !target.open) {
        target.open = true;
        target.scrollIntoView();
      }
    } catch {
      // A malformed hash is not worth breaking page init for.
    }
  }

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
  // Auto-hide is handled by an inline script in layout.ejs (so it works
  // even if this file fails to load — CSP blocks, 404s, etc).
  //
  // We used to expose `bwc.loading.show/hide()` as a programmatic
  // loader API that re-used the splash element. v1.3.9 audit found
  // zero callers in the codebase. Removed — anything that needs a
  // long-operation overlay should use a dedicated component (toast
  // for short, modal for blocking), not hijack the boot splash.

  // ---------- Declarative behaviours ----------
  // These delegated listeners replace the onclick=/onchange= attributes the
  // templates used to carry. With none left, the CSP drops
  // `script-src-attr 'unsafe-inline'` — so an injected `<img onerror=…>`
  // cannot execute even if some sanitizer upstream is bypassed. Adding a new
  // inline handler to a template will therefore silently stop working; use
  // one of the attributes below, or a nonce'd <script>, instead.

  // data-bwc-copy="text" — copy to clipboard (toast feedback via copy()).
  // data-bwc-copy-msg="…" — optional localized success toast naming the
  // copied object (templates render it with t("app.js.copy.*")).
  document.body.addEventListener("click", function (e) {
    const el = e.target.closest && e.target.closest("[data-bwc-copy]");
    if (!el) return;
    e.preventDefault();
    copy(el.dataset.bwcCopy, el.dataset.bwcCopyMsg);
  });

  // data-bwc-toggle="#id" — toggle .hidden on the target.
  // data-bwc-hide="#id"   — force .hidden on the target.
  document.body.addEventListener("click", function (e) {
    const el = e.target.closest && e.target.closest("[data-bwc-toggle],[data-bwc-hide]");
    if (!el) return;
    const sel = el.dataset.bwcToggle || el.dataset.bwcHide;
    const target = sel && document.querySelector(sel);
    if (!target) return;
    e.preventDefault();
    if (el.dataset.bwcToggle !== undefined) target.classList.toggle("hidden");
    else target.classList.add("hidden");
  });

  // Disabled links (no download URL configured yet) — swallow the click.
  // Previously `onclick="return false"`.
  document.body.addEventListener("click", function (e) {
    const a = e.target.closest && e.target.closest('a[aria-disabled="true"]');
    if (a) e.preventDefault();
  });

  // data-bwc-autosubmit — submit the owning form when the control changes.
  // Used by the language switcher (header / mobile menu / bare-layout
  // pages) and the admin user-list filters.
  document.body.addEventListener("change", function (e) {
    const el = e.target;
    if (!el || !el.dataset || el.dataset.bwcAutosubmit === undefined) return;
    const form = el.form || (el.closest && el.closest("form"));
    if (!form) return;
    // A language switch (any form posting to a */locale endpoint) reloads
    // the whole page in the new language. Stash the scroll position so
    // the restore below can land the user back where they were reading
    // instead of at the top of the page. Unsaved form input on the page
    // is still lost — a full reload is the price of a server-rendered
    // language switch; the scroll position is the part we can keep.
    try {
      const action = form.getAttribute("action") || "";
      if (/(^|\/)locale$/.test(action)) {
        sessionStorage.setItem(
          "bwcLocaleScroll",
          JSON.stringify({ path: location.pathname, y: window.scrollY }),
        );
      }
    } catch (err) { /* sessionStorage unavailable — the switch still works */ }
    if (typeof form.requestSubmit === "function") form.requestSubmit();
    else form.submit();
  });

  // Restore the scroll position stashed by a language switch. Skipped
  // when the URL carries a #anchor (e.g. the settings form bounces back
  // to #language) — the anchor jump is the more specific intent.
  let localeScrollY = null;
  try {
    const raw = sessionStorage.getItem("bwcLocaleScroll");
    if (raw) {
      sessionStorage.removeItem("bwcLocaleScroll");
      if (!location.hash) {
        const saved = JSON.parse(raw);
        if (saved && saved.path === location.pathname && typeof saved.y === "number" && saved.y > 0) {
          localeScrollY = saved.y;
        }
      }
    }
  } catch (err) { /* ignore — nothing depends on this */ }
  if (localeScrollY !== null) {
    const restoreLocaleScroll = function () { window.scrollTo(0, localeScrollY); };
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", restoreLocaleScroll);
    } else {
      restoreLocaleScroll();
    }
    // The browser's own scroll restoration for the POST→redirect
    // navigation can land after DOMContentLoaded and stomp the value
    // back to the top; re-apply once more after full load.
    window.addEventListener("load", function () {
      requestAnimationFrame(restoreLocaleScroll);
    });
  }

  // data-bwc-checkall="selector" — master checkbox drives every match inside
  // the same form (falls back to the document if it isn't in one).
  document.body.addEventListener("change", function (e) {
    const el = e.target;
    if (!el || !el.dataset || !el.dataset.bwcCheckall) return;
    const scope = (el.closest && el.closest("form")) || document;
    scope.querySelectorAll(el.dataset.bwcCheckall).forEach(function (c) {
      c.checked = el.checked;
    });
  });

  // data-bwc-switch on a <select> + data-bwc-when="v1 v2" on panels:
  // show only the panels whose value list contains the current selection.
  // Panels are hidden with inline style (not .hidden) because their initial
  // state is server-rendered the same way.
  document.body.addEventListener("change", function (e) {
    const sel = e.target;
    if (!sel || !sel.dataset || sel.dataset.bwcSwitch === undefined) return;
    const scope = (sel.closest && sel.closest("form")) || document;
    scope.querySelectorAll("[data-bwc-when]").forEach(function (panel) {
      const values = String(panel.dataset.bwcWhen || "").split(/\s+/).filter(Boolean);
      panel.style.display = values.indexOf(sel.value) >= 0 ? "" : "none";
    });
  });

  // ---- Booking-link weekly availability editors -------------------------
  // Markup is server-rendered from the link's real matrix (see
  // views/app/_availability-editor.ejs); this block only enhances it:
  // per-day toggle, add/remove windows, HH:MM filtering and start<end
  // validation, and serialization into the hidden weeklyAvailability
  // field. It mirrors the desktop/Android editors exactly — same wire
  // format (JSON object carrying ONLY bookable days; an absent day means
  // "not bookable that day"), same "new window starts as (lastEnd,
  // lastEnd) and stays invalid until fixed" behavior, and saving is
  // blocked while any window is invalid.
  const AVAIL_HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
  const AVAIL_INPUT_CLS =
    "w-20 rounded-md border border-slate-300 bg-white px-2 py-1 text-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100";

  function availSerialize(editor) {
    const matrix = {};
    editor.querySelectorAll("[data-avail-day]").forEach(function (dayEl) {
      const toggle = dayEl.querySelector("[data-avail-toggle]");
      if (!toggle || !toggle.checked) return;
      const wins = [];
      dayEl.querySelectorAll("[data-avail-window]").forEach(function (w) {
        const s = w.querySelector("[data-avail-start]");
        const e = w.querySelector("[data-avail-end]");
        wins.push([s ? s.value : "", e ? e.value : ""]);
      });
      if (wins.length) matrix[dayEl.getAttribute("data-avail-day")] = wins;
    });
    const hidden = editor.querySelector("[data-avail-json]");
    if (hidden) hidden.value = JSON.stringify(matrix);
    return matrix;
  }

  function availValidate(editor) {
    let valid = true;
    editor.querySelectorAll("[data-avail-day]").forEach(function (dayEl) {
      const toggle = dayEl.querySelector("[data-avail-toggle]");
      if (!toggle || !toggle.checked) return;
      dayEl.querySelectorAll("[data-avail-window]").forEach(function (w) {
        const s = w.querySelector("[data-avail-start]");
        const e = w.querySelector("[data-avail-end]");
        const ok = !!(s && e && AVAIL_HHMM.test(s.value) && AVAIL_HHMM.test(e.value) && s.value < e.value);
        if (!ok) valid = false;
        [s, e].forEach(function (input) {
          if (input) input.classList.toggle("border-red-400", !ok);
        });
      });
    });
    const err = editor.querySelector("[data-avail-error]");
    if (err) err.hidden = valid;
    const form = editor.closest && editor.closest("form");
    if (form) {
      form.querySelectorAll('button[type="submit"], input[type="submit"]').forEach(function (b) {
        b.disabled = !valid;
        b.classList.toggle("opacity-50", !valid);
      });
    }
    return valid;
  }

  function availRefresh(editor) {
    availSerialize(editor);
    availValidate(editor);
  }

  function availMakeWindow(start, end) {
    const row = document.createElement("div");
    row.className = "flex items-center gap-1.5";
    row.setAttribute("data-avail-window", "");
    const mk = function (attr, value, placeholder) {
      const input = document.createElement("input");
      input.type = "text";
      input.setAttribute(attr, "");
      input.value = value;
      input.maxLength = 5;
      input.setAttribute("inputmode", "numeric");
      input.placeholder = placeholder;
      input.setAttribute("autocomplete", "off");
      input.className = AVAIL_INPUT_CLS;
      return input;
    };
    const dash = document.createElement("span");
    dash.className = "text-slate-400";
    dash.textContent = "–";
    const remove = document.createElement("button");
    remove.type = "button";
    remove.setAttribute("data-avail-remove", "");
    remove.setAttribute("aria-label", "×");
    remove.className = "rounded-md px-1.5 py-0.5 text-sm text-slate-400 hover:text-red-600 hover:bg-red-50";
    remove.textContent = "×";
    row.appendChild(mk("data-avail-start", start, "09:00"));
    row.appendChild(dash);
    row.appendChild(mk("data-avail-end", end, "18:00"));
    row.appendChild(remove);
    return row;
  }

  function availSetDayOpen(dayEl, open) {
    const body = dayEl.querySelector("[data-avail-body]");
    const off = dayEl.querySelector("[data-avail-off]");
    if (body) body.hidden = !open;
    if (off) off.hidden = open;
  }

  document.body.addEventListener("change", function (e) {
    const toggle = e.target;
    if (!toggle || !toggle.hasAttribute || !toggle.hasAttribute("data-avail-toggle")) return;
    const dayEl = toggle.closest("[data-avail-day]");
    const editor = toggle.closest("[data-avail-editor]");
    if (!dayEl || !editor) return;
    if (toggle.checked && !dayEl.querySelector("[data-avail-window]")) {
      dayEl.querySelector("[data-avail-windows]").appendChild(availMakeWindow("09:00", "18:00"));
    }
    availSetDayOpen(dayEl, toggle.checked);
    availRefresh(editor);
  });

  document.body.addEventListener("click", function (e) {
    const btn = e.target && e.target.closest && e.target.closest("[data-avail-add], [data-avail-remove]");
    if (!btn) return;
    const editor = btn.closest("[data-avail-editor]");
    const dayEl = btn.closest("[data-avail-day]");
    if (!editor || !dayEl) return;
    if (btn.hasAttribute("data-avail-add")) {
      const rows = dayEl.querySelectorAll("[data-avail-window]");
      const lastEnd = rows.length ? rows[rows.length - 1].querySelector("[data-avail-end]").value : "09:00";
      dayEl.querySelector("[data-avail-windows]").appendChild(availMakeWindow(lastEnd, lastEnd));
    } else {
      const row = btn.closest("[data-avail-window]");
      if (row) row.remove();
      if (!dayEl.querySelector("[data-avail-window]")) {
        const toggle = dayEl.querySelector("[data-avail-toggle]");
        if (toggle) toggle.checked = false;
        availSetDayOpen(dayEl, false);
      }
    }
    availRefresh(editor);
  });

  document.body.addEventListener("input", function (e) {
    const input = e.target;
    if (!input || !input.hasAttribute) return;
    if (!input.hasAttribute("data-avail-start") && !input.hasAttribute("data-avail-end")) return;
    // Same input discipline as the native editors: digits + colon, max 5.
    const filtered = input.value.replace(/[^\d:]/g, "").slice(0, 5);
    if (filtered !== input.value) input.value = filtered;
    const editor = input.closest("[data-avail-editor]");
    if (editor) availRefresh(editor);
  });

  // Belt-and-braces on top of the disabled submit button: never let an
  // invalid matrix leave the browser.
  document.body.addEventListener("submit", function (e) {
    const form = e.target;
    if (!form || !form.querySelectorAll) return;
    form.querySelectorAll("[data-avail-editor]").forEach(function (editor) {
      if (!availValidate(editor)) e.preventDefault();
    });
  }, true);

  function availInit() {
    document.querySelectorAll("[data-avail-editor]").forEach(availRefresh);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", availInit);
  else availInit();

  window.bwc = { toast, copy, confirm: confirmDialog };
})();
