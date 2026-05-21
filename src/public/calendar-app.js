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
      hourStart: 7,
      hourEnd: 23,
      startDayOfWeek: 1,
      dayNames: ["周日", "周一", "周二", "周三", "周四", "周五", "周六"],
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
    } else {
      loadEvents().catch(() => {});
      startPolling();
    }
  });
  startPolling();

  // ---------- Toolbar ----------
  $("#btn-today").addEventListener("click", () => { cal.today(); refresh(); });
  $("#btn-prev").addEventListener("click", () => { cal.prev(); refresh(); });
  $("#btn-next").addEventListener("click", () => { cal.next(); refresh(); });
  $$(".view-btn").forEach((b) => b.addEventListener("click", () => {
    currentView = b.dataset.view;
    cal.changeView(currentView);
    $$(".view-btn").forEach((x) => x.classList.remove("bg-brand-50", "text-brand-700", "font-semibold"));
    b.classList.add("bg-brand-50", "text-brand-700", "font-semibold");
    refresh();
  }));
  $('.view-btn[data-view="week"]').classList.add("bg-brand-50", "text-brand-700", "font-semibold");

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
    form.querySelector('[name="attendees"]').value = (payload.attendees || []).join(", ");
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
      startsAt: fresh.startsAt,
      endsAt: fresh.endsAt,
      allDay: fresh.allDay,
      category: extra.category,
      timezone: extra.timezone,
      attendees: Array.isArray(extra.attendees) ? extra.attendees : [],
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
      extra: {
        category: data.category || undefined,
        timezone: data.timezone || undefined,
        attendees: attendees.length ? attendees : undefined,
      },
    };
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
      resp = await fetch(`/api/events/${id}`, fetchOpts({ method: "DELETE" }));
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
