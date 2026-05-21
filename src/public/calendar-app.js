// by-wave-calendar single-page calendar app
(function () {
  "use strict";

  const ctx = window.__bwc || { calendars: [], publicBaseUrl: "", csrfToken: "" };
  const headers = () => ({ "Content-Type": "application/json", "X-CSRF-Token": ctx.csrfToken });
  const fetchOpts = (extra = {}) => Object.assign({ credentials: "same-origin", headers: headers() }, extra);

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  function openModal(id) { $(id).classList.remove("hidden"); $(id).classList.add("flex"); }
  function closeModal(id) { $(id).classList.add("hidden"); $(id).classList.remove("flex"); }
  $$(".modal-close").forEach((b) => b.addEventListener("click", (e) => {
    const m = e.target.closest("[id^=modal-]");
    if (m) closeModal("#" + m.id);
  }));
  ["#modal-event", "#modal-calendar", "#modal-cal-menu", "#modal-import"].forEach((id) => {
    const m = $(id);
    if (m) m.addEventListener("click", (e) => { if (e.target === m) closeModal(id); });
  });

  // ---------- Sidebar (mobile drawer + desktop collapse) ----------
  const sidebar = $("#cal-sidebar");
  const backdrop = $("#cal-sidebar-backdrop");
  const SIDEBAR_DESKTOP_KEY = "bwc.sidebar.desktop";
  const MOBILE_OPEN = ["flex", "fixed", "inset-y-0", "left-0", "z-50", "w-72"];
  const HIDDEN = ["hidden"];

  function isMobile() { return window.matchMedia("(max-width: 767px)").matches; }

  function showOnMobile() {
    MOBILE_OPEN.forEach(c => sidebar.classList.add(c));
    HIDDEN.forEach(c => sidebar.classList.remove(c));
    backdrop.classList.remove("hidden");
  }
  function hideOnMobile() {
    MOBILE_OPEN.forEach(c => sidebar.classList.remove(c));
    sidebar.classList.add("hidden");
    backdrop.classList.add("hidden");
  }
  function showOnDesktop() {
    sidebar.classList.remove("hidden");
    sidebar.classList.add("md:flex");
    localStorage.setItem(SIDEBAR_DESKTOP_KEY, "1");
    requestAnimationFrame(() => { try { cal.render(); } catch (e) {} });
  }
  function hideOnDesktop() {
    sidebar.classList.remove("md:flex");
    sidebar.classList.add("hidden");
    localStorage.setItem(SIDEBAR_DESKTOP_KEY, "0");
    requestAnimationFrame(() => { try { cal.render(); } catch (e) {} });
  }
  function toggleSidebar() {
    if (isMobile()) {
      if (sidebar.classList.contains("hidden")) showOnMobile(); else hideOnMobile();
    } else {
      if (sidebar.classList.contains("hidden")) showOnDesktop(); else hideOnDesktop();
    }
  }

  // Restore desktop preference
  if (!isMobile() && localStorage.getItem(SIDEBAR_DESKTOP_KEY) === "0") {
    sidebar.classList.add("hidden");
    sidebar.classList.remove("md:flex");
  }

  $("#btn-toggle-sidebar").addEventListener("click", toggleSidebar);
  $("#btn-close-sidebar")?.addEventListener("click", hideOnMobile);
  backdrop.addEventListener("click", hideOnMobile);

  // ---------- Toast UI Calendar setup ----------
  const tuiCalendars = ctx.calendars.map((c) => ({
    id: c.id,
    name: c.name,
    backgroundColor: c.color,
    borderColor: c.color,
    dragBackgroundColor: c.color,
    color: "#ffffff",
  }));

  const cal = new tui.Calendar("#calendar", {
    defaultView: "week",
    useFormPopup: false,
    useDetailPopup: false,
    useCreationPopup: false,
    isReadOnly: false,
    week: {
      taskView: false,
      eventView: ["time", "allday"],
      // Show the full 0-24 range; we visually dim non-working hours via
      // CSS instead of clipping them, so users still see late-night
      // events without scrolling.
      hourStart: 0,
      hourEnd: 24,
      startDayOfWeek: 1,
      dayNames: ["周日", "周一", "周二", "周三", "周四", "周五", "周六"],
      showNowIndicator: true,
    },
    month: {
      startDayOfWeek: 1,
      dayNames: ["日", "一", "二", "三", "四", "五", "六"],
      visibleWeeksCount: 0,
      isAlways6Weeks: false,
    },
    calendars: tuiCalendars,
    template: {
      monthDayName(model) { return `<span class="text-xs text-slate-500">${model.label}</span>`; },
    },
  });

  let currentView = "week";

  // Scroll the time grid so "now" is roughly in the middle on first load
  // (24-hour view means a lot of empty hours otherwise). Toast UI doesn't
  // expose a scrollToNow() API — we set the scrollTop of the time-grid pane
  // directly. Defer to next tick so the grid is in the DOM.
  function scrollGridToNow() {
    setTimeout(() => {
      const pane = document.querySelector(".toastui-calendar-time .toastui-calendar-columns")
                || document.querySelector(".toastui-calendar-time")
                || document.querySelector("[class*='toastui-calendar-time']");
      if (!pane) return;
      const hour = new Date().getHours();
      // Each hour ~ pane.scrollHeight / 24. Aim for the current hour minus 2
      // so a couple of past hours stay visible for context.
      const target = Math.max(0, (hour - 2)) / 24 * pane.scrollHeight;
      pane.scrollTop = target;
    }, 150);
  }

  function formatPeriodLabel() {
    const start = cal.getDateRangeStart().toDate();
    const end = cal.getDateRangeEnd().toDate();
    const fmt = new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long", day: "numeric" });
    if (currentView === "month") {
      const mid = new Date((+start + +end) / 2);
      $("#period-label").textContent = new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long" }).format(mid);
    } else if (currentView === "day") {
      $("#period-label").textContent = new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long", day: "numeric", weekday: "long" }).format(start);
    } else {
      $("#period-label").textContent = `${fmt.format(start)} – ${fmt.format(end)}`;
    }
  }

  const visibleCalIds = new Set(ctx.calendars.map((c) => c.id));

  async function loadEvents() {
    const start = cal.getDateRangeStart().toDate();
    const end = cal.getDateRangeEnd().toDate();
    const url = `/api/events?from=${encodeURIComponent(start.toISOString())}&to=${encodeURIComponent(end.toISOString())}`;
    try {
      const resp = await fetch(url, fetchOpts());
      if (!resp.ok) throw new Error("load_failed");
      const data = await resp.json();
      cal.clear();
      const events = data.events
        .filter((e) => visibleCalIds.has(e.calendarId))
        .map((e) => {
          // For all-day events the server stores UTC midnight (≈ pure date);
          // pass the YYYY-MM-DD string to Toast UI so it doesn't shift around
          // the user's local timezone boundary.
          const start = e.allDay ? e.startsAt.slice(0, 10) : e.startsAt;
          const end = e.allDay ? e.endsAt.slice(0, 10) : e.endsAt;
          return {
            id: e.id,
            calendarId: e.calendarId,
            title: e.summary,
            location: e.location || undefined,
            body: e.description || undefined,
            start,
            end,
            isAllday: !!e.allDay,
            category: e.allDay ? "allday" : "time",
          };
        });
      cal.createEvents(events);
      // Force a render so the red now-line redraws after we just cleared.
      try { cal.render(); } catch (_e) {}
    } catch (err) {
      console.error(err);
      window.bwc && window.bwc.toast("加载事件失败", "error");
    }
  }

  function refresh() { formatPeriodLabel(); loadEvents(); }

  // ---------- Live sync: pick up events added from phone / other tab ----------
  // Polls /api/events every 30 seconds while the tab is visible. Also fires
  // immediately on visibilitychange (when the user comes back to the tab).
  const POLL_INTERVAL_MS = 30_000;
  let pollHandle = null;
  function startPolling() {
    if (pollHandle) return;
    pollHandle = setInterval(() => {
      if (document.hidden) return;
      loadEvents().catch(() => {});
    }, POLL_INTERVAL_MS);
  }
  function stopPolling() {
    if (pollHandle) { clearInterval(pollHandle); pollHandle = null; }
  }
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      stopPolling();
      stopNowTick();
    } else {
      loadEvents().catch(() => {});
      startPolling();
      startNowTick();
      // Snap the indicator back to "now" the moment we regain focus.
      try { cal.render(); } catch (_e) {}
    }
  });
  startPolling();

  // ---------- Now-indicator tick ----------
  // Toast UI's red "now line" auto-updates every minute internally — but our
  // cal.clear()/createEvents pair from loadEvents() can reset that internal
  // timer. Force a re-render at the top of each minute (and exactly once at
  // every minute boundary, not 60s after page-load) so the line actually
  // crawls down as time passes.
  let nowTickHandle = null;
  let nowAlignHandle = null;
  function tickNow() {
    if (document.hidden) return;
    try { cal.render(); } catch (_e) {}
  }
  function startNowTick() {
    if (nowTickHandle || nowAlignHandle) return;
    const msToNextMinute = 60_000 - (Date.now() % 60_000);
    // First tick aligned to the next wall-clock minute, then every 60s.
    nowAlignHandle = setTimeout(() => {
      nowAlignHandle = null;
      tickNow();
      nowTickHandle = setInterval(tickNow, 60_000);
    }, Math.max(1000, msToNextMinute));
  }
  function stopNowTick() {
    if (nowAlignHandle) { clearTimeout(nowAlignHandle); nowAlignHandle = null; }
    if (nowTickHandle) { clearInterval(nowTickHandle); nowTickHandle = null; }
  }
  startNowTick();

  // ---------- Toolbar ----------
  $("#btn-today").addEventListener("click", () => { cal.today(); refresh(); scrollGridToNow(); });
  $("#btn-prev").addEventListener("click", () => { cal.prev(); refresh(); });
  $("#btn-next").addEventListener("click", () => { cal.next(); refresh(); });
  $$(".view-btn").forEach((b) => b.addEventListener("click", () => {
    currentView = b.dataset.view;
    cal.changeView(currentView);
    $$(".view-btn").forEach((x) => x.classList.remove("bg-brand-50", "text-brand-700", "font-semibold"));
    b.classList.add("bg-brand-50", "text-brand-700", "font-semibold");
    refresh();
    if (currentView !== "month") scrollGridToNow();
  }));
  $('.view-btn[data-view="week"]').classList.add("bg-brand-50", "text-brand-700", "font-semibold");
  // Initial position: scroll the week grid to the current hour on first paint.
  scrollGridToNow();

  // ---------- Sidebar: search box filters calendar list by name ----------
  const calSearchEl = document.getElementById("cal-search");
  if (calSearchEl) {
    calSearchEl.addEventListener("input", () => {
      const q = calSearchEl.value.trim().toLowerCase();
      $$("#cal-list li").forEach((li) => {
        const name = (li.querySelector("span.text-sm")?.textContent || "").toLowerCase();
        li.classList.toggle("hidden", q !== "" && !name.includes(q));
      });
    });
  }

  // ---------- Empty-state CTA: "create first calendar" jumps to the same
  // flow as the sidebar "+" button.
  const emptyCreateBtn = document.getElementById("empty-create-cal");
  if (emptyCreateBtn) {
    emptyCreateBtn.addEventListener("click", () => {
      try { openCreateCalendar(); } catch (_e) { /* function defined below */ }
    });
  }

  // ---------- Shortcuts panel toggle ----------
  const shortcutsBtn = $("#btn-shortcuts");
  const shortcutsPanel = $("#shortcuts-panel");
  if (shortcutsBtn && shortcutsPanel) {
    shortcutsBtn.addEventListener("click", () => {
      shortcutsPanel.classList.toggle("hidden");
    });
    document.addEventListener("click", (e) => {
      if (!shortcutsPanel.contains(e.target) && e.target !== shortcutsBtn) {
        shortcutsPanel.classList.add("hidden");
      }
    });
  }

  // ---------- Keyboard shortcuts ----------
  // Mirror Google Calendar: T = today, M / W / D = month/week/day,
  // ← / → = prev/next, N = new event. Skipped when the user is typing in
  // an input / textarea / contenteditable.
  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const tag = (e.target instanceof HTMLElement) ? e.target.tagName : "";
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" ||
        (e.target instanceof HTMLElement && e.target.isContentEditable)) return;
    // Don't fire when a modal is open — let Escape close it instead.
    const openModalEl = document.querySelector("[id^='modal-']:not(.hidden)");
    if (openModalEl && e.key === "Escape") {
      openModalEl.classList.add("hidden");
      openModalEl.classList.remove("flex");
      return;
    }
    if (openModalEl) return;
    if (e.key === "?") {
      shortcutsPanel?.classList.toggle("hidden");
      return;
    }
    switch (e.key.toLowerCase()) {
      case "t": cal.today(); refresh(); scrollGridToNow(); break;
      case "m": $('.view-btn[data-view="month"]')?.click(); break;
      case "w": $('.view-btn[data-view="week"]')?.click(); break;
      case "d": $('.view-btn[data-view="day"]')?.click(); break;
      case "n":
        e.preventDefault();
        $("#btn-new-event")?.click();
        break;
      case "arrowleft": cal.prev(); refresh(); break;
      case "arrowright": cal.next(); refresh(); break;
      case "escape": shortcutsPanel?.classList.add("hidden"); break;
      default: return;
    }
  });

  // ---------- Mini calendar (sidebar) ----------
  // A small month/year picker above the calendar list. Click a date → main
  // calendar jumps there in current view; click the month/year title →
  // toggles into a 12-month grid; click a month in that grid → back to
  // month view at that month.
  (function setupMiniCal() {
    const root = $("#mini-cal");
    if (!root) return;
    const monthGrid = $("#mini-month-grid");
    const yearGrid = $("#mini-year-view");
    const monthView = $("#mini-month-view");
    const periodBtn = $("#mini-period");
    const prevBtn = $("#mini-prev");
    const nextBtn = $("#mini-next");
    if (!monthGrid || !yearGrid || !monthView || !periodBtn || !prevBtn || !nextBtn) return;

    const ZH_MONTHS = ["一月", "二月", "三月", "四月", "五月", "六月", "七月", "八月", "九月", "十月", "十一月", "十二月"];
    let viewKind = "month"; // "month" | "year"
    // Tracks which month/year the mini-cal is *showing*, not the main calendar.
    let cursor = new Date();
    cursor.setDate(1);

    function fmtPeriod() {
      if (viewKind === "month") return `${cursor.getFullYear()} ${ZH_MONTHS[cursor.getMonth()]}`;
      return `${cursor.getFullYear()} 年`;
    }
    function isSameYMD(a, b) {
      return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
    }
    function isSameYM(a, b) { return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth(); }

    function renderMonth() {
      monthView.classList.remove("hidden");
      yearGrid.classList.add("hidden");
      yearGrid.classList.remove("grid");
      periodBtn.textContent = fmtPeriod();
      const year = cursor.getFullYear();
      const month = cursor.getMonth();
      // Week starts Monday (matches main grid)
      const first = new Date(year, month, 1);
      const startDow = (first.getDay() + 6) % 7; // 0 = Mon
      const daysInMonth = new Date(year, month + 1, 0).getDate();
      const prevMonthDays = new Date(year, month, 0).getDate();
      const today = new Date(); today.setHours(0, 0, 0, 0);
      let mainSelected;
      try { mainSelected = cal.getDate().toDate(); } catch (_e) { mainSelected = today; }

      const cells = [];
      // Leading days from previous month
      for (let i = startDow - 1; i >= 0; i--) {
        const d = new Date(year, month - 1, prevMonthDays - i);
        cells.push({ d, outside: true });
      }
      // Current month
      for (let i = 1; i <= daysInMonth; i++) {
        cells.push({ d: new Date(year, month, i), outside: false });
      }
      // Pad to 6 rows = 42 cells
      while (cells.length < 42) {
        const last = cells[cells.length - 1].d;
        const next = new Date(last); next.setDate(next.getDate() + 1);
        cells.push({ d: next, outside: true });
      }

      monthGrid.innerHTML = "";
      cells.forEach(({ d, outside }) => {
        const cell = document.createElement("button");
        cell.type = "button";
        cell.dataset.iso = d.toISOString();
        const isToday = isSameYMD(d, today);
        const isSelected = isSameYMD(d, mainSelected);
        cell.className = [
          "aspect-square inline-flex items-center justify-center rounded",
          "hover:bg-brand-50 hover:text-brand-700 transition-colors",
          outside ? "text-slate-300" : "text-slate-700",
          isToday && !isSelected ? "ring-1 ring-brand-300" : "",
          isSelected ? "bg-brand-600 text-white hover:bg-brand-700 hover:text-white font-semibold" : "",
        ].filter(Boolean).join(" ");
        cell.textContent = String(d.getDate());
        monthGrid.appendChild(cell);
      });
    }

    function renderYear() {
      monthView.classList.add("hidden");
      yearGrid.classList.add("grid");
      yearGrid.classList.remove("hidden");
      periodBtn.textContent = fmtPeriod();
      const today = new Date();
      let mainSelected;
      try { mainSelected = cal.getDate().toDate(); } catch (_e) { mainSelected = today; }

      yearGrid.innerHTML = "";
      for (let m = 0; m < 12; m++) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.dataset.month = String(m);
        const isCurrent = mainSelected.getFullYear() === cursor.getFullYear() && mainSelected.getMonth() === m;
        const isThisMonth = today.getFullYear() === cursor.getFullYear() && today.getMonth() === m;
        btn.className = [
          "py-2 rounded-md text-center font-medium",
          "hover:bg-brand-50 hover:text-brand-700",
          isCurrent ? "bg-brand-600 text-white hover:bg-brand-700 hover:text-white" : "text-slate-700",
          isThisMonth && !isCurrent ? "ring-1 ring-brand-300" : "",
        ].filter(Boolean).join(" ");
        btn.textContent = ZH_MONTHS[m];
        yearGrid.appendChild(btn);
      }
    }

    function render() { viewKind === "month" ? renderMonth() : renderYear(); }

    periodBtn.addEventListener("click", () => {
      viewKind = viewKind === "month" ? "year" : "month";
      render();
    });
    prevBtn.addEventListener("click", () => {
      if (viewKind === "month") cursor.setMonth(cursor.getMonth() - 1);
      else cursor.setFullYear(cursor.getFullYear() - 1);
      render();
    });
    nextBtn.addEventListener("click", () => {
      if (viewKind === "month") cursor.setMonth(cursor.getMonth() + 1);
      else cursor.setFullYear(cursor.getFullYear() + 1);
      render();
    });
    monthGrid.addEventListener("click", (e) => {
      const t = e.target.closest("button[data-iso]");
      if (!t) return;
      const d = new Date(t.dataset.iso);
      cal.setDate(d);
      refresh();
      if (currentView !== "month") scrollGridToNow();
      render(); // re-highlight the newly selected cell
    });
    yearGrid.addEventListener("click", (e) => {
      const t = e.target.closest("button[data-month]");
      if (!t) return;
      cursor.setMonth(Number(t.dataset.month));
      viewKind = "month";
      render();
    });

    render();
    // Keep mini-cal in sync when main view changes via toolbar / today buttons.
    const origRefresh = refresh;
    // eslint-disable-next-line no-global-assign
    refresh = function () { origRefresh(); try { render(); } catch (_e) {} };
  })();

  // ---------- Sidebar calendar visibility toggle ----------
  $$(".cal-toggle").forEach((cb) => cb.addEventListener("change", () => {
    const id = cb.dataset.calId;
    if (cb.checked) visibleCalIds.add(id); else visibleCalIds.delete(id);
    loadEvents();
  }));

  // ---------- Event modal ----------
  function pad(n) { return String(n).padStart(2, "0"); }
  function toLocalDateTimeValue(d) {
    const t = new Date(d);
    return `${t.getFullYear()}-${pad(t.getMonth()+1)}-${pad(t.getDate())}T${pad(t.getHours())}:${pad(t.getMinutes())}`;
  }
  function toLocalDateValue(d) {
    const t = new Date(d);
    return `${t.getFullYear()}-${pad(t.getMonth()+1)}-${pad(t.getDate())}`;
  }

  const allDayCheckbox = $('#form-event [name="allDay"]');
  const timeRow = $("#time-row");
  const dateRow = $("#date-row");

  function syncAllDayUI() {
    const isAllDay = allDayCheckbox.checked;
    if (isAllDay) {
      timeRow.classList.add("hidden");
      dateRow.classList.remove("hidden");
      // Mirror values
      const s = $('#form-event [name="startsAt"]').value;
      const e = $('#form-event [name="endsAt"]').value;
      if (s) $('#form-event [name="startsAtDate"]').value = s.slice(0, 10);
      if (e) $('#form-event [name="endsAtDate"]').value = e.slice(0, 10);
    } else {
      timeRow.classList.remove("hidden");
      dateRow.classList.add("hidden");
    }
  }
  allDayCheckbox.addEventListener("change", syncAllDayUI);

  function openEventModal(payload) {
    const form = $("#form-event");
    form.reset();
    form.querySelector('[name="id"]').value = payload.id || "";
    if (payload.calendarId) form.querySelector('[name="calendarId"]').value = payload.calendarId;
    if (payload.summary) form.querySelector('[name="summary"]').value = payload.summary;
    if (payload.location) form.querySelector('[name="location"]').value = payload.location;
    if (payload.description) form.querySelector('[name="description"]').value = payload.description;
    form.querySelector('[name="startsAt"]').value = toLocalDateTimeValue(payload.startsAt || new Date());
    form.querySelector('[name="endsAt"]').value = toLocalDateTimeValue(payload.endsAt || new Date(Date.now() + 3600_000));
    form.querySelector('[name="startsAtDate"]').value = toLocalDateValue(payload.startsAt || new Date());
    form.querySelector('[name="endsAtDate"]').value = toLocalDateValue(payload.endsAt || new Date());
    form.querySelector('[name="allDay"]').checked = !!payload.allDay;
    form.querySelector('[name="category"]').value = payload.category || "";
    // Attendees: hidden field holds the comma-joined list (preserved across
    // saves); summary text + manage link surface in the modal.
    const attendees = Array.isArray(payload.attendees) ? payload.attendees : [];
    form.querySelector('[name="attendees"]').value = attendees.join(",");
    const summary = $("#attendee-summary-text");
    const manage = $("#attendee-manage-link");
    if (summary) summary.textContent = attendees.length > 0
      ? `${attendees.length} 位：${attendees.slice(0, 3).join(", ")}${attendees.length > 3 ? " …" : ""}`
      : "尚未邀请任何人";
    if (manage) {
      manage.classList.toggle("hidden", !payload.id);
      if (payload.id) manage.href = `/app/events/${encodeURIComponent(payload.id)}/attendees`;
    }
    // Link field (separate from notes — stored at extra.url).
    const urlInput = form.querySelector('[name="url"]');
    if (urlInput) urlInput.value = payload.url || "";
    // Recurrence (RRULE) — preserve the stored rule if it's one of our presets.
    const rruleSelect = form.querySelector('[name="rrule"]');
    if (rruleSelect) {
      const r = (payload.rrule || "").trim();
      const opt = Array.from(rruleSelect.options).find((o) => o.value === r);
      rruleSelect.value = opt ? r : "";
    }
    // Reminder — read first VALARM's trigger if any.
    const reminderSelect = form.querySelector('[name="reminder"]');
    if (reminderSelect) {
      const t = (payload.alarms && payload.alarms[0] && payload.alarms[0].trigger) || "";
      const opt = Array.from(reminderSelect.options).find((o) => o.value === t);
      reminderSelect.value = opt ? t : (payload.id ? "" : "-PT15M");
    }
    if (payload.timezone) {
      const tzSel = form.querySelector('[name="timezone"]');
      if (Array.from(tzSel.options).some((o) => o.value === payload.timezone)) {
        tzSel.value = payload.timezone;
      }
    }
    syncAllDayUI();
    $("#modal-event-title").textContent = payload.id ? "编辑事件" : "新建事件";
    $("#btn-delete-event").classList.toggle("hidden", !payload.id);
    openModal("#modal-event");
    // Clear the natural-language input every time the modal opens —
    // stale text from a previous session is more confusing than helpful.
    const nl = $("#nl-input");
    const nlHint = $("#nl-hint");
    if (nl) nl.value = "";
    if (nlHint) { nlHint.classList.add("hidden"); nlHint.textContent = ""; }
  }

  // ---------- Natural-language event parser ----------
  // Parses inputs like "明天下午3点 牙医" or "周五10点 1小时 团建" into
  // { summary, startsAt, endsAt }. Returns null if it can't pull out at
  // least one date+time. Pure regex — no LLM, no API call, runs entirely
  // in the user's browser, works offline.
  function parseNaturalLanguageEvent(text) {
    if (!text || typeof text !== "string") return null;
    let remaining = " " + text.trim() + " ";  // pad so word boundaries are easy

    // Step 1: pull out the date.
    const now = new Date();
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    let dateOffset = null;
    const dateRules = [
      [/\s今天\s/, 0], [/\s明天\s/, 1], [/\s后天\s/, 2], [/\s大后天\s/, 3],
      [/\s昨天\s/, -1], [/\s前天\s/, -2],
    ];
    for (const [re, off] of dateRules) {
      if (re.test(remaining)) {
        dateOffset = off;
        remaining = remaining.replace(re, " ");
        break;
      }
    }
    // 周一..周日 / 周天 — relative to current week, snap to NEXT occurrence
    // (excluding today). "本周X" / "下周X" / "周X" — same with "下" forcing +7.
    const weekdayMap = { "一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "日": 0, "天": 0 };
    const wkRe = /\s(本周|下周|周)([一二三四五六日天])\s/;
    const wkMatch = remaining.match(wkRe);
    if (wkMatch && dateOffset === null) {
      const target = weekdayMap[wkMatch[2]];
      let diff = (target - now.getDay() + 7) % 7;
      if (diff === 0) diff = 7;   // 周X always means upcoming, not today
      if (wkMatch[1] === "下周") diff += 7;
      dateOffset = diff;
      remaining = remaining.replace(wkRe, " ");
    }
    // X月X日 / X月X号
    const mdRe = /\s(\d{1,2})月(\d{1,2})[日号]?\s/;
    const mdMatch = remaining.match(mdRe);
    if (mdMatch && dateOffset === null) {
      const m = Number(mdMatch[1]) - 1;
      const d = Number(mdMatch[2]);
      const tgt = new Date(now.getFullYear(), m, d);
      if (tgt < day) tgt.setFullYear(tgt.getFullYear() + 1);
      dateOffset = Math.round((tgt - day) / 86400000);
      remaining = remaining.replace(mdRe, " ");
    }

    // Step 2: pull out the time.
    let hours = null, mins = 0;
    // X点 / X点X分 / X时X分
    const tRe = /\s(早上|上午|中午|下午|晚上|凌晨)?(\d{1,2})(?:[点时:：](\d{1,2})?分?)?\s/;
    const tMatch = remaining.match(tRe);
    if (tMatch) {
      const period = tMatch[1];
      let h = Number(tMatch[2]);
      const m = tMatch[3] ? Number(tMatch[3]) : 0;
      // Period normalization. "下午1点" = 13:00; "晚上11点" = 23:00.
      // No period: keep h as-is (24-hour).
      if (period === "下午" || period === "晚上") { if (h < 12) h += 12; }
      else if (period === "凌晨") { if (h === 12) h = 0; }
      else if (period === "中午") { h = 12; }
      // "早上/上午" + 12 — Chinese ambiguity, leave 12 as noon.
      if (h >= 0 && h <= 23 && m >= 0 && m <= 59) {
        hours = h; mins = m;
        remaining = remaining.replace(tRe, " ");
      }
    }
    // "半点" e.g. "下午3点半"
    const halfRe = /\s半\s/;
    if (halfRe.test(remaining) && hours !== null && mins === 0) {
      mins = 30;
      remaining = remaining.replace(halfRe, " ");
    }

    // Need at least a date OR time to count this as a successful parse.
    if (dateOffset === null && hours === null) return null;

    // Step 3: duration.
    let durationMin = 60;  // default
    const durRe = /\s(\d+(?:\.\d+)?)\s?(小时|h|hours?|分钟|min|minutes?)\s/i;
    const durMatch = remaining.match(durRe);
    if (durMatch) {
      const n = Number(durMatch[1]);
      const unit = durMatch[2].toLowerCase();
      durationMin = (unit.startsWith("小时") || unit === "h" || unit.startsWith("hour"))
        ? Math.round(n * 60)
        : Math.round(n);
      remaining = remaining.replace(durRe, " ");
    }
    const halfHourRe = /\s半小时\s/;
    if (halfHourRe.test(remaining)) { durationMin = 30; remaining = remaining.replace(halfHourRe, " "); }

    // Step 4: build the date.
    const startsAt = new Date(day);
    if (dateOffset !== null) startsAt.setDate(startsAt.getDate() + dateOffset);
    if (hours === null) {
      // Date but no time → default 09:00 of that day, 1-hour event.
      startsAt.setHours(9, 0, 0, 0);
    } else {
      startsAt.setHours(hours, mins, 0, 0);
      // If no date given AND the time has already passed today, push to tomorrow.
      if (dateOffset === null && startsAt < now) startsAt.setDate(startsAt.getDate() + 1);
    }
    const endsAt = new Date(startsAt.getTime() + durationMin * 60000);

    // Step 5: the remaining text is the summary.
    const summary = remaining.replace(/[，。、；：,;:]+/g, " ").trim();
    return { summary, startsAt, endsAt };
  }

  // Wire the natural-language input. Pressing Enter (or blur after change)
  // populates the form fields with the parsed values. Shows a short hint
  // so the user sees we understood them.
  {
    const nlInput = $("#nl-input");
    const nlHint = $("#nl-hint");
    function applyNl() {
      if (!nlInput || !nlHint) return;
      const parsed = parseNaturalLanguageEvent(nlInput.value);
      if (!parsed) {
        nlHint.classList.remove("hidden");
        nlHint.style.color = "rgb(100 116 139)";
        nlHint.textContent = "没看懂时间，试试「明天下午3点 牙医」";
        return;
      }
      const form = $("#form-event");
      if (parsed.summary) form.querySelector('[name="summary"]').value = parsed.summary;
      form.querySelector('[name="startsAt"]').value = toLocalDateTimeValue(parsed.startsAt);
      form.querySelector('[name="endsAt"]').value = toLocalDateTimeValue(parsed.endsAt);
      const fmt = (d) => `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
      nlHint.classList.remove("hidden");
      nlHint.style.color = "rgb(67 56 202)"; // brand-700
      nlHint.textContent = `✓ ${fmt(parsed.startsAt)} 开始 · ${parsed.summary || "无标题"}`;
    }
    if (nlInput) {
      nlInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); applyNl(); }
      });
      nlInput.addEventListener("blur", () => { if (nlInput.value.trim()) applyNl(); });
    }
  }

  $("#btn-new-event").addEventListener("click", () => openEventModal({ startsAt: new Date(), endsAt: new Date(Date.now() + 3600_000) }));

  cal.on("selectDateTime", (info) => {
    openEventModal({ startsAt: info.start, endsAt: info.end, allDay: info.isAllday });
    cal.clearGridSelections();
  });

  cal.on("clickEvent", async (info) => {
    const calId = info.event.calendarId;
    const id = info.event.id;
    const evs = await fetch(`/api/calendars/${calId}/events`, fetchOpts()).then((r) => r.json()).catch(() => []);
    const fresh = (evs || []).find((e) => e.id === id);
    if (!fresh) return;
    const extra = fresh.extra || {};
    openEventModal({
      id: fresh.id,
      calendarId: fresh.calendarId,
      summary: fresh.summary,
      location: fresh.location,
      description: fresh.description,
      url: extra.url || "",
      startsAt: fresh.startsAt,
      endsAt: fresh.endsAt,
      allDay: fresh.allDay,
      rrule: fresh.rrule || "",
      category: extra.category,
      timezone: extra.timezone,
      attendees: Array.isArray(extra.attendees) ? extra.attendees : [],
      alarms: Array.isArray(extra.alarms) ? extra.alarms : [],
    });
  });

  function parseEmails(s) {
    return String(s || "")
      .split(/[\s,;，；]+/)
      .map((x) => x.trim().toLowerCase())
      .filter((x) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x));
  }

  $("#form-event").addEventListener("submit", async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.target).entries());
    const id = data.id;
    const isAllDay = !!data.allDay;
    let startsIso, endsIso;
    if (isAllDay) {
      // Date-only inputs — store the calendar date as UTC midnight directly so
      // it never crosses a day boundary under a TZ shift.
      startsIso = data.startsAtDate + "T00:00:00.000Z";
      endsIso = data.endsAtDate + "T23:59:59.999Z";
    } else {
      // datetime-local gives "YYYY-MM-DDTHH:MM" interpreted as the user's
      // browser-local time; toISOString converts to UTC.
      startsIso = new Date(data.startsAt).toISOString();
      endsIso = new Date(data.endsAt).toISOString();
    }
    const attendees = parseEmails(data.attendees);
    const body = {
      calendarId: data.calendarId,
      summary: data.summary,
      location: data.location || undefined,
      description: data.description || undefined,
      allDay: isAllDay,
      startsAt: startsIso,
      endsAt: endsIso,
      rrule: (data.rrule || "").trim() || undefined,
      extra: {
        category: data.category || undefined,
        timezone: data.timezone || undefined,
        attendees: attendees.length ? attendees : undefined,
        url: (data.url || "").trim() || undefined,
        alarms: data.reminder ? [{ trigger: data.reminder, action: "DISPLAY", description: data.summary }] : undefined,
      },
    };
    // Conflict check (soft) — let user confirm overlap before saving.
    try {
      const cResp = await fetch("/api/events/conflicts", fetchOpts({
        method: "POST",
        body: JSON.stringify({ calendarId: body.calendarId, startsAt: body.startsAt, endsAt: body.endsAt, excludeId: id || undefined }),
      }));
      if (cResp.ok) {
        const { conflicts } = await cResp.json();
        if (Array.isArray(conflicts) && conflicts.length > 0) {
          const names = conflicts.slice(0, 3).map((c) => "• " + c.summary).join("\n");
          const more = conflicts.length > 3 ? `\n• …还有 ${conflicts.length - 3} 个` : "";
          if (!confirm(`和现有事件时间冲突：\n${names}${more}\n\n仍要保存？`)) return;
        }
      }
    } catch (_e) { /* soft check — never block save on a network glitch */ }
    try {
      const url = id ? `/api/events/${id}` : "/api/events";
      const method = id ? "PATCH" : "POST";
      const resp = await fetch(url, fetchOpts({ method, body: JSON.stringify(body) }));
      if (!resp.ok) throw new Error(await resp.text());
      closeModal("#modal-event");
      await loadEvents();
      window.bwc && window.bwc.toast(id ? "事件已更新" : "事件已添加", "success");
    } catch (err) {
      console.error(err);
      window.bwc && window.bwc.toast("保存失败", "error");
    }
  });

  $("#btn-delete-event").addEventListener("click", async () => {
    const id = $('#form-event [name="id"]').value;
    if (!id || !confirm("删除该事件？")) return;
    let resp;
    try {
      // DELETE has no body — sending Content-Type: application/json without a
      // body makes Fastify's JSON parser reject with 400. Send only the CSRF
      // header, no content-type.
      resp = await fetch(`/api/events/${id}`, {
        method: "DELETE",
        credentials: "same-origin",
        headers: { "X-CSRF-Token": ctx.csrfToken },
      });
    } catch (err) {
      console.error("delete_event_network", err);
      window.bwc && window.bwc.toast("删除失败：网络错误", "error");
      return;
    }
    // 204 / 200 → deleted; 404 → already gone (treat as success and just refresh)
    if (resp.ok || resp.status === 404) {
      closeModal("#modal-event");
      await loadEvents();
      window.bwc && window.bwc.toast(resp.status === 404 ? "事件已不存在，已刷新" : "事件已删除", "success");
      return;
    }
    let errBody = "";
    try { errBody = (await resp.json()).error || ""; } catch (_e) { errBody = ""; }
    console.error("delete_event_failed", resp.status, errBody);
    window.bwc && window.bwc.toast(`删除失败 (HTTP ${resp.status})${errBody ? ": " + errBody : ""}`, "error");
  });

  // ---------- Calendar create / import (Synology-style add menu) ----------
  const COLOR_PALETTE = [
    "#ef4444", "#f97316", "#f59e0b", "#eab308", "#84cc16",
    "#22c55e", "#10b981", "#14b8a6", "#06b6d4", "#0ea5e9",
    "#3b82f6", "#6366f1", "#8b5cf6", "#a855f7", "#d946ef",
    "#ec4899", "#64748b",
  ];

  function buildColorPicker(container, hiddenInputName, initial) {
    container.innerHTML = "";
    COLOR_PALETTE.forEach((c) => {
      const sw = document.createElement("button");
      sw.type = "button";
      sw.dataset.color = c;
      sw.className = "color-swatch relative h-7 w-7 rounded-md border border-slate-200 hover:scale-110 transition-transform";
      sw.style.background = `linear-gradient(135deg, ${c} 50%, #f8fafc 50%)`;
      sw.setAttribute("aria-label", `颜色 ${c}`);
      container.appendChild(sw);
    });
    const setSelected = (val) => {
      container.querySelectorAll(".color-swatch").forEach((s) => {
        s.classList.toggle("ring-2", s.dataset.color === val);
        s.classList.toggle("ring-offset-1", s.dataset.color === val);
        s.classList.toggle("ring-slate-700", s.dataset.color === val);
      });
      const form = container.closest("form");
      const input = form ? form.querySelector(`[name="${hiddenInputName}"]`) : null;
      if (input) input.value = val;
    };
    container.addEventListener("click", (e) => {
      const t = e.target.closest(".color-swatch");
      if (!t) return;
      setSelected(t.dataset.color);
    });
    setSelected(initial);
  }

  // Add-menu popover (创建 / 导入)
  const addTrigger = $("#btn-cal-menu-trigger");
  const addPopover = $("#cal-add-popover");
  if (addTrigger && addPopover) {
    addTrigger.addEventListener("click", (e) => {
      e.stopPropagation();
      addPopover.classList.toggle("hidden");
    });
    document.addEventListener("click", (e) => {
      if (!addPopover.contains(e.target) && e.target !== addTrigger) addPopover.classList.add("hidden");
    });
    addPopover.querySelectorAll("[data-action]").forEach((btn) => {
      btn.addEventListener("click", () => {
        addPopover.classList.add("hidden");
        if (btn.dataset.action === "create") openCreateCalendar();
        else openImportCalendar();
      });
    });
  }

  function openCreateCalendar() {
    const form = $("#form-calendar");
    form.reset();
    buildColorPicker(form.querySelector('[data-color-picker="form-calendar"]'), "color", "#6366f1");
    // Reset to General tab
    form.querySelectorAll(".cal-tab").forEach((t) => {
      const active = t.dataset.calTab === "general";
      t.classList.toggle("border-brand-600", active);
      t.classList.toggle("text-brand-700", active);
      t.classList.toggle("border-transparent", !active);
      t.classList.toggle("text-slate-500", !active);
    });
    form.querySelectorAll("[data-cal-pane]").forEach((p) => p.classList.toggle("hidden", p.dataset.calPane !== "general"));
    openModal("#modal-calendar");
  }

  // Tab switch in create modal
  $("#modal-calendar").addEventListener("click", (e) => {
    const t = e.target.closest(".cal-tab");
    if (!t) return;
    const form = $("#form-calendar");
    form.querySelectorAll(".cal-tab").forEach((x) => {
      const active = x.dataset.calTab === t.dataset.calTab;
      x.classList.toggle("border-brand-600", active);
      x.classList.toggle("text-brand-700", active);
      x.classList.toggle("border-transparent", !active);
      x.classList.toggle("text-slate-500", !active);
    });
    form.querySelectorAll("[data-cal-pane]").forEach((p) => p.classList.toggle("hidden", p.dataset.calPane !== t.dataset.calTab));
  });

  $("#form-calendar").addEventListener("submit", async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.target).entries());
    try {
      const resp = await fetch("/api/calendars", fetchOpts({ method: "POST", body: JSON.stringify(data) }));
      if (!resp.ok) throw new Error(await resp.text());
      window.bwc && window.bwc.toast("日历已创建", "success");
      setTimeout(() => window.location.reload(), 400);
    } catch (err) {
      console.error(err);
      window.bwc && window.bwc.toast("创建失败", "error");
    }
  });

  // ---------- Import calendar ----------
  function openImportCalendar() {
    const form = $("#form-import");
    form.reset();
    buildColorPicker(form.querySelector('[data-color-picker="form-import"]'), "newColor", "#6366f1");
    // Reset source pane to file
    form.querySelectorAll("[data-source-pane]").forEach((p) => p.classList.toggle("hidden", p.dataset.sourcePane !== "file"));
    // Reset destination panes
    form.querySelector('[data-dest-pane="new"]').classList.remove("hidden");
    form.querySelector('[data-dest-pane="existing"]').classList.add("hidden");
    openModal("#modal-import");
  }

  const importForm = $("#form-import");
  if (importForm) {
    const sourceHint = $("#import-source-hint");
    const hints = {
      file: "从本地选择一个 .ics 文件上传（最大 5MB）。支持 Google / Apple / Outlook / 群晖 等任意标准 iCalendar 文件。",
      "url-once": "服务器一次性从远程 URL 拉取并导入。适合公开节假日 / 课表的快照。",
      sub: "服务器按周期自动同步远程 URL，事件按 UID 增量更新。",
      paste: "如果你只能复制内容，直接粘贴 ICS 文本即可。",
    };
    importForm.querySelectorAll('input[name="source"]').forEach((r) => r.addEventListener("change", () => {
      const v = importForm.querySelector('input[name="source"]:checked').value;
      importForm.querySelectorAll("[data-source-pane]").forEach((p) => p.classList.toggle("hidden", p.dataset.sourcePane !== v));
      if (sourceHint) sourceHint.textContent = hints[v] || "";
    }));

    importForm.querySelectorAll('input[name="destination"]').forEach((r) => r.addEventListener("change", () => {
      const v = importForm.querySelector('input[name="destination"]:checked').value;
      importForm.querySelector('[data-dest-pane="new"]').classList.toggle("hidden", v !== "new");
      importForm.querySelector('[data-dest-pane="existing"]').classList.toggle("hidden", v !== "existing");
    }));

    importForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const source = importForm.querySelector('input[name="source"]:checked').value;
      const destination = importForm.querySelector('input[name="destination"]:checked').value;
      const submitBtn = importForm.querySelector('button[type="submit"]');
      submitBtn.disabled = true;
      submitBtn.textContent = "导入中…";
      try {
        // Step 1: resolve target calendarId
        let calendarId;
        if (destination === "existing") {
          const sel = importForm.querySelector('[data-dest-pane="existing"]');
          calendarId = sel.value;
          if (!calendarId) throw new Error("请选择一个现有日历");
        } else {
          const name = importForm.querySelector('input[name="newName"]').value.trim() || "导入的日历";
          const color = importForm.querySelector('input[name="newColor"]').value || "#6366f1";
          const created = await fetch("/api/calendars", fetchOpts({
            method: "POST",
            body: JSON.stringify({ name, color, timezone: "Asia/Shanghai" }),
          }));
          if (!created.ok) throw new Error("创建日历失败");
          const calRow = await created.json();
          calendarId = calRow.id;
        }

        // Step 2: send the import to that calendar
        if (source === "file") {
          const fileInput = importForm.querySelector('[data-source-pane="file"] input[type="file"]');
          if (!fileInput.files || !fileInput.files[0]) throw new Error("请选择 .ics 文件");
          const fd = new FormData();
          fd.append("file", fileInput.files[0]);
          const resp = await fetch(`/app/calendars/${calendarId}/import/file`, { method: "POST", credentials: "same-origin", body: fd });
          if (!resp.ok && resp.status !== 302) throw new Error("上传失败");
        } else if (source === "url-once") {
          const url = importForm.querySelector('[data-source-pane="url-once"] input[name="url"]').value.trim();
          if (!url) throw new Error("请输入 URL");
          await postForm(`/app/calendars/${calendarId}/import/url-once`, { url });
        } else if (source === "sub") {
          const url = importForm.querySelector('[data-source-pane="sub"] input[name="url"]').value.trim();
          const label = importForm.querySelector('[data-source-pane="sub"] input[name="label"]').value.trim();
          const refreshMinutes = importForm.querySelector('[data-source-pane="sub"] select[name="refreshMinutes"]').value;
          if (!url) throw new Error("请输入 URL");
          await postForm(`/app/calendars/${calendarId}/subscriptions`, { url, label, refreshMinutes });
        } else if (source === "paste") {
          const text = importForm.querySelector('[data-source-pane="paste"] textarea[name="text"]').value;
          if (!text || text.length < 20) throw new Error("请粘贴 ICS 文本");
          await postForm(`/app/calendars/${calendarId}/import/text`, { text });
        }
        window.bwc && window.bwc.toast("导入完成", "success");
        setTimeout(() => window.location.reload(), 500);
      } catch (err) {
        console.error(err);
        window.bwc && window.bwc.toast("导入失败：" + (err.message || err), "error");
        submitBtn.disabled = false;
        submitBtn.textContent = "导入";
      }
    });
  }

  async function postForm(url, data) {
    const fd = new URLSearchParams();
    fd.set("_csrf", ctx.csrfToken);
    Object.entries(data).forEach(([k, v]) => fd.set(k, v));
    const resp = await fetch(url, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: fd.toString(),
      redirect: "manual",
    });
    if (resp.type === "opaqueredirect" || resp.status === 302 || resp.ok) return;
    throw new Error(`HTTP ${resp.status}`);
  }

  // ---------- Calendar context menu ----------
  let currentMenuCalId = null;
  $$("[data-cal-menu]").forEach((btn) => btn.addEventListener("click", async (e) => {
    e.preventDefault(); e.stopPropagation();
    const id = btn.dataset.calMenu;
    const c = ctx.calendars.find((x) => x.id === id);
    if (!c) return;
    currentMenuCalId = id;
    $("#cal-menu-color").style.background = c.color;
    $("#cal-menu-name").textContent = c.name;
    await loadShareTokens(id);
    openModal("#modal-cal-menu");
  }));

  async function loadShareTokens(calId) {
    const list = $("#share-tokens-list");
    list.innerHTML = '<li class="text-slate-400 text-center py-2">加载中…</li>';
    try {
      const resp = await fetch(`/api/calendars/${calId}/share-tokens`, fetchOpts());
      const tokens = await resp.json();
      if (!tokens.length) {
        list.innerHTML = '<li class="text-slate-400 text-center py-2">还没有订阅链接</li>';
        return;
      }
      list.innerHTML = tokens.map((t) => {
        const webcalUrl = t.url.replace(/^https?:/i, "webcal:");
        const gcalUrl = `https://calendar.google.com/calendar/u/0/r?cid=${encodeURIComponent(t.url)}`;
        return `
        <li class="py-3 border-b border-slate-100 last:border-0 space-y-2">
          <div class="flex items-start gap-2">
            <div class="flex-1 min-w-0">
              <div class="text-slate-700 text-sm">${escapeHtml(t.label || "未命名")}</div>
              <code class="text-xs text-slate-400 truncate block mt-0.5">${escapeHtml(t.url)}</code>
            </div>
            <button type="button" class="rounded-lg border border-red-200 bg-white px-2.5 py-1 text-xs text-red-700 hover:bg-red-50 flex-shrink-0" data-revoke="${escapeHtml(t.token)}">撤销</button>
          </div>
          <div class="flex flex-wrap gap-1.5">
            <button type="button" class="rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs text-slate-700 hover:bg-slate-50" data-copy="${escapeHtml(t.url)}">复制 URL</button>
            <a href="${escapeHtml(webcalUrl)}" class="rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs text-slate-700 hover:bg-slate-50">📱 添加到手机日历</a>
            <a href="${escapeHtml(gcalUrl)}" target="_blank" rel="noopener" class="rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs text-slate-700 hover:bg-slate-50">📅 添加到 Google 日历</a>
          </div>
        </li>
      `;}).join("");
      list.querySelectorAll("[data-copy]").forEach((b) => b.addEventListener("click", () => window.bwc.copy(b.dataset.copy)));
      list.querySelectorAll("[data-revoke]").forEach((b) => b.addEventListener("click", async () => {
        if (!confirm("撤销该订阅链接？")) return;
        await fetch(`/api/calendars/${calId}/share-tokens/${b.dataset.revoke}`, fetchOpts({ method: "DELETE" }));
        await loadShareTokens(calId);
        window.bwc && window.bwc.toast("已撤销", "success");
      }));
    } catch (err) {
      list.innerHTML = '<li class="text-red-500 text-center py-2">加载失败</li>';
    }
  }

  $("#form-new-share-token").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!currentMenuCalId) return;
    const fd = new FormData(e.target);
    const label = fd.get("label") || undefined;
    try {
      const resp = await fetch(`/api/calendars/${currentMenuCalId}/share-tokens`,
        fetchOpts({ method: "POST", body: JSON.stringify({ label }) }));
      if (!resp.ok) throw new Error();
      e.target.reset();
      await loadShareTokens(currentMenuCalId);
      window.bwc && window.bwc.toast("已生成订阅链接", "success");
    } catch (err) {
      window.bwc && window.bwc.toast("生成失败", "error");
    }
  });

  $("#btn-delete-calendar").addEventListener("click", async () => {
    if (!currentMenuCalId) return;
    if (!confirm("确认删除整个日历？所有事件和订阅链接都会消失。")) return;
    try {
      const resp = await fetch(`/api/calendars/${currentMenuCalId}`, fetchOpts({ method: "DELETE" }));
      if (!resp.ok) throw new Error();
      closeModal("#modal-cal-menu");
      setTimeout(() => window.location.reload(), 400);
    } catch (err) {
      window.bwc && window.bwc.toast("删除失败", "error");
    }
  });

  cal.on("beforeUpdateEvent", async ({ event, changes }) => {
    try {
      const startsAt = changes.start ? new Date(changes.start).toISOString() : undefined;
      const endsAt = changes.end ? new Date(changes.end).toISOString() : undefined;
      const body = {};
      if (startsAt) body.startsAt = startsAt;
      if (endsAt) body.endsAt = endsAt;
      const resp = await fetch(`/api/events/${event.id}`, fetchOpts({ method: "PATCH", body: JSON.stringify(body) }));
      if (!resp.ok) throw new Error();
      cal.updateEvent(event.id, event.calendarId, changes);
    } catch (err) {
      console.error(err);
      window.bwc && window.bwc.toast("移动失败", "error");
    }
  });

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  refresh();

  // Force a render after layout settles so the time-grid measures itself correctly.
  setTimeout(() => { try { cal.render(); } catch (e) {} }, 100);
  window.addEventListener("resize", () => {
    clearTimeout(window.__bwcResize);
    window.__bwcResize = setTimeout(() => { try { cal.render(); } catch (e) {} }, 150);
  });
})();
