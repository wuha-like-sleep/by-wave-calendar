// IndexedDB-backed offline event store + outbox queue. Lets the
// calendar work entirely from cache when the network is gone, and
// queues create/update/delete operations until we come back online.
//
// Two stores:
//   events  — local mirror of server events keyed by id, with
//             tombstones for deletes (so re-syncing a deleted event
//             doesn't resurrect it)
//   outbox  — pending operations waiting to be POSTed to the server.
//             Each entry: { id (auto), op, eventId, payload, attempts,
//             createdAt }. Operations replay in insert order.
//   meta    — single-row k/v: lastSyncedAt, online state cached, etc.
//
// API exposed on window.bwcStore:
//   getAll({from, to, calendarIds})  → returns merged event list
//   put(event, calendarId)           → optimistic create/update
//   remove(eventId)                  → optimistic delete
//   syncOutbox()                     → flush pending ops
//   onChange(cb)                     → subscribe to store events
//   pendingCount()                   → number of items in outbox
//   isOnline()                       → reflects navigator.onLine + last fetch
//
// Designed to be a drop-in for the existing /api/events fetch pattern.

// ---- 出队决策（纯逻辑）----
// 这一段不碰 IndexedDB、不碰 fetch：存储和网络由下面的 syncOutbox 以 ctx 注进来，
// 所以它在 node 里可以直接被打（test/outbox_drain.test.js）。
//
// 单独拎出来的原因：「哪种失败该重试、哪种该当场出队」是这个文件里最贵的一处判断。
// 之前的写法把「服务端拒绝」和「网络断了」当成同一回事 —— 一条被 400 拒掉的编辑
// 会永远排在队头（攒够 5 次只是置了 giveUp，并不出队），后面排的所有修改再也发不出去；
// 而本地镜像上那份 _dirty 副本不会被服务端数据覆盖，页面上一直显示「已经改好了」。
// 用户换台设备打开才发现这几天白改了。
(function () {
  "use strict";

  // 服务端明确拒绝：同样的 payload 再发一百次也是同一个结果，留在队列里只会挡后面的。
  // 408（请求超时）和 429（限流）例外 —— 它们的意思是「现在不行」，不是「这条不行」。
  function isServerRejection(status) {
    return status >= 400 && status < 500 && status !== 408 && status !== 429;
  }

  // 从服务端响应里抠出一句能直接给用户看的话。
  // /api/events 的 400 是 { error: "invalid_body", message: "<哪个字段不对>" }，
  // Fastify 默认形状是 { statusCode, error, message } —— 都优先取 message，
  // 因为带字段的那句才是用户能照着改的。
  function describeServerError(data, status) {
    let msg = "";
    if (data && typeof data === "object") {
      if (typeof data.message === "string") msg = data.message;
      else if (data.error && typeof data.error.message === "string") msg = data.error.message;
      else if (typeof data.error === "string") msg = data.error;
    } else if (typeof data === "string") {
      msg = data;
    }
    msg = msg.trim();
    // 空的、或者网关塞回来的一整页 HTML：弹给用户没有任何意义，退成状态码。
    if (!msg || msg.charAt(0) === "<") return "HTTP " + status;
    return msg.length > 200 ? msg.slice(0, 200) + "…" : msg;
  }

  // 推进队列。ctx 里全是副作用，由调用方提供：
  //   send(item)          → 发这一条，返回 { ok, status, data }；网络层面失败则 throw
  //   applied(item, res)  → 服务端接受了，把本地镜像对齐
  //   remove(item)        → 把这一条从队列里删掉
  //   fail(item, err)     → 记一次可重试的失败（attempts + 1，够 5 次置 giveUp）
  //   reject(item, info)  → 服务端拒绝：回滚本地那份乐观副本 + 把原因交给界面
  // 返回 { sent, rejected, skipped, blocked }，调用方拿来记日志/判断要不要再来一轮。
  async function drainOutbox(items, ctx) {
    const stats = { sent: 0, rejected: 0, skipped: 0, blocked: false };
    for (const item of items) {
      // 已经放弃的条目留在队列里等用户在冲突面板里处理，但**不许挡住后面的**。
      if (item.giveUp) { stats.skipped += 1; continue; }
      let res;
      try {
        res = await ctx.send(item);
      } catch (e) {
        // 断网 / 超时 / 被 abort：这一条还有救，保序，等下一轮。
        await ctx.fail(item, e);
        stats.blocked = true;
        break;
      }
      // 删除那条：404 表示服务端那边本来就没了，和删成功是一个意思。
      const accepted = !!res && (res.ok === true || (item.op === "delete" && res.status === 404));
      if (accepted) {
        await ctx.applied(item, res);
        await ctx.remove(item);
        stats.sent += 1;
        continue;
      }
      const status = res && typeof res.status === "number" ? res.status : 0;
      if (isServerRejection(status)) {
        await ctx.reject(item, { status: status, reason: describeServerError(res ? res.data : null, status) });
        await ctx.remove(item);
        stats.rejected += 1;
        continue;  // 一条坏数据不许堵住后面排队的全部编辑
      }
      // 5xx 和 408/429：服务端这会儿不行，保序等下一轮。
      await ctx.fail(item, new Error(item.op + "_failed " + status));
      stats.blocked = true;
      break;
    }
    return stats;
  }

  globalThis.bwcOutboxCore = { isServerRejection, describeServerError, drainOutbox };
})();

