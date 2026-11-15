import { afterEach, describe, expect, it, vi } from "vitest";
import { startSyncWorkers } from "../src/lib/calendar_sync/scheduler.js";

const stops: (() => void)[] = [];
afterEach(() => { for (const stop of stops.splice(0)) stop(); vi.useRealTimers(); });
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function fixture(initial: string[]) {
  vi.useFakeTimers();
  const queued = new Set(initial), gates = new Map(initial.map(id => [id, deferred()]));
  let wake = () => {};
  const due = vi.fn(async (excluded: string[], limit: number) => [...queued].filter(id => !excluded.includes(id)).slice(0, limit));
  const sync = vi.fn(async (id: string) => { await gates.get(id)?.promise; queued.delete(id); });
  const warn = vi.fn(), unsubscribe = vi.fn();
  const stop = startSyncWorkers({ due, sync, maintenance: async () => {}, subscribe: fn => { wake = fn; return unsubscribe; }, warn });
  stops.push(stop);
  return { queued, gates, due, sync, warn, wake: () => wake(), stop, unsubscribe };
}
describe("calendar synchronization scheduling", () => {
  it("starts a newly requested deletion while another account remains slow", async () => {
    const f = fixture(["slow"]);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.sync).toHaveBeenCalledWith("slow");
    f.queued.add("delete-now"); f.wake();
    await vi.advanceTimersByTimeAsync(250);
    expect(f.sync).toHaveBeenCalledWith("delete-now");
    expect(f.queued.has("slow")).toBe(true);
    expect(f.sync.mock.calls.filter(([id]) => id === "slow")).toHaveLength(1);
    f.gates.get("slow")!.resolve(); await vi.advanceTimersByTimeAsync(0);
  });
  it("keeps three independent slots and immediately refills a completed slot", async () => {
    const f = fixture(["a", "b", "c", "d"]);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.sync.mock.calls.map(([id]) => id)).toEqual(["a", "b", "c"]);
    f.wake(); await vi.advanceTimersByTimeAsync(250);
    expect(f.sync).toHaveBeenCalledTimes(3);
    f.gates.get("b")!.resolve(); await vi.advanceTimersByTimeAsync(250);
    expect(f.sync.mock.calls.map(([id]) => id)).toEqual(["a", "b", "c", "d"]);
    for (const gate of f.gates.values()) gate.resolve(); await vi.advanceTimersByTimeAsync(0);
  });
  it("does not spin on lease races or let them block unrelated accounts", async () => {
    const f = fixture([]);
    await vi.advanceTimersByTimeAsync(0);
    f.sync.mockImplementation(async id => { if (id === "leased") throw new Error("lease busy"); f.queued.delete(id); });
    f.queued.add("leased"); f.wake(); await vi.advanceTimersByTimeAsync(500);
    expect(f.sync).toHaveBeenCalledTimes(1);
    f.queued.add("ready"); f.wake(); await vi.advanceTimersByTimeAsync(500);
    expect(f.sync.mock.calls.map(([id]) => id)).toEqual(["leased", "ready"]);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(f.sync).toHaveBeenCalledTimes(2);
    expect(f.warn).toHaveBeenCalledTimes(1);
  });
  it("stops launching work after shutdown even when an active sync finishes", async () => {
    const f = fixture(["a"]);
    await vi.advanceTimersByTimeAsync(0);
    f.stop(); f.queued.add("b"); f.gates.get("a")!.resolve(); f.wake();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.sync).toHaveBeenCalledTimes(1); expect(f.unsubscribe).toHaveBeenCalled();
  });
  it("does not lose a deletion requested while the due-account query is still pending", async () => {
    vi.useFakeTimers();
    const scan = deferred();
    let queued = false, first = true, wake = () => {};
    const due = vi.fn(async () => {
      const result = queued ? ["delete-during-scan"] : [];
      if (first) { first = false; await scan.promise; }
      return result;
    });
    const sync = vi.fn(async () => { queued = false; });
    stops.push(startSyncWorkers({ due, sync, maintenance: async () => {},
      subscribe: callback => { wake = callback; return () => {}; }, warn: vi.fn() }));
    await vi.advanceTimersByTimeAsync(0);
    queued = true; wake();
    await vi.advanceTimersByTimeAsync(250);
    expect(sync).not.toHaveBeenCalled();
    scan.resolve();
    await vi.advanceTimersByTimeAsync(250);
    expect(sync).toHaveBeenCalledExactlyOnceWith("delete-during-scan");
  });
});
