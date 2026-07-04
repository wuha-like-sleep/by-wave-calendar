// by-wave-calendar single-page calendar app
(function () {
  "use strict";

  const ctx = window.__bwc || { calendars: [], publicBaseUrl: "", csrfToken: "" };
  const headers = () => ({ "Content-Type": "application/json", "X-CSRF-Token": ctx.csrfToken });
  const fetchOpts = (extra = {}) => Object.assign({ credentials: "same-origin", headers: headers() }, extra);

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  // Animated modal show/hide. The CSS (input.css "Modal motion") keeps modals
  // in a closed state (opacity/transform) by default and reveals them on the
  // `.is-open` class; so EVERY show path must call openModal(). Accepts an id
  // string ("#modal-x") or the element itself.
  const MODAL_LEAVE_MS = 340; // ≥ the longest CSS leave transition
  function openModal(id) {
    const el = typeof id === "string" ? $(id) : id;
    if (!el) return;
    el.classList.remove("hidden");
    el.classList.add("flex");
    void el.offsetWidth;          // reflow so the enter transition starts closed
    el.classList.add("is-open");
  }
  function closeModal(id) {
    const el = typeof id === "string" ? $(id) : id;
    if (!el || el.classList.contains("hidden")) return;
    el.classList.remove("is-open");  // play the leave transition
    setTimeout(() => {
      // A re-open during the leave animation re-adds is-open — don't hide then.
      if (!el.classList.contains("is-open")) {
        el.classList.add("hidden");
        el.classList.remove("flex");
      }
    }, MODAL_LEAVE_MS);
  }

  // ---------- helpers used by event modal + drag/drop ----------

  // Snap a date to the nearest 5-minute boundary. Used by:
  //  - drag/resize end (so dropping an event on the grid doesn't lock to
  //    Toast UI's default 30-min cell — we re-quantize to 5 min)
  //  - the new-event "selectDateTime" path
  function roundTo5Min(date) {
    const STEP = 5 * 60 * 1000;
    const d = new Date(date);
    d.setTime(Math.round(d.getTime() / STEP) * STEP);
    return d;
  }

  // "下一个事件" banner — finds the soonest upcoming event in the next 24h
  // that isn't yet started, OR the currently-in-progress event if any.
  // Caller passes the raw events array (server shape) and current ms.
  function updateNextEventBanner(rawEvents, now) {
    const banner = $("#next-event-banner");
    const text = $("#next-event-text");
    const jump = $("#next-event-jump");
    if (!banner || !text) return;
    const horizonMs = now + 24 * 3600 * 1000;
    // Prefer in-progress (start <= now <= end), else soonest upcoming.
    let inProgress = null, nextUp = null;
    for (const e of rawEvents) {
      const s = +new Date(e.startsAt), en = +new Date(e.endsAt);
      if (s <= now && en > now && !inProgress) inProgress = { e, s, en };
      else if (s > now && s < horizonMs && (!nextUp || s < nextUp.s)) nextUp = { e, s, en };
    }
    const target = inProgress || nextUp;
    if (!target) { banner.classList.add("hidden"); return; }
    const fmt = (ms) => {
      const mins = Math.round((ms - now) / 60000);
      if (mins < 0) return `${Math.abs(mins)} 分钟前开始`;
      if (mins < 60) return `${mins} 分钟后开始`;
      const hours = Math.round(mins / 60);
      if (hours < 24) return `${hours} 小时后开始`;
      return new Date(target.s).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
    };
    const verb = inProgress ? "进行中" : fmt(target.s);
    text.textContent = `${target.e.summary || "(无标题)"} · ${verb}`;
    banner.classList.remove("hidden");
    if (jump) {
      jump.onclick = () => {
        try { cal.setDate(new Date(target.s)); refresh(); } catch (_e) {}
      };
    }
  }

  // View vs edit mode for the event modal. View = read-only display
  // with an 编辑 button; edit = inputs enabled, 保存/删除 visible.
  // Set on every openEventModal call; new-event flow goes straight to
  // edit, click-existing goes to view first.
  function setModalMode(mode) {
    const form = $("#form-event");
    if (!form) return;
    const editing = mode === "edit";
    // Toggle ALL inputs / selects / textareas inside the form.
    form.querySelectorAll("input, select, textarea").forEach((el) => {
      // Hidden inputs (id / attendees JSON string) must stay enabled
      // so the form submits with their values.
      if (el.type === "hidden") return;
      el.disabled = !editing;
      el.classList.toggle("opacity-70", !editing);
      el.classList.toggle("cursor-not-allowed", !editing);
    });
    // Footer button visibility.
    const submitBtn = form.querySelector('button[type="submit"]');
    const cancelBtn = form.querySelector('.modal-close.rounded-lg');
    const deleteBtn = $("#btn-delete-event");
    const enterEditBtn = $("#btn-enter-edit");
    if (submitBtn) submitBtn.classList.toggle("hidden", !editing);
    if (cancelBtn) {
      cancelBtn.classList.toggle("hidden", false);
      // In view mode "取消" is misleading — there's nothing to cancel.
      // Swap the label to "关闭" without changing the click behavior.
      cancelBtn.textContent = editing ? "取消" : "关闭";
    }
    if (deleteBtn) deleteBtn.classList.toggle("hidden", !editing || !form.querySelector('[name="id"]').value);
    if (enterEditBtn) enterEditBtn.classList.toggle("hidden", editing);
    // Title
    const titleEl = $("#modal-event-title");
    if (titleEl) {
      const isExisting = !!form.querySelector('[name="id"]').value;
      titleEl.textContent = editing ? (isExisting ? "编辑事件" : "新建事件") : "事件详情";
    }
  }
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

  const DRAWER_LEAVE_MS = 300; // ≥ the CSS drawer/backdrop leave transition
  function showOnMobile() {
    MOBILE_OPEN.forEach(c => sidebar.classList.add(c));
    sidebar.classList.add("bwc-drawer");
    HIDDEN.forEach(c => sidebar.classList.remove(c));
    backdrop.classList.remove("hidden");
    void sidebar.offsetWidth;                 // reflow → slide/fade start off-screen
    sidebar.classList.add("is-open");
    backdrop.classList.add("is-open");
  }
  function hideOnMobile() {
    sidebar.classList.remove("is-open");       // slide out + fade backdrop
    backdrop.classList.remove("is-open");
    setTimeout(() => {
      if (sidebar.classList.contains("is-open")) return; // re-opened mid-leave
      MOBILE_OPEN.forEach(c => sidebar.classList.remove(c));
      sidebar.classList.remove("bwc-drawer");
      sidebar.classList.add("hidden");
      backdrop.classList.add("hidden");
    }, DRAWER_LEAVE_MS);
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

  // On phones the 7-column week view is unreadable — labels truncate to
  // 2 chars, drag-to-create misfires constantly. Default to "day" on
  // mobile; the view-switcher header still lets the user pick weekly.
  const isMobileViewport = window.matchMedia("(max-width: 640px)").matches;
  const cal = new tui.Calendar("#calendar", {
    defaultView: isMobileViewport ? "day" : "week",
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

  // Keep this in sync with the defaultView passed to tui.Calendar above —
  // otherwise the view-switcher buttons start out highlighting the wrong tab.
  let currentView = isMobileViewport ? "day" : "week";

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

  // Show pulse skeleton blocks while events load. Disappears as soon
  // as cal.createEvents runs (or loadEvents errors). On the local cache
  // path this barely flashes; on cold-start / slow network it prevents
  // the "white grid" feel that makes users think the page hung.
  function showLoadingSkeleton() {
    const host = document.getElementById("calendar");
    if (!host) return;
    let overlay = document.getElementById("calendar-skeleton");
    if (overlay) return; // already showing
    overlay = document.createElement("div");
    overlay.id = "calendar-skeleton";
    overlay.className = "absolute inset-0 pointer-events-none z-10 px-4 pt-16 flex flex-col gap-2";
    overlay.innerHTML =
      '<div class="h-7 rounded-md bg-slate-200/70 animate-pulse w-2/3"></div>' +
      '<div class="h-7 rounded-md bg-slate-200/70 animate-pulse w-1/2"></div>' +
      '<div class="h-7 rounded-md bg-slate-200/70 animate-pulse w-3/4"></div>' +
      '<div class="h-7 rounded-md bg-slate-200/70 animate-pulse w-1/3"></div>' +
      '<div class="h-7 rounded-md bg-slate-200/70 animate-pulse w-2/5"></div>';
    // Toast UI's calendar root needs `relative` so absolute overlay anchors.
    if (getComputedStyle(host).position === "static") host.style.position = "relative";
    host.appendChild(overlay);
  }
  function hideLoadingSkeleton() {
    document.getElementById("calendar-skeleton")?.remove();
  }

  // Friendly first-run nudge. Shows when the user has zero events across
  // any visible calendar (empty grid means "you've never used the app",
  // most of the time). Auto-hides as soon as they create or import one.
  function syncEmptyState(rawEventCount) {
    const banner = document.getElementById("empty-state");
    if (!banner) return;
    // Only show on first paint. If the user already has events anywhere,
    // hide; if they go to a future empty week, we still hide (it's normal
    // to have a quiet week). The signal is "no events anywhere in the
    // current view AND no events ever loaded since page load".
    if (rawEventCount > 0) {
      banner.classList.add("hidden");
      hasEverLoadedEvents = true;
      return;
    }
    if (!hasEverLoadedEvents) banner.classList.remove("hidden");
  }
  let hasEverLoadedEvents = false;

  // Mount the supplied event list into Toast UI Calendar. Pure render —
  // no fetching. Called twice from loadEvents() when stale-while-
  // revalidate is in play (first with cached data, then with fresh).
  function renderEventsToCalendar(rawEvents) {
    cal.clear();
    const now = Date.now();
    const events = rawEvents.map((e) => {
      // For all-day events the server stores UTC midnight (≈ pure date);
      // pass the YYYY-MM-DD string to Toast UI so it doesn't shift around
      // the user's local timezone boundary.
      const start = e.allDay ? e.startsAt.slice(0, 10) : e.startsAt;
      const end = e.allDay ? e.endsAt.slice(0, 10) : e.endsAt;
      // Past-event styling: events whose end is already in the past get
      // muted colors so the user's eye is drawn to upcoming + in-progress.
      // We don't move them out of the grid (still browsable in history),
      // just dim them.
      const endMs = +new Date(e.endsAt);
      const isPast = endMs < now;
      const style = isPast
        ? {
            backgroundColor: "#e2e8f0",
            borderColor: "#cbd5e1",
            dragBackgroundColor: "#cbd5e1",
            color: "#64748b",
          }
        : {};
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
        // Stash the master's RRULE so beforeUpdateEvent (drag/resize)
        // and clickEvent can detect "this is a recurring instance" and
        // prompt 仅此次/此后/系列 instead of silently editing the
        // whole series.
        raw: { rrule: e.rrule || null, isOccurrence: !!e.isOccurrence },
        ...style,
      };
    });
    cal.createEvents(events);
    // Force a render so the red now-line redraws after we just cleared.
    try { cal.render(); } catch (_e) {}
    // Update the "下一个事件" banner from the same data.
    updateNextEventBanner(rawEvents, now);
    syncEmptyState(rawEvents.length);
  }

  // Cheap fingerprint of an event list — used to decide whether stage 2
  // (fresh network data) differs from stage 1 (local cache). If the
  // server returned the same set of events with the same updatedAt
  // timestamps, skip the second render to avoid the cal.clear() jitter.
  function eventsFingerprint(list) {
    if (!list || list.length === 0) return "";
    // Sort by id so order changes don't trigger a re-render. Concat
    // id + startsAt + endsAt + (server-side updatedAt if present) to
    // catch edits while remaining fast on 3000-event lists.
    return list
      .map((e) => `${e.id}|${e.startsAt}|${e.endsAt}|${e.updatedAt || ""}`)
      .sort()
      .join("\n");
  }
  let lastRenderedFingerprint = "";

  async function loadEvents() {
    const startRaw = cal.getDateRangeStart().toDate();
    const endRaw = cal.getDateRangeEnd().toDate();
    // Normalize the visible range to a closed [start-of-day, end-of-day]
    // window. Toast UI's week & month views return `end` as the LAST day at
    // 00:00:00 local — so the server's `startsAt <= to` filter excludes any
    // event later in that day (e.g. 04:00 Sunday gets dropped for a
    // Mon-Sun week). Day view already returns end-of-day, but normalizing
    // here keeps every code path consistent. See v1.3.1 — fix
    // week-view-missing-events bug, root cause in TUI's getWeekDates.
    const start = new Date(startRaw);
    start.setHours(0, 0, 0, 0);
    const end = new Date(endRaw);
    end.setHours(23, 59, 59, 999);

    // Stage 1: paint instantly from IndexedDB cache if available.
    // Skipped on cold first load (no cache yet) and when bwcStore isn't
    // loaded (older client / no IndexedDB). When stage 1 paints, we
    // hide the skeleton immediately so nav feels instant; the skeleton
    // only flashes for cold loads.
    let stageOneEvents = null;
    if (window.bwcStore && window.bwcStore.getCached) {
      try {
        const cached = await window.bwcStore.getCached({
          from: start.toISOString(),
          to: end.toISOString(),
        });
        const filtered = (cached.events || []).filter((e) => visibleCalIds.has(e.calendarId));
        if (filtered.length > 0) {
          stageOneEvents = filtered;
          renderEventsToCalendar(filtered);
          lastRenderedFingerprint = eventsFingerprint(filtered);
          hideLoadingSkeleton();
        }
      } catch (_e) { /* fall through to network */ }
    }
    if (!stageOneEvents) showLoadingSkeleton();

    // Stage 2: fetch fresh from server in background.
    try {
      let data;
      if (window.bwcStore) {
        data = await window.bwcStore.getAll({
          from: start.toISOString(),
          to: end.toISOString(),
        });
      } else {
        const url = `/api/events?from=${encodeURIComponent(start.toISOString())}&to=${encodeURIComponent(end.toISOString())}`;
        const resp = await fetch(url, fetchOpts());
        if (!resp.ok) throw new Error("load_failed");
        data = await resp.json();
      }
      const rawEvents = (data.events || []).filter((e) => visibleCalIds.has(e.calendarId));
      const freshFp = eventsFingerprint(rawEvents);
      // Only re-render if data actually changed from what's on screen.
      // No-op skip avoids the cal.clear() → DOM teardown jitter every
      // 30s on the poll path.
      if (freshFp !== lastRenderedFingerprint) {
        renderEventsToCalendar(rawEvents);
        lastRenderedFingerprint = freshFp;
      }
    } catch (err) {
      console.error(err);
      // Only toast if stage 1 didn't paint — otherwise user already
      // sees their (cached) calendar, no need to alarm them.
      if (!stageOneEvents) {
        window.bwc && window.bwc.toast("加载事件失败", "error");
      }
    } finally {
      hideLoadingSkeleton();
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
  // Highlight whichever view we started in (week on desktop, day on mobile).
  $(`.view-btn[data-view="${currentView}"]`)?.classList.add("bg-brand-50", "text-brand-700", "font-semibold");
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
      closeModal(openModalEl);
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

  // ---- Timezone-aware "wall clock in event's TZ" hint ----
  // datetime-local inputs always render in the browser's local zone, no
  // matter what value we set. That's confusing when the event is anchored
  // to a different IANA zone — you type 14:00 thinking "14:00 New York",
  // but the input parses it as 14:00 wherever-you-are. To avoid that
  // bug-class we surface a yellow strip that shows what the typed time
  // means in the event's stored zone, side-by-side with the browser zone.
  const tzHintEl = $("#tz-hint");
  const browserTz = (() => {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (_e) { return "UTC"; }
  })();
  function syncTzHint() {
    if (!tzHintEl) return;
    const form = $("#form-event");
    const tzInput = form.querySelector('[name="timezone"]');
    const startsInput = form.querySelector('[name="startsAt"]');
    const eventTz = (tzInput && tzInput.value || "").trim();
    const startsLocal = startsInput && startsInput.value;
    if (!eventTz || !startsLocal || eventTz === browserTz) {
      tzHintEl.classList.add("hidden");
      tzHintEl.textContent = "";
      return;
    }
    // The browser's interpretation of the datetime-local input — Date()
    // treats it as local time, which IS the user's intent (they typed
    // the wall clock in their browser zone). Re-render that same instant
    // in the event's stored zone so they can see the offset.
    const instant = new Date(startsLocal);
    if (isNaN(instant.getTime())) { tzHintEl.classList.add("hidden"); return; }
    let inEventTz;
    try {
      inEventTz = new Intl.DateTimeFormat("zh-CN", {
        timeZone: eventTz, year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", hour12: false,
      }).format(instant);
    } catch (_e) {
      // Bad/unknown zone — hide rather than show garbage.
      tzHintEl.classList.add("hidden"); return;
    }
    tzHintEl.textContent = `⚠ 浏览器时区 ${browserTz}：你输入的 ${startsLocal.replace("T", " ")} 在事件时区（${eventTz}）是 ${inEventTz}`;
    tzHintEl.classList.remove("hidden");
  }
  // Trigger on every relevant input change. Debounced via the browser's
  // own event loop — these handlers are cheap (string + Intl format).
  $('#form-event [name="startsAt"]').addEventListener("input", syncTzHint);
  $('#form-event [name="timezone"]').addEventListener("input", syncTzHint);
  $('#form-event [name="timezone"]').addEventListener("change", syncTzHint);

  // ---- "编辑" button in view-mode modal switches to edit mode ----
  const enterEditBtn = $("#btn-enter-edit");
  if (enterEditBtn) {
    enterEditBtn.addEventListener("click", () => {
      const form = $("#form-event");
      const hasId = !!form.querySelector('[name="id"]').value;
      setModalMode("edit");
      // The delete button should be visible in edit mode for existing events.
      $("#btn-delete-event").classList.toggle("hidden", !hasId);
    });
  }

  // ---- Start/end time linkage ----
  // When the user changes 开始时间 in the modal, shift 结束时间 by the same
  // delta so the duration is preserved. Without this you have to manually
  // re-pick the end every time you bump the start by 10 minutes.
  //
  // Tracks the previously-known startsAt so we can compute the delta on
  // each change. Reset every time the modal opens (in openEventModal).
  const startsAtInput = $('#form-event [name="startsAt"]');
  const endsAtInput = $('#form-event [name="endsAt"]');
  const startsAtDateInput = $('#form-event [name="startsAtDate"]');
  const endsAtDateInput = $('#form-event [name="endsAtDate"]');
  let lastStartsAt = null;       // datetime-local
  let lastStartsAtDate = null;   // date
  function parseLocalDateTime(s) {
    // datetime-local has no timezone; treat as local.
    if (!s) return null;
    return new Date(s);
  }
  function fmtLocalDateTime(d) {
    if (!d || isNaN(+d)) return "";
    return toLocalDateTimeValue(d);
  }
  if (startsAtInput && endsAtInput) {
    startsAtInput.addEventListener("change", () => {
      const newStart = parseLocalDateTime(startsAtInput.value);
      const oldStart = parseLocalDateTime(lastStartsAt);
      const oldEnd = parseLocalDateTime(endsAtInput.value);
      lastStartsAt = startsAtInput.value;
      if (!newStart || !oldStart || !oldEnd) return;
      const delta = +newStart - +oldStart;
      if (delta === 0) return;
      endsAtInput.value = fmtLocalDateTime(new Date(+oldEnd + delta));
    });
  }
  if (startsAtDateInput && endsAtDateInput) {
    startsAtDateInput.addEventListener("change", () => {
      const newStart = startsAtDateInput.value ? new Date(startsAtDateInput.value + "T00:00") : null;
      const oldStart = lastStartsAtDate ? new Date(lastStartsAtDate + "T00:00") : null;
      const oldEnd = endsAtDateInput.value ? new Date(endsAtDateInput.value + "T00:00") : null;
      lastStartsAtDate = startsAtDateInput.value;
      if (!newStart || !oldStart || !oldEnd) return;
      const deltaDays = Math.round((+newStart - +oldStart) / 86400000);
      if (!deltaDays) return;
      const shifted = new Date(+oldEnd + deltaDays * 86400000);
      endsAtDateInput.value = toLocalDateValue(shifted);
    });
  }

  // Build a 3-option chooser modal for recurring-event edits/deletes.
  // Returns Promise<"instance"|"future"|"series"|null> — null means
  // the user cancelled (clicked outside or 取消). Used by both the
  // delete button and the form submit handler when the event has an
  // RRULE. The server's PATCH/DELETE handlers expect scope+recurrenceId
  // for "instance" and "future"; "series" routes through the normal
  // single-event code path.
  function promptRecurringScope(action) {
    return new Promise((resolve) => {
      const isDelete = action === "delete";
      const overlay = document.createElement("div");
      // Bottom-sheet on mobile (items-end + full-width), centered card
      // on desktop. Matches the visual language of the event modal so
      // users feel "I'm picking an option for the thing I just clicked".
      overlay.className = "fixed inset-0 z-[60] flex items-end sm:items-center justify-center bg-slate-900/60 p-0 sm:p-4";
      const card = document.createElement("div");
      card.className = "w-full sm:max-w-md sm:rounded-2xl rounded-t-2xl bg-white shadow-2xl";
      card.innerHTML =
        '<div class="border-b border-slate-200 px-5 py-4">' +
          '<h3 class="text-base font-semibold text-slate-900">' + (isDelete ? "删除重复事件" : "保存重复事件") + '</h3>' +
          '<p class="mt-1 text-sm text-slate-500">这是一个重复事件，请选择' + (isDelete ? "删除" : "保存") + '范围：</p>' +
        '</div>' +
        '<div class="space-y-2 p-5">' +
          '<button type="button" data-scope="instance" class="block w-full rounded-lg border border-slate-200 px-4 py-3 text-left hover:bg-slate-50">' +
            '<div class="text-sm font-medium text-slate-900">仅此事件</div>' +
            '<div class="mt-0.5 text-xs text-slate-500">只' + (isDelete ? "删除" : "修改") + '当前这一次，其他不变</div>' +
          '</button>' +
          '<button type="button" data-scope="future" class="block w-full rounded-lg border border-slate-200 px-4 py-3 text-left hover:bg-slate-50">' +
            '<div class="text-sm font-medium text-slate-900">此事件及后续</div>' +
            '<div class="mt-0.5 text-xs text-slate-500">从此次开始的所有后续</div>' +
          '</button>' +
          '<button type="button" data-scope="series" class="block w-full rounded-lg border border-slate-200 px-4 py-3 text-left hover:bg-slate-50">' +
            '<div class="text-sm font-medium text-slate-900">所有事件</div>' +
            '<div class="mt-0.5 text-xs text-slate-500">' + (isDelete ? "删除" : "修改") + '整个重复系列</div>' +
          '</button>' +
        '</div>' +
        '<div class="flex justify-end border-t border-slate-200 px-5 py-3">' +
          '<button type="button" data-scope="" class="rounded-md px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-100">取消</button>' +
        '</div>';
      overlay.appendChild(card);
      const cleanup = (s) => { try { overlay.remove(); } catch (_e) {} resolve(s || null); };
      overlay.addEventListener("click", (e) => {
        if (e.target === overlay) { cleanup(null); return; }
        const btn = e.target.closest("button[data-scope]");
        if (!btn) return;
        cleanup(btn.dataset.scope);
      });
      document.body.appendChild(overlay);
    });
  }

  // The 入会密码 field is meeting-specific: only reveal it when 分类 = 会议.
  // Toggled on modal open + on every category change. The save handler also
  // drops the passcode unless category === "meeting", so a lingering value in
  // the hidden input is never persisted for a non-meeting event.
  function syncMeetingPasswordField() {
    const form = $("#form-event");
    if (!form) return;
    const cat = form.querySelector('[name="category"]');
    const wrap = form.querySelector("#field-meeting-password");
    if (!cat || !wrap) return;
    // Hidden for non-meetings — UNLESS a passcode is already set (e.g. an event
    // created on a native client, which has no category picker), so an existing
    // passcode is never silently hidden and then dropped on save.
    const input = wrap.querySelector('[name="meetingPassword"]');
    const hasValue = !!(input && input.value.trim());
    wrap.classList.toggle("hidden", cat.value !== "meeting" && !hasValue);
  }

  function openEventModal(payload) {
    const form = $("#form-event");
    form.reset();
    form.querySelector('[name="id"]').value = payload.id || "";
    // Recurring-event scope tracking. The clickEvent handler passes
    // `recurrenceId` = the start of the specific occurrence the user
    // clicked (in TUI Calendar a recurring event renders N times, each
    // with its own .start). We stash it on the form dataset so submit
    // / delete handlers can ask "仅此次 / 此后 / 整个系列" and pass
    // the right recurrenceId to the API. Cleared for new events.
    let recIso = "";
    if (payload.recurrenceId) {
      try {
        const r = payload.recurrenceId;
        const d = r instanceof Date ? r : (r && typeof r.toDate === "function" ? r.toDate() : new Date(r));
        if (d && !isNaN(d.getTime())) recIso = d.toISOString();
      } catch (_e) { /* ignore — recurrenceId is optional */ }
    }
    form.dataset.recurrenceId = recIso;
    form.dataset.hasRrule = (payload.rrule && String(payload.rrule).trim()) ? "1" : "";
    if (payload.calendarId) form.querySelector('[name="calendarId"]').value = payload.calendarId;
    if (payload.summary) form.querySelector('[name="summary"]').value = payload.summary;
    if (payload.location) form.querySelector('[name="location"]').value = payload.location;
    if (payload.description) form.querySelector('[name="description"]').value = payload.description;
    form.querySelector('[name="startsAt"]').value = toLocalDateTimeValue(payload.startsAt || new Date());
    form.querySelector('[name="endsAt"]').value = toLocalDateTimeValue(payload.endsAt || new Date(Date.now() + 3600_000));
    form.querySelector('[name="startsAtDate"]').value = toLocalDateValue(payload.startsAt || new Date());
    form.querySelector('[name="endsAtDate"]').value = toLocalDateValue(payload.endsAt || new Date());
    // Remember the just-set start values so the change-listener can
    // compute deltas correctly (we want to track delta from the
    // user's most-recent typed value, not from form.reset()'s blank).
    lastStartsAt = form.querySelector('[name="startsAt"]').value;
    lastStartsAtDate = form.querySelector('[name="startsAtDate"]').value;
    form.querySelector('[name="allDay"]').checked = !!payload.allDay;
    const catSel = form.querySelector('[name="category"]');
    catSel.value = payload.category || "";
    // Bind the category→passcode-visibility listener once. The initial
    // visibility sync runs further down, AFTER the passcode input is populated.
    if (catSel && !catSel.dataset.mpBound) {
      catSel.dataset.mpBound = "1";
      catSel.addEventListener("change", syncMeetingPasswordField);
    }
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
    // Meeting join passcode (extra.meetingPassword).
    const pwInput = form.querySelector('[name="meetingPassword"]');
    if (pwInput) pwInput.value = payload.meetingPassword || "";
    // Category + passcode are both set now → compute the field's visibility.
    syncMeetingPasswordField();
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
    // Timezone field is now a hidden <input> driven by the custom
    // searchable combobox (#modal-tz). Set the underlying value, then
    // ask the picker to refresh its visible label. For a NEW event with
    // no stored timezone, prefill the BROWSER-DETECTED zone (the OS's IANA
    // zone via Intl — already accurate; no geolocation needed) so the
    // picker reflects where the user actually is instead of a hardcoded
    // Asia/Shanghai. The user still sees + can change it in the picker.
    const tzInput = form.querySelector('[name="timezone"]');
    if (tzInput) {
      let detectedTz = "Asia/Shanghai";
      try { detectedTz = Intl.DateTimeFormat().resolvedOptions().timeZone || detectedTz; } catch (_e) { /* keep fallback */ }
      tzInput.value = payload.timezone || detectedTz;
      const tzPicker = tzInput.closest("[data-tz-picker]");
      if (tzPicker && typeof window.bwcSyncTzPicker === "function") {
        window.bwcSyncTzPicker(tzPicker);
      }
    }
    syncAllDayUI();
    // Show tz hint immediately if the event is anchored to a non-browser zone.
    if (typeof syncTzHint === "function") syncTzHint();
    // Mode: existing events open in VIEW mode (read-only with 编辑 button);
    // new events go straight to EDIT mode. payload.forceEdit lets internal
    // callers override (e.g. the 编辑 button itself).
    const modeFlag = (payload.id && !payload.forceEdit) ? "view" : "edit";
    setModalMode(modeFlag);
    $("#btn-delete-event").classList.toggle("hidden", !payload.id || modeFlag !== "edit");
    openModal("#modal-event");
    // Clear the natural-language input every time the modal opens —
    // stale text from a previous session is more confusing than helpful.
    const nl = $("#nl-input");
    const nlHint = $("#nl-hint");
    if (nl) nl.value = "";
    if (nlHint) { nlHint.classList.add("hidden"); nlHint.textContent = ""; }
  }

  // ---------- Natural-language event parser ----------
  // Parses inputs like "明天下午三点开会" or "周五10点 1小时 团建" into
  // { summary, startsAt, endsAt }. Returns null if it can't pull out at
  // least one date+time. Pure regex — no LLM, no API call, runs entirely
  // in the user's browser, works offline. Kept behaviour-identical to the
  // server parser in src/lib/nl_parse.ts (guarded by test/nl_parse.test.ts)
  // so web / iOS / Android / desktop all understand the same phrasings.
  const NL_CN_DIGIT = {
    "零": 0, "〇": 0, "一": 1, "二": 2, "两": 2, "三": 3, "四": 4,
    "五": 5, "六": 6, "七": 7, "八": 8, "九": 9,
  };
  // Chinese numeral → number, 0..59 (also accepts an ASCII-digit string).
  function nlCnNum(s) {
    if (/^[0-9]+$/.test(s)) return Number(s);
    if (s === "十") return 10;
    const i = s.indexOf("十");
    if (i === -1) {
      let n = 0;
      for (const ch of s) {
        if (!(ch in NL_CN_DIGIT)) return NaN;
        n = n * 10 + NL_CN_DIGIT[ch];
      }
      return n;
    }
    const before = s.slice(0, i), after = s.slice(i + 1);
    const tens = before === "" ? 1 : (before in NL_CN_DIGIT ? NL_CN_DIGIT[before] : NaN);
    const ones = after === "" ? 0 : (after in NL_CN_DIGIT ? NL_CN_DIGIT[after] : NaN);
    if (isNaN(tens) || isNaN(ones)) return NaN;
    return tens * 10 + ones;
  }
  // Minutes half of a "X点Y" token: 半→30, 一刻/三刻→15/45, else the numeral.
  function nlMinToken(g) {
    if (!g) return 0;
    if (g === "半") return 30;
    if (g.endsWith("刻")) { const q = nlCnNum(g.slice(0, -1)); return isNaN(q) ? 0 : q * 15; }
    const n = nlCnNum(g.replace(/分$/, ""));
    return isNaN(n) ? 0 : n;
  }
  const NL_NUM = "[0-9零〇一二两三四五六七八九十]";

  function parseNaturalLanguageEvent(text) {
    if (!text || typeof text !== "string") return null;
    // Pad so the spaced "半" fallback still works; token rules no longer
    // require whitespace, so connected input like "明天下午三点开会" parses too.
    let remaining = " " + text.trim() + " ";

    // Step 1: date. Longer words first (大后天 ⊃ 后天) since there are no
    // whitespace guards to keep them apart.
    const now = new Date();
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    let dateOffset = null;
    const dateRules = [
      [/大后天/, 3], [/后天/, 2], [/明天/, 1], [/今天/, 0],
      [/前天/, -2], [/昨天/, -1],
    ];
    for (const [re, off] of dateRules) {
      if (re.test(remaining)) {
        dateOffset = off;
        remaining = remaining.replace(re, " ");
        break;
      }
    }
    // 周一..周日 / 周天 / 周末 → NEXT occurrence (never today); 下周X +7, 下下周X +14.
    const weekdayMap = { "一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "日": 0, "天": 0, "末": 6 };
    const wkRe = /(下下周|下周|本周|这周|周)([一二三四五六日天末])/;
    const wkMatch = remaining.match(wkRe);
    if (wkMatch && dateOffset === null) {
      const target = weekdayMap[wkMatch[2]];
      let diff = (target - now.getDay() + 7) % 7;
      if (diff === 0) diff = 7;   // 周X always means upcoming, not today
      if (wkMatch[1] === "下周") diff += 7;
      else if (wkMatch[1] === "下下周") diff += 14;
      dateOffset = diff;
      remaining = remaining.replace(wkRe, " ");
    }
    // X月X日 / X月X号
    const mdRe = /(\d{1,2})月(\d{1,2})[日号]?/;
    const mdMatch = remaining.match(mdRe);
    if (mdMatch && dateOffset === null) {
      const m = Number(mdMatch[1]) - 1;
      const d = Number(mdMatch[2]);
      const tgt = new Date(now.getFullYear(), m, d);
      if (tgt < day) tgt.setFullYear(tgt.getFullYear() + 1);
      dateOffset = Math.round((tgt - day) / 86400000);
      remaining = remaining.replace(mdRe, " ");
    }

    // Step 2: time. Colon form ("15:30") first, then 点/时 form with an
    // optional period prefix and ASCII-or-Chinese numerals + 半/刻/分 minutes.
    let hours = null, mins = 0;
    const NL_PERIOD = "(早上|上午|中午|下午|晚上|凌晨)?";
    const colonRe = new RegExp(NL_PERIOD + "([0-9]{1,2})[:：]([0-9]{2})");
    const dianRe = new RegExp(
      NL_PERIOD + "(" + NL_NUM + "{1,3})[点时](半|" + NL_NUM + "{1,3}刻|[0-9]{1,2}分?|" + NL_NUM + "{1,3}分?)?",
    );
    let tMatch = remaining.match(colonRe);
    let matchedRe = tMatch ? colonRe : null;
    if (!tMatch) { tMatch = remaining.match(dianRe); if (tMatch) matchedRe = dianRe; }
    if (tMatch && matchedRe) {
      const period = tMatch[1];
      let h = nlCnNum(tMatch[2]);
      const m = matchedRe === colonRe ? Number(tMatch[3]) : nlMinToken(tMatch[3]);
      if (period === "下午" || period === "晚上") { if (h < 12) h += 12; }
      else if (period === "凌晨") { if (h === 12) h = 0; }
      else if (period === "中午") { h = 12; }
      if (!isNaN(h) && h >= 0 && h <= 23 && m >= 0 && m <= 59) {
        hours = h; mins = m;
        remaining = remaining.replace(matchedRe, " ");
      }
    }
    // "半点" with the 半 split off by whitespace, e.g. "下午3点 半".
    const halfRe = /\s半\s/;
    if (halfRe.test(remaining) && hours !== null && mins === 0) {
      mins = 30;
      remaining = remaining.replace(halfRe, " ");
    }

    // Need at least a date OR time to count this as a successful parse.
    if (dateOffset === null && hours === null) return null;

    // Step 3: duration. "X个半小时" (X·60+30), then plain "X小时/X分钟"
    // (ASCII or Chinese, optional 个), then a bare "半小时" fallback.
    let durationMin = 60;
    let durSet = false;
    const durHalfRe = new RegExp("([0-9]+|" + NL_NUM + "+)个?半个?小时");
    const durHalfM = remaining.match(durHalfRe);
    if (durHalfM) {
      const n = nlCnNum(durHalfM[1]);
      if (!isNaN(n)) { durationMin = n * 60 + 30; durSet = true; remaining = remaining.replace(durHalfRe, " "); }
    }
    if (!durSet) {
      const durRe = new RegExp("([0-9]+(?:\\.[0-9]+)?|" + NL_NUM + "+)\\s?个?\\s?(小时|h|hours?|分钟|min|minutes?)", "i");
      const durMatch = remaining.match(durRe);
      if (durMatch) {
        const n = /^[0-9.]+$/.test(durMatch[1]) ? Number(durMatch[1]) : nlCnNum(durMatch[1]);
        const unit = durMatch[2].toLowerCase();
        if (!isNaN(n)) {
          durationMin = (unit.startsWith("小时") || unit === "h" || unit.startsWith("hour"))
            ? Math.round(n * 60)
            : Math.round(n);
          durSet = true;
          remaining = remaining.replace(durRe, " ");
        }
      }
    }
    if (!durSet) {
      const halfHourRe = /半个?小时/;
      if (halfHourRe.test(remaining)) { durationMin = 30; remaining = remaining.replace(halfHourRe, " "); }
    }

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
    const summary = remaining.replace(/[，。、；：,;:]+/g, " ").replace(/\s+/g, " ").trim();
    return { summary, startsAt, endsAt };
  }

  // Wire the natural-language input. As the user types we show a LIVE
  // (debounced) preview of what we understood — but only touch the form
  // fields on an explicit commit (Enter or blur), so a half-typed phrase
  // never rewrites the form underneath them. Failures stay quiet during
  // typing and only nudge on commit.
  {
    const nlInput = $("#nl-input");
    const nlHint = $("#nl-hint");
    const fmtDate = (d) => `${d.getMonth() + 1}月${d.getDate()}日`;
    const fmtTime = (d) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    function showParsed(parsed, commit) {
      if (!nlInput || !nlHint) return;
      if (!parsed) {
        if (commit && nlInput.value.trim()) {
          nlHint.classList.remove("hidden");
          nlHint.style.color = "rgb(100 116 139)";
          nlHint.textContent = "没看懂时间，试试「明天下午三点 开会」";
        } else {
          nlHint.classList.add("hidden");
          nlHint.textContent = "";
        }
        return;
      }
      if (commit) {
        const form = $("#form-event");
        if (parsed.summary) form.querySelector('[name="summary"]').value = parsed.summary;
        form.querySelector('[name="startsAt"]').value = toLocalDateTimeValue(parsed.startsAt);
        form.querySelector('[name="endsAt"]').value = toLocalDateTimeValue(parsed.endsAt);
      }
      // "7月4日 15:00–16:30 · 开会" — collapse the end to just a time when it's
      // the same calendar day, so the duration reads at a glance.
      const sameDay = parsed.startsAt.toDateString() === parsed.endsAt.toDateString();
      const endStr = sameDay ? fmtTime(parsed.endsAt) : `${fmtDate(parsed.endsAt)} ${fmtTime(parsed.endsAt)}`;
      nlHint.classList.remove("hidden");
      nlHint.style.color = "rgb(67 56 202)"; // brand-700
      nlHint.textContent = `✓ ${fmtDate(parsed.startsAt)} ${fmtTime(parsed.startsAt)}–${endStr} · ${parsed.summary || "无标题"}`;
    }
    function applyNl(commit) {
      if (!nlInput) return;
      showParsed(parseNaturalLanguageEvent(nlInput.value), commit);
    }
    if (nlInput) {
      let debounce;
      nlInput.addEventListener("input", () => {
        clearTimeout(debounce);
        debounce = setTimeout(() => applyNl(false), 200); // live preview only
      });
      nlInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); clearTimeout(debounce); applyNl(true); }
      });
      nlInput.addEventListener("blur", () => { clearTimeout(debounce); if (nlInput.value.trim()) applyNl(true); });
    }
  }

  // Both the desktop toolbar button and the mobile FAB share this handler.
  const openNewEvent = () => openEventModal({ startsAt: new Date(), endsAt: new Date(Date.now() + 3600_000) });
  $("#btn-new-event").addEventListener("click", openNewEvent);
  $("#btn-new-event-fab")?.addEventListener("click", openNewEvent);
  // Empty-state nudge buttons reuse the same handlers.
  $("#empty-new-event")?.addEventListener("click", openNewEvent);
  $("#empty-import")?.addEventListener("click", () => openImportCalendar());

  cal.on("selectDateTime", (info) => {
    // Quantize the click-drag selection to 5 minutes — Toast UI by default
    // snaps to 30-minute cells which is too coarse for short meetings.
    const start = info.isAllday ? info.start : roundTo5Min(info.start);
    const end = info.isAllday ? info.end : roundTo5Min(info.end);
    openEventModal({ startsAt: start, endsAt: end, allDay: info.isAllday });
    cal.clearGridSelections();
  });

  cal.on("clickEvent", async (info) => {
    const calId = info.event.calendarId;
    const id = info.event.id;
    // Fetch just this one event (server filters by ?eventId) rather than
    // pulling the entire calendar's event list to find one by id. Falls back
    // gracefully on older servers that ignore the param (returns all → .find).
    const evs = await fetch(`/api/calendars/${calId}/events?eventId=${encodeURIComponent(id)}`, fetchOpts()).then((r) => r.json()).catch(() => []);
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
      meetingPassword: extra.meetingPassword || "",
      // Show the clicked occurrence's start/end (not the master's) so
      // editing "仅此次" starts from the right slot. fresh.startsAt is
      // the master; info.event.start is the occurrence.
      startsAt: info.event.start || fresh.startsAt,
      endsAt: info.event.end || fresh.endsAt,
      allDay: fresh.allDay,
      rrule: fresh.rrule || "",
      // The occurrence's start doubles as the RECURRENCE-ID. The server
      // uses this to know which instance to add to exdates / split at.
      recurrenceId: info.event.start || null,
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
    // Guard against double-submit. The handler awaits a conflict-check
    // round-trip before saving; a fast double-click (or Enter + click) in
    // that window would call bwcStore.put() twice, each minting a DIFFERENT
    // local id / clientUid — so the server's idempotency can't collapse
    // them and you'd get TWO events. Disable the button for the whole flow
    // (the `finally` re-enables it) and also surface a "保存中…" state.
    const submitBtn = e.target.querySelector('button[type="submit"]');
    if (submitBtn && submitBtn.dataset.saving === "1") return;
    const prevLabel = submitBtn ? submitBtn.textContent : "";
    if (submitBtn) { submitBtn.dataset.saving = "1"; submitBtn.disabled = true; submitBtn.textContent = "保存中…"; }
    try {
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
        meetingPassword: (data.meetingPassword || "").trim() || undefined,
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
          if (!(await window.bwc.confirm({
            title: "时间冲突",
            message: `和现有事件时间冲突：\n${names}${more}\n\n仍要保存？`,
            confirmLabel: "仍然保存",
          }))) return;
        }
      }
    } catch (_e) { /* soft check — never block save on a network glitch */ }
    // Recurring-event scope dialog: if we're editing an existing event
    // that has an RRULE, ask whether the change applies to just this
    // occurrence, this+future, or the whole series. New events skip
    // this (no RRULE yet) and series scope on a recurring event takes
    // the regular master-patch path so bwcStore can still cache it.
    const form = $("#form-event");
    let recurringScope = null;
    if (id && form && form.dataset.hasRrule === "1") {
      recurringScope = await promptRecurringScope("edit");
      if (!recurringScope) return; // user cancelled — leave modal open
    }
    try {
      // Scoped recurring edits (instance / future) must hit the server
      // directly — bwcStore's outbox doesn't yet model exdates or series
      // splits, so an offline scoped edit would silently misbehave on
      // sync. "Series" scope is equivalent to a normal master patch.
      const isScopedRecurring = recurringScope === "instance" || recurringScope === "future";
      if (isScopedRecurring) {
        const recurrenceId = form.dataset.recurrenceId || undefined;
        const resp = await fetch(`/api/events/${id}`, fetchOpts({
          method: "PATCH",
          body: JSON.stringify({ ...body, scope: recurringScope, recurrenceId }),
        }));
        if (!resp.ok) throw new Error(await resp.text());
        closeModal("#modal-event");
        await loadEvents();
        window.bwc && window.bwc.toast("事件已更新", "success");
      } else if (window.bwcStore) {
        // Route through bwcStore when available — optimistic local update +
        // outbox queue means the modal can close instantly even on flaky network.
        await window.bwcStore.put(id ? { ...body, id } : body, body.calendarId);
        closeModal("#modal-event");
        await loadEvents();
        const offline = !window.bwcStore.isOnline();
        window.bwc && window.bwc.toast(
          offline
            ? (id ? "事件已暂存（离线，联网后自动同步）" : "事件已暂存（离线，联网后自动同步）")
            : (id ? "事件已更新" : "事件已添加"),
          "success",
        );
      } else {
        const url = id ? `/api/events/${id}` : "/api/events";
        const method = id ? "PATCH" : "POST";
        const resp = await fetch(url, fetchOpts({ method, body: JSON.stringify(body) }));
        if (!resp.ok) throw new Error(await resp.text());
        closeModal("#modal-event");
        await loadEvents();
        window.bwc && window.bwc.toast(id ? "事件已更新" : "事件已添加", "success");
      }
    } catch (err) {
      console.error(err);
      window.bwc && window.bwc.toast("保存失败", "error");
    }
    } finally {
      // Re-enable on every exit path (success, validation cancel, error)
      // so the form is usable again. Harmless when the modal already closed.
      if (submitBtn) { submitBtn.dataset.saving = ""; submitBtn.disabled = false; submitBtn.textContent = prevLabel; }
    }
  });

  $("#btn-delete-event").addEventListener("click", async () => {
    const form = $("#form-event");
    const id = $('#form-event [name="id"]').value;
    if (!id) return;
    // For recurring events the scope dialog IS the confirmation.
    // For non-recurring, the styled bwc.confirm dialog.
    let recurringScope = null;
    if (form && form.dataset.hasRrule === "1") {
      recurringScope = await promptRecurringScope("delete");
      if (!recurringScope) return; // user cancelled
    } else {
      if (!(await window.bwc.confirm({ message: "删除该事件？", danger: true, confirmLabel: "删除" }))) return;
    }
    // Scoped recurring delete (this / this+future): bypass bwcStore
    // and hit the server directly with ?scope=&recurrenceId= — the
    // offline outbox model can't represent partial-series deletes
    // safely.
    const isScopedRecurring = recurringScope === "instance" || recurringScope === "future";
    if (isScopedRecurring) {
      const recurrenceId = form.dataset.recurrenceId || "";
      const qs = `?scope=${recurringScope}&recurrenceId=${encodeURIComponent(recurrenceId)}`;
      try {
        const resp = await fetch(`/api/events/${id}${qs}`, {
          method: "DELETE",
          credentials: "same-origin",
          headers: { "X-CSRF-Token": ctx.csrfToken },
        });
        if (!resp.ok && resp.status !== 404) throw new Error(await resp.text());
        closeModal("#modal-event");
        await loadEvents();
        window.bwc && window.bwc.toast(
          recurringScope === "instance" ? "已删除此次" : "已删除此次及之后",
          "success",
        );
      } catch (err) {
        console.error("delete_recurring_scoped", err);
        window.bwc && window.bwc.toast("删除失败", "error");
      }
      return;
    }
    // Undo handler — POSTs to /api/events/:id/restore which clears
    // deletedAt. Used by both the bwcStore and direct-delete code
    // paths below. Re-fetches grid on success.
    async function undoDelete() {
      try {
        const resp = await fetch(`/api/events/${id}/restore`, fetchOpts({ method: "POST" }));
        if (!resp.ok && resp.status !== 404) throw new Error(await resp.text());
        // If bwcStore is in use, our local mirror still has the
        // delete-pending state — easiest fix is to invalidate the cache
        // and let getAll repopulate from the server.
        if (window.bwcStore && window.bwcStore.invalidate) {
          try { await window.bwcStore.invalidate(); } catch (_e) {}
        }
        await loadEvents();
        window.bwc && window.bwc.toast("已撤销删除", "success");
      } catch (err) {
        console.error("undo_delete", err);
        window.bwc && window.bwc.toast("撤销失败", "error");
      }
    }

    // Optimistic delete via bwcStore — works offline.
    if (window.bwcStore) {
      try {
        await window.bwcStore.remove(id);
        closeModal("#modal-event");
        await loadEvents();
        const offline = !window.bwcStore.isOnline();
        if (offline) {
          // No undo for offline deletes — restore would race with the
          // outbox replay. User can dig into the conflict modal if
          // they really need to recover.
          window.bwc && window.bwc.toast("已标记删除（联网后同步）", "success");
        } else {
          window.bwc && window.bwc.toast("事件已删除", "success", {
            actionLabel: "撤销", onAction: undoDelete,
          });
        }
      } catch (err) {
        console.error("delete_event_store", err);
        window.bwc && window.bwc.toast("删除失败", "error");
      }
      return;
    }
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
      if (resp.status === 404) {
        window.bwc && window.bwc.toast("事件已不存在，已刷新", "success");
      } else {
        window.bwc && window.bwc.toast("事件已删除", "success", {
          actionLabel: "撤销", onAction: undoDelete,
        });
      }
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
          // New calendar inherits the user's browser-detected (OS/IANA) zone
          // rather than a hardcoded Asia/Shanghai.
          let newCalTz = "Asia/Shanghai";
          try { newCalTz = Intl.DateTimeFormat().resolvedOptions().timeZone || newCalTz; } catch (_e) { /* keep fallback */ }
          const created = await fetch("/api/calendars", fetchOpts({
            method: "POST",
            body: JSON.stringify({ name, color, timezone: newCalTz }),
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
  // Snapshot of the calendar's original values for dirty-tracking. We
  // only enable the Save button when something actually changed so users
  // get clear feedback that "this form does something" without the noise
  // of saving the same data back.
  let editCalOriginal = null;
  $$("[data-cal-menu]").forEach((btn) => btn.addEventListener("click", async (e) => {
    e.preventDefault(); e.stopPropagation();
    const id = btn.dataset.calMenu;
    const c = ctx.calendars.find((x) => x.id === id);
    if (!c) return;
    currentMenuCalId = id;
    $("#cal-menu-color").style.background = c.color;
    $("#cal-menu-name").textContent = c.name;
    populateEditCalendarForm(c);
    await loadShareTokens(id);
    openModal("#modal-cal-menu");
  }));

  // Hydrate the edit form from a calendar's current values. Re-builds the
  // color picker with the calendar's color pre-selected, sets the tz
  // picker's hidden input + label, and resets dirty state.
  function populateEditCalendarForm(c) {
    const form = $("#form-edit-calendar");
    if (!form) return;
    form.elements.name.value = c.name || "";
    form.elements.description.value = c.description || "";
    form.elements.color.value = c.color || "#6366f1";
    form.elements.timezone.value = c.timezone || "";
    // Rebuild the color swatch row so the matching swatch is checked.
    buildColorPicker(
      form.querySelector('[data-color-picker="form-edit-calendar"]'),
      "color",
      c.color || "#6366f1",
    );
    // Sync timezone picker label — `bwcSyncTzPicker` is exposed by the
    // timezone-picker init code; it reads the hidden input and updates
    // the visible "上海（UTC+8）"-style label.
    const tzPicker = form.querySelector("[data-tz-picker]");
    if (tzPicker && typeof window.bwcSyncTzPicker === "function") {
      window.bwcSyncTzPicker(tzPicker);
    }
    editCalOriginal = {
      name: form.elements.name.value,
      description: form.elements.description.value,
      color: form.elements.color.value,
      timezone: form.elements.timezone.value,
    };
    updateEditCalDirty();
  }

  // Diff form values against the snapshot taken when the modal opened.
  // Toggles the Save button's `disabled` attribute — empty name also
  // counts as not-saveable since the server requires it (`min(1)`).
  function updateEditCalDirty() {
    const form = $("#form-edit-calendar");
    if (!form || !editCalOriginal) return;
    const cur = {
      name: form.elements.name.value.trim(),
      description: form.elements.description.value,
      color: form.elements.color.value,
      timezone: form.elements.timezone.value,
    };
    const changed =
      cur.name !== (editCalOriginal.name || "").trim() ||
      cur.description !== (editCalOriginal.description || "") ||
      cur.color !== editCalOriginal.color ||
      cur.timezone !== editCalOriginal.timezone;
    $("#btn-save-calendar").disabled = !cur.name || !changed;
  }

  // Wire dirty-checking on every input + color swatch click + tz pick.
  // The color picker rewrites the hidden input value via change-event
  // dispatch, the tz picker writes the hidden input + dispatches input
  // — both flow through here without needing per-control listeners.
  $("#form-edit-calendar")?.addEventListener("input", updateEditCalDirty);
  $("#form-edit-calendar")?.addEventListener("change", updateEditCalDirty);

  $("#form-edit-calendar")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!currentMenuCalId) return;
    const form = e.target;
    const body = {
      name: form.elements.name.value.trim(),
      description: form.elements.description.value,
      color: form.elements.color.value,
      timezone: form.elements.timezone.value,
    };
    // Skip empty optional fields so we never overwrite with the empty
    // string — the server treats "" and absent the same for description,
    // but timezone "" would change the calendar default and isn't what
    // the user means.
    if (!body.description) delete body.description;
    if (!body.timezone) delete body.timezone;
    try {
      const resp = await fetch(`/api/calendars/${currentMenuCalId}`,
        fetchOpts({ method: "PATCH", body: JSON.stringify(body) }));
      if (!resp.ok) throw new Error(await resp.text());
      window.bwc && window.bwc.toast("已保存", "success");
      // Reload so the calendar name in the sidebar, event colors, and
      // calendar pickers everywhere pick up the new values. Could be
      // surgical with ctx.calendars updates but reload is bulletproof.
      setTimeout(() => window.location.reload(), 400);
    } catch (err) {
      console.error(err);
      window.bwc && window.bwc.toast("保存失败", "error");
    }
  });

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
        if (!(await window.bwc.confirm({ message: "撤销该订阅链接？已订阅的客户端会失效。", danger: true, confirmLabel: "撤销" }))) return;
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
    if (!(await window.bwc.confirm({
      title: "删除日历",
      message: "所有事件和订阅链接都会消失，且不可恢复。",
      danger: true,
      confirmLabel: "删除日历",
    }))) return;
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
      // Snap drag/resize to 5-minute boundaries. Toast UI Calendar's grid
      // snaps to its hour-cell subdivisions (30 min default); we want finer
      // control without making the grid itself visually busier.
      if (changes.start && !event.isAllday) changes.start = roundTo5Min(changes.start);
      if (changes.end && !event.isAllday) changes.end = roundTo5Min(changes.end);
      const startsAt = changes.start ? new Date(changes.start).toISOString() : undefined;
      const endsAt = changes.end ? new Date(changes.end).toISOString() : undefined;
      const body = {};
      if (startsAt) body.startsAt = startsAt;
      if (endsAt) body.endsAt = endsAt;

      // Recurring events: dragging a single occurrence on the grid is
      // ambiguous — does the user mean "move this one instance" or
      // "shift the whole series"? Toast UI hands us the *occurrence*
      // event, but its raw .rrule is the master's rule. Ask first.
      // event.raw.rrule is populated by loadEvents from the API
      // response — see the rrule mapping below in /api/events.
      const isRecurring = !!(event.raw && event.raw.rrule);
      let recurringScope = null;
      if (isRecurring) {
        recurringScope = await promptRecurringScope("edit");
        if (!recurringScope) return; // user cancelled the drag
      }

      if (recurringScope === "instance" || recurringScope === "future") {
        // `event.start` here is the PRE-drag occurrence start — Toast UI
        // passes the original event to beforeUpdateEvent and applies
        // `changes` only after we call updateEvent (which we don't, in
        // the scoped path — we reload instead). That makes it the
        // RECURRENCE-ID the server needs to identify which instance.
        const occurrenceStart = event.start && event.start.toDate
          ? event.start.toDate()
          : new Date(event.start);
        const recurrenceId = occurrenceStart.toISOString();
        const resp = await fetch(`/api/events/${event.id}`, fetchOpts({
          method: "PATCH",
          body: JSON.stringify({ ...body, scope: recurringScope, recurrenceId }),
        }));
        if (!resp.ok) throw new Error();
        // Server side returns either a detached event or new master —
        // simplest is to reload the whole grid so we pick up exdates +
        // new rows in one shot.
        await loadEvents();
        window.bwc && window.bwc.toast(
          recurringScope === "instance" ? "已修改此次" : "已修改此次及之后",
          "success",
        );
        return;
      }

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

  // ---------- Timezone picker (custom searchable combobox) ----------
  // Replaces the old <input list=tz-options> which let users free-type
  // garbage like "上海" — that "looked right" but isn't a valid IANA id
  // so the event broke silently on display + email + CalDAV.
  //
  // Now: hidden field always holds a known IANA id; the trigger button
  // shows the friendly label; clicking opens a modal with a search box
  // that filters by Chinese label / IANA id / UTC offset. Always
  // commits a value from the curated+IANA list.
  (function wireTzPicker() {
    const modal = $("#modal-tz");
    const search = $("#tz-search");
    const list = $("#tz-list");
    if (!modal || !search || !list) return;
    const zones = Array.isArray(window.bwcTimezones) ? window.bwcTimezones : [];
    if (zones.length === 0) return;

    // Track the picker element that opened the modal, so we know where
    // to write the result back. Only one modal can be open at a time.
    let activePicker = null;

    function labelFor(zoneId) {
      // Find the first matching curated entry; fall back to the IANA id.
      const z = zones.find((t) => t.id === zoneId);
      if (!z) return zoneId || "Asia/Shanghai";
      return `${z.label}（${z.offset}）`;
    }

    function syncPickerLabel(picker) {
      const hidden = picker.querySelector('input[name="timezone"]');
      const label = picker.querySelector("[data-tz-label]");
      if (!hidden || !label) return;
      label.textContent = labelFor(hidden.value);
    }

    function renderList(filter) {
      const q = filter.trim().toLowerCase();
      const matches = q
        ? zones.filter((z) => {
            const hay = `${z.label} ${z.id} ${z.offset}`.toLowerCase();
            return hay.includes(q);
          })
        : zones;
      // Cap at 200 results so a blank search doesn't dump 420 DOM nodes.
      const capped = matches.slice(0, 200);
      list.innerHTML = capped.length === 0
        ? '<li class="py-6 text-center text-sm text-slate-400">没有匹配的时区</li>'
        : capped.map((z) =>
            `<li><button type="button" data-tz-pick="${z.id}" class="w-full flex items-center justify-between rounded-md px-3 py-2 text-left text-sm hover:bg-slate-50 active:bg-slate-100">
              <span class="text-slate-900">${escapeHtml(z.label)}</span>
              <span class="ml-3 text-xs text-slate-500 font-mono">${escapeHtml(z.id)} · ${escapeHtml(z.offset)}</span>
            </button></li>`,
          ).join("");
    }

    function openTzModal(picker) {
      activePicker = picker;
      openModal(modal);
      search.value = "";
      renderList("");
      // Focus the search field on desktop; on mobile we don't auto-focus
      // because pulling up the keyboard right when the bottom-sheet
      // animates in feels janky. Tap-to-focus works fine.
      if (!window.matchMedia("(max-width: 640px)").matches) {
        setTimeout(() => search.focus(), 30);
      }
      // Scroll the currently-selected item into view if it's in the list.
      const hidden = picker.querySelector('input[name="timezone"]');
      if (hidden && hidden.value) {
        const found = list.querySelector(`[data-tz-pick="${CSS.escape(hidden.value)}"]`);
        if (found) found.scrollIntoView({ block: "center" });
      }
    }

    function closeTzModal() {
      closeModal(modal);
      activePicker = null;
    }

    function commitPick(zoneId) {
      if (!activePicker) return;
      const hidden = activePicker.querySelector('input[name="timezone"]');
      if (hidden) hidden.value = zoneId;
      syncPickerLabel(activePicker);
      // Notify listeners (e.g. tz-hint in event modal) by firing 'change'
      // on the hidden input.
      if (hidden) hidden.dispatchEvent(new Event("change", { bubbles: true }));
      closeTzModal();
    }

    // Delegate clicks on triggers — works for pickers in modals that
    // weren't in the DOM at startup (event modal opens lazily).
    document.body.addEventListener("click", (e) => {
      const trigger = e.target.closest("[data-tz-trigger]");
      if (trigger) {
        const picker = trigger.closest("[data-tz-picker]");
        if (picker) { e.preventDefault(); openTzModal(picker); return; }
      }
    });

    // List clicks → pick
    list.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-tz-pick]");
      if (btn) commitPick(btn.dataset.tzPick);
    });

    // Close handlers: X button, backdrop click, Escape key.
    modal.querySelector("[data-tz-close]")?.addEventListener("click", closeTzModal);
    modal.addEventListener("click", (e) => { if (e.target === modal) closeTzModal(); });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !modal.classList.contains("hidden")) closeTzModal();
    });

    // Live filter as the user types
    search.addEventListener("input", () => renderList(search.value));

    // Initial label sync for every picker present at page load.
    document.querySelectorAll("[data-tz-picker]").forEach(syncPickerLabel);

    // Re-sync whenever some other code (event modal opening with an
    // existing event's timezone) writes to the hidden input directly.
    // We can't observe value= changes natively, so expose a helper.
    window.bwcSyncTzPicker = (picker) => syncPickerLabel(picker);
  })();

  // ---------- Sync status chip ----------
  // Hidden by default. Three states:
  //   amber  — offline (with pending count if any)
  //   sky    — online but outbox has items being retried
  //   red    — conflicts: items gave up after 5 retries; user must act
  // Click opens the conflict modal when red.
  (function wireSyncChip() {
    const chip = $("#sync-chip");
    const dot = $("#sync-chip-dot");
    const text = $("#sync-chip-text");
    if (!chip || !dot || !text || !window.bwcStore) return;

    async function refresh() {
      const online = window.bwcStore.isOnline();
      const pending = await window.bwcStore.pendingCount();
      const conflicts = await window.bwcStore.listConflicts();
      const conflictCount = conflicts.length;
      if (online && pending === 0 && conflictCount === 0) {
        chip.classList.add("hidden");
        return;
      }
      chip.classList.remove("hidden");
      // Tailwind utility chunks instead of inline color so Purge picks them up.
      chip.className = chip.className.replace(/bg-(?:amber|sky|emerald|red)-\S+|text-(?:amber|sky|emerald|red)-\S+|hover:bg-\S+/g, "").trim();
      // Conflict state wins over offline/in-progress because it requires
      // user action and offline alone resolves itself when network returns.
      if (conflictCount > 0) {
        chip.classList.add("bg-red-50", "text-red-700", "hover:bg-red-100", "cursor-pointer");
        dot.className = "inline-block h-1.5 w-1.5 rounded-full bg-red-500";
        text.textContent = `⚠ ${conflictCount} 条冲突，点击处理`;
        chip.title = "点击查看同步冲突";
      } else if (!online) {
        chip.classList.add("bg-amber-50", "text-amber-700");
        dot.className = "inline-block h-1.5 w-1.5 rounded-full bg-amber-500";
        text.textContent = pending > 0 ? `离线 · ${pending} 条待同步` : "离线";
        chip.title = "网络不可用";
      } else if (pending > 0) {
        chip.classList.add("bg-sky-50", "text-sky-700");
        dot.className = "inline-block h-1.5 w-1.5 rounded-full bg-sky-500 animate-pulse";
        text.textContent = `同步中 · ${pending}`;
        chip.title = "正在向服务器同步";
      }
    }

    chip.addEventListener("click", async () => {
      const conflicts = await window.bwcStore.listConflicts();
      if (conflicts.length > 0) await openConflictsModal();
    });

    window.bwcStore.onChange((ev) => {
      refresh();
      // sync-conflict events also pop the modal — first-time alert so
      // user notices their edit got stuck instead of waiting until they
      // happen to glance at the chip.
      if (ev.kind === "sync-conflict") {
        if (window.bwc) window.bwc.toast("有同步冲突，点顶部红色徽章处理", "error");
      }
    });
    window.addEventListener("online", refresh);
    window.addEventListener("offline", refresh);
    refresh();
  })();

  // ---------- Conflict modal renderer ----------
  async function openConflictsModal() {
    await renderConflicts();
    openModal("#modal-conflicts");
  }
  async function renderConflicts() {
    const list = $("#conflicts-list");
    const empty = $("#conflicts-empty");
    if (!list || !empty) return;
    const items = await window.bwcStore.listConflicts();
    if (items.length === 0) {
      list.innerHTML = "";
      empty.classList.remove("hidden");
      return;
    }
    empty.classList.add("hidden");
    const opLabel = { create: "新建", update: "修改", delete: "删除" };
    list.innerHTML = items.map((it) => {
      const title = (it.payload && it.payload.summary) || "(无标题)";
      const when = new Date(it.createdAt).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
      const err = it.lastError ? `<div class="mt-1 text-xs text-red-700 break-all">最后错误：${escapeHtml(it.lastError)}</div>` : "";
      return `
        <li class="rounded-lg border border-red-200 bg-red-50/40 p-3" data-outbox-id="${it.id}">
          <div class="flex items-start justify-between gap-3">
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-2 mb-0.5">
                <span class="inline-block rounded-full bg-red-100 text-red-700 text-xs px-2 py-0.5">${opLabel[it.op] || it.op}</span>
                <span class="text-xs text-slate-500">${when}</span>
                <span class="text-xs text-slate-400">· ${it.attempts} 次失败</span>
              </div>
              <div class="text-sm font-medium text-slate-800 break-words">${escapeHtml(title)}</div>
              ${err}
            </div>
            <div class="flex gap-1.5 flex-shrink-0">
              <button type="button" class="rounded-md border border-slate-200 bg-white px-2.5 py-1 text-xs text-slate-700 hover:bg-slate-50" data-conflict-retry="${it.id}">重试</button>
              <button type="button" class="rounded-md border border-red-200 bg-white px-2.5 py-1 text-xs text-red-700 hover:bg-red-50" data-conflict-discard="${it.id}">丢弃</button>
            </div>
          </div>
        </li>`;
    }).join("");
  }
  // Delegated click handler for retry / discard buttons inside the modal.
  document.addEventListener("click", async (e) => {
    const t = e.target;
    if (!(t instanceof Element)) return;
    const retryId = t.getAttribute("data-conflict-retry");
    const discardId = t.getAttribute("data-conflict-discard");
    if (retryId) {
      await window.bwcStore.retryItem(parseInt(retryId, 10));
      await renderConflicts();
      // Force a reload so the optimistic state syncs with whatever the
      // server returned.
      setTimeout(() => loadEvents().catch(() => {}), 1500);
    } else if (discardId) {
      if (!(await window.bwc.confirm({
        message: "丢弃这条变更？本地的优化更新会回滚。",
        danger: true,
        confirmLabel: "丢弃",
      }))) return;
      await window.bwcStore.discardItem(parseInt(discardId, 10));
      await renderConflicts();
      await loadEvents().catch(() => {});
    }
  });
  const retryAllBtn = $("#btn-conflicts-retry-all");
  if (retryAllBtn) {
    retryAllBtn.addEventListener("click", async () => {
      const items = await window.bwcStore.listConflicts();
      for (const it of items) await window.bwcStore.retryItem(it.id);
      await renderConflicts();
      setTimeout(() => loadEvents().catch(() => {}), 1500);
    });
  }
})();