(function () {
  "use strict";
  // 没有 window 就只是被 import 进来取上面那组纯函数（测试），不启动存储层。
  if (typeof window === "undefined") return;
  if (window.bwcStore) return;  // already loaded

  const core = globalThis.bwcOutboxCore;

  const DB_NAME = "bywave-events";
  const DB_VERSION = 1;
  const STORE_EVENTS = "events";
  const STORE_OUTBOX = "outbox";
  const STORE_META = "meta";

  let dbPromise = null;
  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_EVENTS)) {
          const es = db.createObjectStore(STORE_EVENTS, { keyPath: "id" });
          es.createIndex("calendarId", "calendarId", { unique: false });
          es.createIndex("startsAt", "startsAt", { unique: false });
        }
        if (!db.objectStoreNames.contains(STORE_OUTBOX)) {
          db.createObjectStore(STORE_OUTBOX, { keyPath: "id", autoIncrement: true });
        }
        if (!db.objectStoreNames.contains(STORE_META)) {
          db.createObjectStore(STORE_META, { keyPath: "key" });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  function tx(storeName, mode, fn) {
    return openDB().then((db) => new Promise((resolve, reject) => {
      const t = db.transaction(storeName, mode);
      const s = t.objectStore(storeName);
      let result;
      Promise.resolve(fn(s, t)).then((r) => { result = r; }).catch(reject);
      t.oncomplete = () => resolve(result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    }));
  }

  // ---- subscribers ----
  const listeners = new Set();
  function emit(kind, payload) {
    for (const cb of listeners) {
      try { cb({ kind, payload }); } catch (e) { console.warn("[bwcStore listener]", e); }
    }
  }

  // ---- network probe ----
  let serverReachable = navigator.onLine;
  function setReachable(v) {
    if (serverReachable !== v) {
      serverReachable = v;
      emit("connectivity", { online: v });
    }
  }
  window.addEventListener("online", () => { setReachable(true); syncOutbox(); });
  window.addEventListener("offline", () => setReachable(false));

  // ---- HTTP helper ----
  // Wraps fetch with: 6s timeout (don't hang the UI forever),
  // CSRF token header injection on writes, automatic JSON parsing,
  // and treats network errors as "offline" so we can flip the flag.
  async function http(method, url, body) {
    const csrf = (document.querySelector('meta[name="csrf-token"]') || {}).content || "";
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    try {
      const resp = await fetch(url, {
        method,
        credentials: "same-origin",
        headers: body ? { "Content-Type": "application/json", "X-CSRF-Token": csrf } : { "X-CSRF-Token": csrf },
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
      setReachable(true);
      const text = await resp.text();
      let data = null;
      if (text) { try { data = JSON.parse(text); } catch { data = text; } }
      return { ok: resp.ok, status: resp.status, data };
    } catch (e) {
      // Network error / timeout / aborted — treat as offline.
      setReachable(false);
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  // ---- public API ----

  // IndexedDB-only read. No network, no merge. Returns whatever
  // overlaps the window from the local mirror. Used by callers that
  // want stale-while-revalidate behavior — read this first to paint
  // instantly, then call getAll() to refresh from server in the
  // background. Added v1.3.9 to make prev/next/today navigation
  // feel instant instead of waiting on the network round-trip.
  async function getCached({ from, to, calendarIds }) {
    const fromMs = +new Date(from);
    const toMs = +new Date(to);
    const local = await readLocalRange(fromMs, toMs);
    const filtered = calendarIds
      ? local.filter((e) => calendarIds.split(",").includes(e.calendarId))
      : local;
    return { events: filtered, calendars: null, offline: !serverReachable };
  }

  // Pull events for a date range from server + merge into local mirror.
  // On network failure, return whatever's in the local mirror that
  // overlaps the window. Caller doesn't need to know whether it came
  // from network or cache.
  async function getAll({ from, to, calendarIds }) {
    const fromMs = +new Date(from);
    const toMs = +new Date(to);
    let serverData = null;
    try {
      const url = `/api/events?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}${calendarIds ? "&calendarIds=" + encodeURIComponent(calendarIds) : ""}`;
      const r = await http("GET", url);
      if (r.ok) {
        serverData = r.data;
        await mergeIntoLocal(serverData.events || []);
        await setMeta("lastSyncedAt", new Date().toISOString());
      }
    } catch { /* offline */ }

    // Even when online, return from local mirror so optimistic outbox
    // edits appear in the UI immediately.
    const local = await readLocalRange(fromMs, toMs);
    const filtered = calendarIds
      ? local.filter((e) => calendarIds.split(",").includes(e.calendarId))
      : local;

    return {
      events: filtered,
      calendars: serverData ? serverData.calendars : null,
      offline: !serverReachable,
    };
  }

  // Merge server events into local mirror. Deletes tombstones for
  // events that fell out of the server's response — only within the
  // requested window though, otherwise we'd nuke events outside.
  async function mergeIntoLocal(events) {
    await tx(STORE_EVENTS, "readwrite", (s) => {
      for (const e of events) {
        // Optimistic local copies have a _dirty flag — don't clobber
        // them on merge, the next sync will reconcile.
        const req = s.get(e.id);
        req.onsuccess = () => {
          const existing = req.result;
          if (existing && existing._dirty) return;
          s.put({ ...e, _syncedAt: Date.now() });
        };
      }
    });
  }

  async function readLocalRange(fromMs, toMs) {
    return tx(STORE_EVENTS, "readonly", (s) => new Promise((resolve) => {
      const out = [];
      const req = s.openCursor();
      req.onsuccess = () => {
        const c = req.result;
        if (!c) return resolve(out);
        const e = c.value;
        if (e._tombstone) { c.continue(); return; }
        const start = +new Date(e.startsAt);
        const end = +new Date(e.endsAt);
        // Overlap test: [start, end] ∩ [fromMs, toMs] is non-empty.
        if (end >= fromMs && start <= toMs) out.push(stripInternal(e));
        c.continue();
      };
    }));
  }

  function stripInternal(e) {
    const { _dirty, _tombstone, _syncedAt, ...rest } = e;
    return rest;
  }

  // ---- writes (optimistic) ----

  async function put(event, calendarId) {
    // Optimistic: write to local mirror immediately with _dirty flag,
    // queue the server operation in outbox.
    const isCreate = !event.id;
    const tempId = isCreate ? "local-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8) : event.id;
    const localCopy = { ...event, id: tempId, calendarId: calendarId || event.calendarId, _dirty: true };

    await tx(STORE_EVENTS, "readwrite", (s) => s.put(localCopy));
    const payload = { ...event, calendarId: calendarId || event.calendarId };
    // Idempotency key for creates. The outbox replays at-least-once: if a
    // create POST commits on the server but its response is lost, the item
    // stays queued and is retried — previously minting a DUPLICATE event
    // each time. We send the stable tempId as `clientUid`; it's persisted
    // in the outbox payload, so every replay carries the same key and the
    // server collapses retries onto the first row. (Updates are already
    // idempotent by event id, so they don't need this.)
    if (isCreate) payload.clientUid = tempId;
    await enqueue({
      op: isCreate ? "create" : "update",
      eventId: tempId,
      payload,
    });
    emit("event-changed", { id: tempId, kind: isCreate ? "created" : "updated" });
    syncOutbox();  // best-effort immediate
    return localCopy;
  }

  async function remove(eventId) {
    // Optimistic: tombstone the local copy, queue delete.
    await tx(STORE_EVENTS, "readwrite", (s) => new Promise((resolve) => {
      const r = s.get(eventId);
      r.onsuccess = () => {
        if (r.result) s.put({ ...r.result, _tombstone: true, _dirty: true });
        resolve();
      };
    }));
    await enqueue({ op: "delete", eventId, payload: null });
    emit("event-changed", { id: eventId, kind: "deleted" });
    syncOutbox();
  }

  // ---- outbox ----

  async function enqueue(item) {
    await tx(STORE_OUTBOX, "readwrite", (s) => s.add({
      ...item,
      attempts: 0,
      createdAt: Date.now(),
    }));
    emit("outbox-changed", { count: await pendingCount() });
  }

  async function pendingCount() {
    return tx(STORE_OUTBOX, "readonly", (s) => new Promise((resolve) => {
      const r = s.count();
      r.onsuccess = () => resolve(r.result);
    }));
  }

  // List ALL items in the outbox. Used by the conflict UI to render a
  // table of stuck operations. Each item carries .attempts and
  // .lastError so the UI can explain why it's stuck.
  async function listOutbox() {
    return tx(STORE_OUTBOX, "readonly", (s) => new Promise((resolve) => {
      const r = s.getAll();
      r.onsuccess = () => resolve(r.result || []);
    }));
  }

  // Just the items that already gave up (5 failures in a row). The
  // conflict modal renders these as a "needs your attention" list.
  async function listConflicts() {
    const items = await listOutbox();
    return items.filter((i) => i.giveUp);
  }

  // Retry a single stuck outbox item — reset attempts + giveUp so the
  // next syncOutbox() picks it up again. Used by the conflict modal's
  // "重试" button.
  async function retryItem(outboxId) {
    await tx(STORE_OUTBOX, "readwrite", (s) => new Promise((resolve) => {
      const r = s.get(outboxId);
      r.onsuccess = () => {
        const it = r.result;
        if (!it) return resolve();
        delete it.giveUp;
        it.attempts = 0;
        it.lastError = null;
        s.put(it);
        resolve();
      };
    }));
    emit("outbox-changed", { count: await pendingCount() });
    syncOutbox();
  }

  // 回滚一条没能发出去的操作在本地镜像上留下的痕迹，按 op 分三种：
  //   - "create": 删掉 local-id 那行（服务端上从来没有过它）
  //   - "update": 保留这行，但清掉 _dirty —— 关键就在这儿：mergeIntoLocal 见到
  //               _dirty 是不覆盖的，不清掉的话页面会一直显示那份没存上的改动
  //   - "delete": 去掉 tombstone（本地撤销删除；服务端那份还在，无害）
  // 用户手动丢弃（discardItem）和服务端拒绝（syncOutbox 的 reject 路径）共用这一份。
  async function rollbackLocal(item) {
    if (item.op === "create" && String(item.eventId).startsWith("local-")) {
      await tx(STORE_EVENTS, "readwrite", (s) => s.delete(item.eventId));
      return;
    }
    await tx(STORE_EVENTS, "readwrite", (s) => new Promise((resolve) => {
      const r = s.get(item.eventId);
      r.onsuccess = () => {
        if (r.result) {
          if (item.op === "delete") delete r.result._tombstone;
          delete r.result._dirty;
          s.put(r.result);
        }
        resolve();
      };
    }));
  }

  // Discard a stuck outbox item. Also rolls back the local mirror so
  // the user doesn't keep seeing the ghost optimistic edit.
  async function discardItem(outboxId) {
    const item = await tx(STORE_OUTBOX, "readonly", (s) => new Promise((resolve) => {
      const r = s.get(outboxId);
      r.onsuccess = () => resolve(r.result);
    }));
    if (!item) return;
    await tx(STORE_OUTBOX, "readwrite", (s) => s.delete(outboxId));
    await rollbackLocal(item);
    emit("event-changed", { id: item.eventId, kind: "discarded" });
    emit("outbox-changed", { count: await pendingCount() });
  }

  let syncing = false;
  async function syncOutbox() {
    if (syncing || !navigator.onLine) return;
    syncing = true;
    try {
      const items = await listOutbox();
      await core.drainOutbox(items, {
        send: sendOne,
        applied: applyAccepted,
        remove: (item) => tx(STORE_OUTBOX, "readwrite", (s) => s.delete(item.id)),
        fail: bumpAttempts,
        reject: rejectOne,
      });
    } finally {
      syncing = false;
      emit("outbox-changed", { count: await pendingCount() });
    }
  }

  // 把一条队列项发出去。只负责发，不判断成败：返回 { ok, status, data }，
  // 网络层面的失败照旧 throw（http() 已经把超时/断网折进去了），由 drainOutbox 定夺。
  async function sendOne(item) {
    if (item.op === "create") {
      return http("POST", "/api/events", item.payload);
    }
    if (item.op === "update") {
      // 本地 id 还是 "local-"：create 那条还在队列里排着，它会带上最新的 payload。
      if (String(item.eventId).startsWith("local-")) return { ok: true, status: 0, data: null, skipped: true };
      return http("PATCH", "/api/events/" + encodeURIComponent(item.eventId), item.payload);
    }
    if (item.op === "delete") {
      // 从来没发到服务端过，本地丢掉就完了。
      if (String(item.eventId).startsWith("local-")) return { ok: true, status: 0, data: null, skipped: true };
      return http("DELETE", "/api/events/" + encodeURIComponent(item.eventId));
    }
    // 认不出的 op（旧版本留下的队列）：当作已处理，别把整条队列堵死。
    return { ok: true, status: 0, data: null, skipped: true };
  }

  // 服务端接受之后把本地镜像对齐。
  async function applyAccepted(item, res) {
    if (item.op === "create" && !res.skipped) {
      // 服务端给了真正的 id，把本地那份 local- 的换掉。
      await tx(STORE_EVENTS, "readwrite", (s) => new Promise((resolve) => {
        const g = s.get(item.eventId);
        g.onsuccess = () => {
          if (g.result) s.delete(item.eventId);
          s.put({ ...res.data, _syncedAt: Date.now() });
          resolve();
        };
      }));
      return;
    }
    if (item.op === "update" && !res.skipped) {
      await tx(STORE_EVENTS, "readwrite", (s) => s.put({ ...res.data, _syncedAt: Date.now() }));
      return;
    }
    if (item.op === "delete") {
      await tx(STORE_EVENTS, "readwrite", (s) => s.delete(item.eventId));
    }
  }

  // 可重试的失败：记一次，攒够 5 次就放弃并在冲突面板里请用户处理。
  // 放弃的条目从此不再挡后面的（见 drainOutbox 里的 giveUp 分支）。
  async function bumpAttempts(item, err) {
    await tx(STORE_OUTBOX, "readwrite", (s) => new Promise((resolve) => {
      const r = s.get(item.id);
      r.onsuccess = () => {
        const cur = r.result;
        if (!cur) return resolve();
        cur.attempts = (cur.attempts || 0) + 1;
        cur.lastError = err && err.message ? err.message : String(err);
        if (cur.attempts >= 5) {
          cur.giveUp = true;
          emit("sync-conflict", { item: cur });
        }
        s.put(cur);
        resolve();
      };
    }));
  }

  // 服务端拒了这一条（4xx，408/429 除外）。重放没有意义，所以它会被出队；
  // 本地那份乐观副本同时回滚 —— 不回滚的话 mergeIntoLocal 因为 _dirty 不敢覆盖，
  // 页面会一直显示这条其实没存上的改动。原因原样往上报，由界面弹给用户。
  async function rejectOne(item, info) {
    await rollbackLocal(item);
    emit("sync-rejected", { item: item, status: info.status, reason: info.reason });
    emit("event-changed", { id: item.eventId, kind: "rejected" });
  }

  // ---- meta ----
  async function setMeta(key, value) {
    await tx(STORE_META, "readwrite", (s) => s.put({ key, value }));
  }
  async function getMeta(key) {
    return tx(STORE_META, "readonly", (s) => new Promise((resolve) => {
      const r = s.get(key);
      r.onsuccess = () => resolve(r.result ? r.result.value : null);
    }));
  }

  function onChange(cb) {
    listeners.add(cb);
    return () => listeners.delete(cb);
  }

  window.bwcStore = {
    getAll, getCached, put, remove,
    syncOutbox, pendingCount, listOutbox, listConflicts,
    retryItem, discardItem,
    isOnline: () => serverReachable,
    onChange,
    getMeta, setMeta,
    // Debug hook — clear everything (used by /reset-pwa).
    _wipe: async () => {
      const db = await openDB();
      await new Promise((resolve) => {
        const t = db.transaction([STORE_EVENTS, STORE_OUTBOX, STORE_META], "readwrite");
        t.objectStore(STORE_EVENTS).clear();
        t.objectStore(STORE_OUTBOX).clear();
        t.objectStore(STORE_META).clear();
        t.oncomplete = resolve;
      });
    },
  };

  // Auto-sync on page load if we have anything pending.
  window.addEventListener("load", () => {
    setTimeout(() => syncOutbox(), 1000);
  });
  // And periodically try while online — covers the "tab open but
  // backgrounded during outage" case.
  setInterval(() => { if (serverReachable) syncOutbox(); }, 60_000);
})();
