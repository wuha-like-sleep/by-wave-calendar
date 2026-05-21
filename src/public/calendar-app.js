// by-wave-calendar single-page calendar app
// Uses Toast UI Calendar v2.x for the grid, plus vanilla JS for modals + fetch.
(function () {
  "use strict";

  const ctx = window.__bwc || { calendars: [], publicBaseUrl: "", csrfToken: "" };

  const headers = () => ({ "Content-Type": "application/json", "X-CSRF-Token": ctx.csrfToken });
  const fetchOpts = (extra = {}) => Object.assign({ credentials: "same-origin", headers: headers() }, extra);

  // ---------- DOM helpers ----------
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  function openModal(id) { $(id).classList.remove("hidden"); $(id).classList.add("flex"); }
  function closeModal(id) { $(id).classList.add("hidden"); $(id).classList.remove("flex"); }
  $$(".modal-close").forEach((b) => b.addEventListener("click", (e) => {
    const m = e.target.closest("[id^=modal-]");
    if (m) closeModal("#" + m.id);
  }));
  ["#modal-event", "#modal-calendar", "#modal-cal-menu"].forEach((id) => {
    const m = $(id);
    if (m) m.addEventListener("click", (e) => { if (e.target === m) closeModal(id); });
  });

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

  // ---------- Date label + range fetch ----------
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
        .map((e) => ({
          id: e.id,
          calendarId: e.calendarId,
          title: e.summary,
          location: e.location || undefined,
          body: e.description || undefined,
          start: e.startsAt,
          end: e.endsAt,
          isAllday: !!e.allDay,
          category: e.allDay ? "allday" : "time",
        }));
      cal.createEvents(events);
    } catch (err) {
      console.error(err);
      window.bwc && window.bwc.toast("加载事件失败", "error");
    }
  }

  function refresh() { formatPeriodLabel(); loadEvents(); }

  // ---------- Toolbar bindings ----------
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

  // ---------- Sidebar: toggle calendars ----------
  $$(".cal-toggle").forEach((cb) => cb.addEventListener("change", () => {
    const id = cb.dataset.calId;
    if (cb.checked) visibleCalIds.add(id); else visibleCalIds.delete(id);
    loadEvents();
  }));

  $("#btn-toggle-sidebar").addEventListener("click", () => {
    const sb = $("#cal-sidebar");
    sb.classList.toggle("hidden");
    sb.classList.toggle("flex");
    sb.classList.toggle("absolute"); sb.classList.toggle("z-30");
    sb.classList.toggle("inset-y-0"); sb.classList.toggle("left-0");
  });

  // ---------- Event create / edit ----------
  function toLocalInputValue(d) {
    const pad = (n) => String(n).padStart(2, "0");
    const t = new Date(d);
    return `${t.getFullYear()}-${pad(t.getMonth()+1)}-${pad(t.getDate())}T${pad(t.getHours())}:${pad(t.getMinutes())}`;
  }

  function openEventModal(payload) {
    const form = $("#form-event");
    form.reset();
    form.querySelector('[name="id"]').value = payload.id || "";
    if (payload.calendarId) form.querySelector('[name="calendarId"]').value = payload.calendarId;
    if (payload.summary) form.querySelector('[name="summary"]').value = payload.summary;
    if (payload.location) form.querySelector('[name="location"]').value = payload.location;
    if (payload.description) form.querySelector('[name="description"]').value = payload.description;
    form.querySelector('[name="startsAt"]').value = toLocalInputValue(payload.startsAt || new Date());
    form.querySelector('[name="endsAt"]').value = toLocalInputValue(payload.endsAt || new Date(Date.now() + 3600_000));
    $("#modal-event-title").textContent = payload.id ? "编辑事件" : "新建事件";
    $("#btn-delete-event").classList.toggle("hidden", !payload.id);
    openModal("#modal-event");
  }

  $("#btn-new-event").addEventListener("click", () => openEventModal({ startsAt: new Date(), endsAt: new Date(Date.now() + 3600_000) }));
  $("#btn-new-event-mobile")?.addEventListener("click", () => openEventModal({ startsAt: new Date(), endsAt: new Date(Date.now() + 3600_000) }));

  cal.on("selectDateTime", (info) => {
    openEventModal({ startsAt: info.start, endsAt: info.end });
    cal.clearGridSelections();
  });

  cal.on("clickEvent", async (info) => {
    const id = info.event.id;
    // Fetch fresh event data
    const calId = info.event.calendarId;
    const evs = await fetch(`/api/calendars/${calId}/events`, fetchOpts()).then(r => r.json()).catch(() => []);
    const fresh = evs.find((e) => e.id === id);
    if (!fresh) return;
    openEventModal({
      id: fresh.id,
      calendarId: fresh.calendarId,
      summary: fresh.summary,
      location: fresh.location,
      description: fresh.description,
      startsAt: fresh.startsAt,
      endsAt: fresh.endsAt,
    });
  });

  $("#form-event").addEventListener("submit", async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.target).entries());
    const id = data.id;
    delete data.id;
    const body = {
      calendarId: data.calendarId,
      summary: data.summary,
      location: data.location || undefined,
      description: data.description || undefined,
      startsAt: new Date(data.startsAt).toISOString(),
      endsAt: new Date(data.endsAt).toISOString(),
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
    try {
      const resp = await fetch(`/api/events/${id}`, fetchOpts({ method: "DELETE" }));
      if (!resp.ok) throw new Error("delete_failed");
      closeModal("#modal-event");
      await loadEvents();
      window.bwc && window.bwc.toast("事件已删除", "success");
    } catch (err) {
      console.error(err);
      window.bwc && window.bwc.toast("删除失败", "error");
    }
  });

  // ---------- Calendar create ----------
  $("#btn-new-calendar").addEventListener("click", () => {
    $("#form-calendar").reset();
    $("#form-calendar [name=\"color\"]").value = "#6366f1";
    openModal("#modal-calendar");
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

  // ---------- Calendar context menu (share tokens, delete) ----------
  let currentMenuCalId = null;
  $$("[data-cal-menu]").forEach((btn) => btn.addEventListener("click", async (e) => {
    e.preventDefault(); e.stopPropagation();
    const id = btn.dataset.calMenu;
    const cal = ctx.calendars.find((c) => c.id === id);
    if (!cal) return;
    currentMenuCalId = id;
    $("#cal-menu-color").style.background = cal.color;
    $("#cal-menu-name").textContent = cal.name;
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
      list.innerHTML = tokens.map((t) => `
        <li class="flex items-center gap-2 py-2 border-b border-slate-100 last:border-0">
          <div class="flex-1 min-w-0">
            <div class="text-slate-700">${escapeHtml(t.label || "未命名")}</div>
            <code class="text-xs text-slate-400 truncate block">${escapeHtml(t.url)}</code>
          </div>
          <button type="button" class="rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs text-slate-700 hover:bg-slate-50" data-copy="${escapeHtml(t.url)}">复制</button>
          <button type="button" class="rounded-lg border border-red-200 bg-white px-2.5 py-1 text-xs text-red-700 hover:bg-red-50" data-revoke="${escapeHtml(t.token)}">撤销</button>
        </li>
      `).join("");
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

  // ---------- Drag to update ----------
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

  // ---------- Utils ----------
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // ---------- Boot ----------
  refresh();
})();
