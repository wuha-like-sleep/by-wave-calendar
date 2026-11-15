/** Keep the three account slots independent: one slow sync must not prevent
 * a newly queued deletion from using another free slot. Database leases still
 * arbitrate ownership across processes. */
export function startSyncWorkers(options: {
  due: (excluded: string[], limit: number) => Promise<string[]>;
  sync: (userId: string) => Promise<void>;
  maintenance: () => Promise<void>;
  subscribe: (wake: () => void) => () => void;
  warn: (error: unknown) => void;
}): () => void {
  const active = new Set<string>(), retryAt = new Map<string, number>();
  let stopped = false, scanning = false, rescan = false, maintenanceAt = 0;
  let wakeTimer: ReturnType<typeof setTimeout> | undefined;
  const wake = () => {
    if (stopped || wakeTimer) return;
    wakeTimer = setTimeout(() => { wakeTimer = undefined; void tick(); }, 250);
    wakeTimer.unref();
  };
  const tick = async () => {
    if (stopped) return;
    if (scanning) { rescan = true; return; }
    scanning = true;
    try {
      const now = Date.now();
      for (const [id, at] of retryAt) if (at <= now) retryAt.delete(id);
      if (now >= maintenanceAt) {
        maintenanceAt = now + 60_000;
        await options.maintenance();
      }
      if (stopped || active.size >= 3) return;
      const due = await options.due([...active, ...retryAt.keys()], 3 - active.size);
      for (const id of due) {
        if (stopped || active.size >= 3) break;
        if (active.has(id) || retryAt.has(id)) continue;
        active.add(id);
        void Promise.resolve().then(() => options.sync(id)).catch(error => {
          // A lease race or unavailable database must not produce a tight loop.
          retryAt.set(id, Date.now() + 5_000);
          options.warn(error);
        }).finally(() => { active.delete(id); wake(); });
      }
    } catch (error) { options.warn(error); }
    finally {
      scanning = false;
      if (rescan) { rescan = false; wake(); }
    }
  };
  const unsubscribe = options.subscribe(wake);
  const timer = setInterval(() => { void tick(); }, 5_000);
  timer.unref();
  void tick();
  return () => { stopped = true; clearInterval(timer); clearTimeout(wakeTimer); unsubscribe(); };
}
