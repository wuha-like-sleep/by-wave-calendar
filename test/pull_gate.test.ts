import { describe, it, expect, vi } from "vitest";
import "../src/public/event-store.js";

// 推送信号 → 拉取的节流门（src/public/event-store.js 的 makePullGate）。
//
// 这道门要防的是拉取风暴：服务端清扫器聚合后推一条，但对方连环编辑、
// 批量导入时信号仍可能成串到达；页面若一条信号拉一次，增量再便宜也
// 是白白打服务器。反过来也不能把信号吞掉 —— 吞了页面就停在旧数据上，
// 那正是第三批要消灭的事。所以断言盯三件事：间隔内合并、在飞时补拉、
// 拉取失败不卡死门。

type Gate = { signal(): void };
type MakePullGate = (opts: {
  minGapMs: number;
  pull: () => Promise<void>;
  now: () => number;
  schedule: (fn: () => void, ms: number) => unknown;
}) => Gate;

const { makePullGate } = (globalThis as unknown as { bwcPullGate: { makePullGate: MakePullGate } }).bwcPullGate;

/** 手动时钟 + 手动定时器：测试自己决定时间怎么流。 */
function rig(pull: () => Promise<void>, minGapMs = 5_000) {
  let t = 0;
  const timers: Array<{ fn: () => void; at: number }> = [];
  const gate = makePullGate({
    minGapMs,
    pull,
    now: () => t,
    schedule: (fn, ms) => { const h = { fn, at: t + ms }; timers.push(h); return h; },
  });
  return {
    gate,
    setTime(v: number) { t = v; },
    /** 推进时间并触发到点的定时器。 */
    advanceTo(v: number) {
      t = v;
      for (const timer of timers.splice(0)) {
        if (timer.at <= t) timer.fn();
        else timers.push(timer);
      }
    },
    pendingTimers: () => timers.length,
  };
}

/** 让已解决的 promise 链跑完（门的 .finally 回调）。 */
async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

describe("makePullGate", () => {
  it("第一条信号立刻拉；间隔内的后续信号合并成到点的一次", async () => {
    const pull = vi.fn(async () => {});
    const r = rig(pull);
    r.gate.signal();
    expect(pull).toHaveBeenCalledTimes(1);
    await flush();

    r.setTime(1_000);
    r.gate.signal();
    r.gate.signal();
    expect(pull).toHaveBeenCalledTimes(1);
    expect(r.pendingTimers()).toBe(1);

    r.advanceTo(5_000);
    expect(pull).toHaveBeenCalledTimes(2);
    await flush();
  });

  it("正在拉时来的信号只补拉一次，不管来了几条", async () => {
    let release!: () => void;
    const pull = vi.fn(() => new Promise<void>((res) => { release = res; }));
    const r = rig(pull);
    r.gate.signal();
    expect(pull).toHaveBeenCalledTimes(1);

    r.gate.signal();
    r.gate.signal();
    r.gate.signal();
    release();
    // 补拉也要过最小间隔：上一拉是 t=0 发起的，补拉排在 t=5000。
    await flush();
    expect(pull).toHaveBeenCalledTimes(1);
    r.advanceTo(5_000);
    expect(pull).toHaveBeenCalledTimes(2);
    release();
    await flush();
  });

  it("拉取耗时超过间隔时，补拉立刻进行", async () => {
    let release!: () => void;
    const pull = vi.fn(() => new Promise<void>((res) => { release = res; }));
    const r = rig(pull);
    r.gate.signal();
    r.gate.signal();  // 在飞期间记一笔
    r.setTime(9_000); // 这一拉花了 9 秒，早过了 5 秒间隔
    release();
    await flush();
    expect(pull).toHaveBeenCalledTimes(2);
    release();
    await flush();
  });

  it("拉取失败不卡死门：下一条信号照常拉", async () => {
    const pull = vi.fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(undefined);
    const r = rig(pull);
    r.gate.signal();
    await flush();
    r.advanceTo(6_000);
    r.gate.signal();
    expect(pull).toHaveBeenCalledTimes(2);
    await flush();
  });
});
