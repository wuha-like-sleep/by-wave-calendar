// Cmd+K / Ctrl+K / "/" command palette. Searches events server-side
// (debounced) and merges in a static list of navigation actions
// (jump to calendar, settings, admin, etc.) so the palette works as
// both quick-find and command runner.
//
// Lives in layout.ejs so it's available on every page (admin, settings,
// calendar app, booking links). Hidden by default; only opens on
// keyboard shortcut.

(function () {
  "use strict";
  const modal = document.getElementById("bwc-palette");
  const input = document.getElementById("palette-input");
  const results = document.getElementById("palette-results");
  if (!modal || !input || !results) return;  // not on this page (auth views, etc.)

  // Static actions — these always appear when the input is empty or
  // when the query matches their label. Calendar list is injected
  // from a window-level hint when the calendar app is loaded.
  const staticActions = [
    { kind: "nav", label: "我的日历", hint: "App", url: "/app" },
    { kind: "nav", label: "预约链接", hint: "App", url: "/app/booking-links" },
    { kind: "nav", label: "账户设置", hint: "Settings", url: "/app/settings" },
    { kind: "nav", label: "数据备份", hint: "Admin", url: "/admin/backup" },
    { kind: "nav", label: "用户管理", hint: "Admin", url: "/admin/users" },
    { kind: "nav", label: "API 令牌", hint: "Admin", url: "/admin/api" },
    { kind: "nav", label: "审计日志", hint: "Admin", url: "/admin/audit" },
    { kind: "nav", label: "更新管理", hint: "Admin", url: "/admin/update" },
  ];

  let selectedIdx = 0;
  let currentResults = [];
  let searchTimer = null;

  function isOpen() { return !modal.classList.contains("hidden"); }
  function open() {
    modal.classList.remove("hidden");
    input.value = "";
    selectedIdx = 0;
    render([], "");
    setTimeout(() => input.focus(), 0);
  }
  function close() {
    modal.classList.add("hidden");
  }

  // The score function for the static-action fallback. Simple substring
  // match with a small bonus for prefix matches (so "用户" surfaces "用户管理"
  // ahead of "管理 → 用户").
  function matchScore(label, query) {
    const l = label.toLowerCase(), q = query.toLowerCase();
    if (!q) return 1;
    const idx = l.indexOf(q);
    if (idx < 0) return 0;
    return idx === 0 ? 100 : (50 - idx);
  }

  function render(events, query) {
    const filteredNav = !query
      ? staticActions.slice(0, 6)
      : staticActions.map((a) => ({ a, s: matchScore(a.label, query) })).filter((x) => x.s > 0)
          .sort((a, b) => b.s - a.s).slice(0, 5).map((x) => x.a);

    const eventItems = events.map((e) => ({
      kind: "event",
      label: e.summary,
      hint: e.calendarName + " · " + new Date(e.startsAt).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }),
      // Right now we don't have a single-event detail page — clicking
      // an event from the palette navigates to the main app and the
      // user finds it on the grid. Future: deep-link to /app?event=<id>.
      url: "/app",
      color: e.calendarColor,
    }));

    currentResults = [...eventItems, ...filteredNav];
    if (currentResults.length === 0) {
      results.innerHTML = `<li class="px-4 py-6 text-center text-slate-400 text-sm">没有匹配项</li>`;
      return;
    }
    selectedIdx = Math.min(selectedIdx, currentResults.length - 1);
    results.innerHTML = currentResults.map((r, i) => {
      const dot = r.color ? `<span class="inline-block h-2.5 w-2.5 rounded-full mr-2 align-middle" style="background:${r.color}"></span>` : `<span class="inline-block w-3 mr-2"></span>`;
      const sel = i === selectedIdx ? "bg-brand-50 text-brand-900" : "hover:bg-slate-50";
      return `<li data-idx="${i}" class="px-4 py-2.5 cursor-pointer flex items-center justify-between ${sel}">
        <span class="flex items-center min-w-0">${dot}<span class="truncate">${escapeHtml(r.label)}</span></span>
        <span class="text-xs text-slate-400 flex-shrink-0 ml-3">${escapeHtml(r.hint || "")}</span>
      </li>`;
    }).join("");
  }

  function escapeHtml(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  async function runSearch(q) {
    if (!q || q.trim().length < 1) {
      render([], q);
      return;
    }
    try {
      const r = await fetch(`/api/search?q=${encodeURIComponent(q.trim())}`, { credentials: "same-origin" });
      if (!r.ok) { render([], q); return; }
      const data = await r.json();
      render(data.events || [], q);
    } catch {
      render([], q);
    }
  }

  function activateSelection() {
    const r = currentResults[selectedIdx];
    if (!r) return;
    close();
    if (r.url) window.location.href = r.url;
  }

  // Global keyboard listener — Cmd/Ctrl+K to open. Use capture so we beat
  // any inline form's keydown handlers.
  document.addEventListener("keydown", (e) => {
    const inTextField = e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.isContentEditable);
    // Open shortcuts
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      isOpen() ? close() : open();
      return;
    }
    if (e.key === "/" && !isOpen() && !inTextField) {
      e.preventDefault();
      open();
      return;
    }
    // While open: Esc closes, arrows navigate, Enter selects.
    if (!isOpen()) return;
    if (e.key === "Escape") { e.preventDefault(); close(); return; }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      selectedIdx = Math.min(selectedIdx + 1, Math.max(0, currentResults.length - 1));
      render(currentResults.filter((r) => r.kind === "event"), input.value.trim());
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      selectedIdx = Math.max(selectedIdx - 1, 0);
      render(currentResults.filter((r) => r.kind === "event"), input.value.trim());
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      activateSelection();
      return;
    }
  }, true);

  // Visible entry points: any [data-bwc-search] element (e.g. the header search
  // button) opens the palette. It's an <a href="/app/search"> so that on pages
  // WITHOUT the palette (this script early-returns there) the click still
  // navigates to the full search page — graceful degradation.
  document.addEventListener("click", (e) => {
    const trigger = e.target.closest && e.target.closest("[data-bwc-search]");
    if (!trigger) return;
    e.preventDefault();
    isOpen() ? close() : open();
  });

  // Backdrop click closes
  modal.addEventListener("click", (e) => { if (e.target === modal) close(); });

  // Click on a result row
  results.addEventListener("click", (e) => {
    const li = e.target.closest("[data-idx]");
    if (!li) return;
    selectedIdx = Number(li.dataset.idx);
    activateSelection();
  });

  // Debounced search on input
  input.addEventListener("input", () => {
    const q = input.value;
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => runSearch(q), 150);
  });
})();
