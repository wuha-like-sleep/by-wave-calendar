// expandEvent 的进程内记忆化：键 = 展开的全部输入 + updatedAt + 窗口。
//
// 红线只有一条：**绝不能给旧结果**。所以这组测试盯的是失效，不是命中率 ——
// updatedAt 变、exdates 变、规则变、窗口变，任何一个变了都必须重算；
// 全都没变才许命中。命中率有单独的基准（见提交说明里的数字）。
import { describe, it, expect, beforeEach } from "vitest";
import {
  expandEvent,
  __clearExpansionCacheForTest,
  __expansionCacheStatsForTest,
  type EventForExpansion,
} from "../src/lib/rrule_expand.js";

const D = (iso: string) => new Date(iso);
const FROM = D("2026-06-01T00:00:00Z");
const TO = D("2026-06-30T23:59:59Z");

function weekly(over: Partial<EventForExpansion> = {}): EventForExpansion {
  return {
    id: "cache-ev",
    allDay: false,
    timeZone: "UTC",
    startsAt: D("2026-06-01T10:00:00Z"), // Monday
    endsAt: D("2026-06-01T11:00:00Z"),
    rrule: "FREQ=WEEKLY;BYDAY=MO",
    exdates: null,
    updatedAt: D("2026-05-01T00:00:00Z"),
    ...over,
  };
}

beforeEach(() => { __clearExpansionCacheForTest(); });

describe("expandEvent 记忆化", () => {
  it("同一事件同一窗口第二次展开命中缓存，结果与第一次逐条一致", () => {
    const ev = weekly();
    const first = expandEvent(ev, FROM, TO);
    expect(first.length).toBeGreaterThan(1);
    expect(__expansionCacheStatsForTest()).toMatchObject({ misses: 1, hits: 0 });

    const second = expandEvent(ev, FROM, TO);
    expect(__expansionCacheStatsForTest()).toMatchObject({ misses: 1, hits: 1 });
    expect(second.map((o) => o.startsAt.toISOString())).toEqual(first.map((o) => o.startsAt.toISOString()));
  });

  it("updatedAt 变了（其余输入不变）必须重算", () => {
    expandEvent(weekly(), FROM, TO);
    expandEvent(weekly({ updatedAt: D("2026-05-02T00:00:00Z") }), FROM, TO);
    expect(__expansionCacheStatsForTest()).toMatchObject({ misses: 2, hits: 0 });
  });

  it("exdates 变了必须重算，且被删掉的那一次真的消失（不许给旧结果）", () => {
    const ev = weekly();
    const before = expandEvent(ev, FROM, TO);
    const victim = before[1]!.startsAt.toISOString();

    const after = expandEvent(weekly({ exdates: [victim] }), FROM, TO);
    expect(__expansionCacheStatsForTest()).toMatchObject({ misses: 2, hits: 0 });
    expect(after.map((o) => o.startsAt.toISOString())).not.toContain(victim);
    expect(after).toHaveLength(before.length - 1);
  });

  it("exdates 变了但调用方没带 updatedAt（键里靠展开输入本身兜底）也要刷新", () => {
    const noStamp = weekly({ updatedAt: undefined });
    const before = expandEvent(noStamp, FROM, TO);
    const victim = before[0]!.startsAt.toISOString();
    const after = expandEvent(weekly({ updatedAt: undefined, exdates: [victim] }), FROM, TO);
    expect(after.map((o) => o.startsAt.toISOString())).not.toContain(victim);
  });

  it("规则变了（BYDAY 改了）必须重算", () => {
    expandEvent(weekly(), FROM, TO);
    const tuesdays = expandEvent(weekly({ rrule: "FREQ=WEEKLY;BYDAY=TU" }), FROM, TO);
    expect(__expansionCacheStatsForTest()).toMatchObject({ misses: 2, hits: 0 });
    expect(tuesdays.every((o) => o.startsAt.getUTCDay() === 2)).toBe(true);
  });

  it("窗口变了必须重算", () => {
    expandEvent(weekly(), FROM, TO);
    expandEvent(weekly(), FROM, D("2026-07-31T23:59:59Z"));
    expect(__expansionCacheStatsForTest()).toMatchObject({ misses: 2, hits: 0 });
  });

  it("时区变了必须重算（同一条规则在不同时区展开结果不同）", () => {
    expandEvent(weekly(), FROM, TO);
    expandEvent(weekly({ timeZone: "Australia/Sydney" }), FROM, TO);
    expect(__expansionCacheStatsForTest()).toMatchObject({ misses: 2, hits: 0 });
  });

  it("调用方改坏了返回的 Date，缓存里的那份不受影响", () => {
    const ev = weekly();
    const first = expandEvent(ev, FROM, TO);
    const original = first[0]!.startsAt.toISOString();
    first[0]!.startsAt.setTime(0); // 调用方把自己的那份改了

    const second = expandEvent(ev, FROM, TO);
    expect(__expansionCacheStatsForTest().hits).toBe(1);
    expect(second[0]!.startsAt.toISOString()).toBe(original);
  });

  it("非重复事件不进缓存（本身就是 O(1)，别占坑）", () => {
    const single: EventForExpansion = {
      id: "one-off", allDay: false, timeZone: "UTC",
      startsAt: D("2026-06-05T10:00:00Z"), endsAt: D("2026-06-05T11:00:00Z"),
      rrule: null,
    };
    expandEvent(single, FROM, TO);
    expandEvent(single, FROM, TO);
    expect(__expansionCacheStatsForTest()).toMatchObject({ size: 0, hits: 0, misses: 0 });
  });
});
