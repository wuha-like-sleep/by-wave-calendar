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

(function () {
  "use strict";
  if (window.bwcStore) return;  // already loaded

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
    await enqueue({
      op: isCreate ? "create" : "update",
      eventId: tempId,
      payload: { ...event, calendarId: calendarId || event.calendarId },
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

  // Discard a stuck outbox item. Also rolls back the local mirror so
  // the user doesn't keep seeing the ghost optimistic edit:
  //   - "create": delete the local-id row (it never existed on server)
  //   - "update": leave the row, but a subsequent loadEvents() will
  //               clobber the dirty copy with the server's version
  //   - "delete": un-tombstone the row (un-deletes locally; server still
  //               has it so this is harmless)
  async function discardItem(outboxId) {
    const item = await tx(STORE_OUTBOX, "readonly", (s) => new Promise((resolve) => {
      const r = s.get(outboxId);
      r.onsuccess = () => resolve(r.result);
    }));
    if (!item) return;
    await tx(STORE_OUTBOX, "readwrite", (s) => s.delete(outboxId));
    if (item.op === "create" && String(item.eventId).startsWith("local-")) {
      await tx(STORE_EVENTS, "readwrite", (s) => s.delete(item.eventId));
    } else if (item.op === "delete") {
      await tx(STORE_EVENTS, "readwrite", (s) => new Promise((resolve) => {
        const r = s.get(item.eventId);
        r.onsuccess = () => {
          if (r.result) { delete r.result._tombstone; delete r.result._dirty; s.put(r.result); }
          resolve();
        };
      }));
    } else {
      // Update: leave the local copy; next sync will re-fetch from server.
      await tx(STORE_EVENTS, "readwrite", (s) => new Promise((resolve) => {
        const r = s.get(item.eventId);
        r.onsuccess = () => {
          if (r.result) { delete r.result._dirty; s.put(r.result); }
          resolve();
        };
      }));
    }
    emit("event-changed", { id: item.eventId, kind: "discarded" });
    emit("outbox-changed", { count: await pendingCount() });
  }

  let syncing = false;
  async function syncOutbox() {
    if (syncing || !navigator.onLine) return;
    syncing = true;
    try {
      const items = await tx(STORE_OUTBOX, "readonly", (s) => new Promise((resolve) => {
        const r = s.getAll();
        r.onsuccess = () => resolve(r.result || []);
      }));
      for (const item of items) {
        try {
          await replayOne(item);
          await tx(STORE_OUTBOX, "readwrite", (s) => s.delete(item.id));
        } catch (e) {
          // Bump attempts; give up after 5 failures and surface the conflict.
          await tx(STORE_OUTBOX, "readwrite", (s) => new Promise((resolve) => {
            const r = s.get(item.id);
            r.onsuccess = () => {
              const cur = r.result;
              if (!cur) return resolve();
              cur.attempts = (cur.attempts || 0) + 1;
              cur.lastError = e && e.message ? e.message : String(e);
              if (cur.attempts >= 5) {
                cur.giveUp = true;
                emit("sync-conflict", { item: cur });
              }
              s.put(cur);
              resolve();
            };
          }));
          break;  // stop the chain on first failure to preserve order
        }
      }
    } finally {
      syncing = false;
      emit("outbox-changed", { count: await pendingCount() });
    }
  }

  async function replayOne(item) {
    if (item.giveUp) throw new Error("given up earlier");
    if (item.op === "create") {
      const r = await http("POST", "/api/events", item.payload);
      if (!r.ok) throw new Error("create_failed " + r.status);
      // Server assigned a real id; update local copy.
      await tx(STORE_EVENTS, "readwrite", (s) => new Promise((resolve) => {
        const g = s.get(item.eventId);
        g.onsuccess = () => {
          if (g.result) s.delete(item.eventId);
          s.put({ ...r.data, _syncedAt: Date.now() });
          resolve();
        };
      }));
    } else if (item.op === "update") {
      // If the local id starts with "local-" it means the create
      // hasn't synced yet — skip this update; create will pick up
      // the latest payload.
      if (String(item.eventId).startsWith("local-")) return;
      const r = await http("PATCH", "/api/events/" + encodeURIComponent(item.eventId), item.payload);
      if (!r.ok) throw new Error("update_failed " + r.status);
      await tx(STORE_EVENTS, "readwrite", (s) => s.put({ ...r.data, _syncedAt: Date.now() }));
    } else if (item.op === "delete") {
      if (String(item.eventId).startsWith("local-")) {
        // Never sent to server; just drop the local tombstone.
        await tx(STORE_EVENTS, "readwrite", (s) => s.delete(item.eventId));
        return;
      }
      const r = await http("DELETE", "/api/events/" + encodeURIComponent(item.eventId));
      // 204 OR 404 (already gone) both count as success.
      if (!r.ok && r.status !== 404) throw new Error("delete_failed " + r.status);
      await tx(STORE_EVENTS, "readwrite", (s) => s.delete(item.eventId));
    }
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
