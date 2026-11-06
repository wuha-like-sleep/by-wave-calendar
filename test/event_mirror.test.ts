import { describe, it, expect } from "vitest";
import "../src/public/event-store.js";

// 网页本地镜像的规则（src/public/event-store.js 文件上半部分的纯函数）。
//
// 这两个洞都是真实发生过的，页面照常、不报错：
//   · 重复事件的每一次共用一个 id，按 id 存就只剩最后一次 —— 月视图里每周例会一个月只显示一次；
//   · 从不清理 —— 另一台设备删掉的事件在网页上一直显示。

type Row = Record<string, unknown> & { id: string };
type Win = { fromMs: number; toMs: number; fetchStartedAt: number; now: number; calendarIds?: string[] | null };
const M = (globalThis as unknown as {
  bwcMirrorCore: {
    rowKeyOf(e: Row): string;
    toLocalRow(e: Row, now: number): Row;
    planWindowMerge(rows: Row[], events: Row[], win: Win): { puts: Row[]; deletes: string[] };
    visibleRows(rows: Row[], fromMs: number, toMs: number): Row[];
  };
}).bwcMirrorCore;

const T = (iso: string) => +new Date(iso);
const FROM = T("2026-11-01T00:00:00Z");
const TO = T("2026-12-01T00:00:00Z");
const NOW = T("2026-11-06T00:00:00Z");
const WIN: Win = { fromMs: FROM, toMs: TO, fetchStartedAt: NOW - 100, now: NOW };

const occ = (id: string, day: string, extra: Record<string, unknown> = {}): Row => ({
  id, calendarId: "c1", summary: "例会", rrule: "FREQ=WEEKLY", isOccurrence: true,
  startsAt: `2026-11-${day}T09:00:00.000Z`, endsAt: `2026-11-${day}T10:00:00.000Z`, ...extra,
});
const one = (id: string, day = "10", extra: Record<string, unknown> = {}): Row => ({
  id, calendarId: "c1", summary: "单次", rrule: null,
  startsAt: `2026-11-${day}T09:00:00.000Z`, endsAt: `2026-11-${day}T10:00:00.000Z`, ...extra,
});

/** 照 mergeIntoLocal 的写法把 plan 用到一份「库」上。 */
function apply(rows: Row[], plan: { puts: Row[]; deletes: string[] }): Row[] {
  const db = new Map(rows.map((r) => [r.id, r]));
  for (const k of plan.deletes) db.delete(k);
  for (const r of plan.puts) db.set(r.id, r);
  return [...db.values()];
}
const read = (rows: Row[]) => M.visibleRows(rows, FROM, TO);

describe("重复事件的每一次都留得住", () => {
  it("每周例会一个月 4 次：存进去 4 行，读出来 4 次，id 都是主事件的", () => {
    const events = ["02", "09", "16", "23"].map((d) => occ("e1", d));
    const db = apply([], M.planWindowMerge([], events, WIN));
    expect(db).toHaveLength(4);
    const out = read(db);
    expect(out.map((e) => e.startsAt)).toEqual(events.map((e) => e.startsAt));
    expect(new Set(out.map((e) => e.id))).toEqual(new Set(["e1"]));
  });

  it("读出去的行不带内部字段", () => {
    const out = read(apply([], M.planWindowMerge([], [occ("e1", "02")], WIN)));
    expect(Object.keys(out[0]!).filter((k) => k.startsWith("_"))).toEqual([]);
  });

  it("单次事件的键还是自己的 id（改、删都按 id 找）", () => {
    expect(M.rowKeyOf(one("e2"))).toBe("e2");
  });
});

describe("一次成功的拉取就是这个窗口的真相", () => {
  it("另一台设备删掉的事件：窗口里有、结果里没有 → 删掉", () => {
    const db0 = apply([], M.planWindowMerge([], [one("gone"), one("stay")], { ...WIN, now: NOW - 5000, fetchStartedAt: NOW - 5100 }));
    const db1 = apply(db0, M.planWindowMerge(db0, [one("stay")], WIN));
    expect(read(db1).map((e) => e.id)).toEqual(["stay"]);
  });

  it("系列在别的设备上删了一次：只少那一次", () => {
    const db0 = apply([], M.planWindowMerge([], ["02", "09"].map((d) => occ("e1", d)), { ...WIN, now: NOW - 5000, fetchStartedAt: NOW - 5100 }));
    const db1 = apply(db0, M.planWindowMerge(db0, [occ("e1", "02")], WIN));
    expect(read(db1).map((e) => e.startsAt)).toEqual(["2026-11-02T09:00:00.000Z"]);
  });

  it("窗口之外的不动（看十一月不能把十月的缓存删了）", () => {
    const oct = { ...one("oct"), startsAt: "2026-10-10T09:00:00.000Z", endsAt: "2026-10-10T10:00:00.000Z", _syncedAt: 1 };
    expect(M.planWindowMerge([oct], [], WIN).deletes).toEqual([]);
  });

  it("只查了某几个日历时，别的日历不动", () => {
    const other = { ...one("o"), calendarId: "c2", _syncedAt: 1 };
    expect(M.planWindowMerge([other], [], { ...WIN, calendarIds: ["c1"] }).deletes).toEqual([]);
    expect(M.planWindowMerge([other], [], { ...WIN, calendarIds: ["c2"] }).deletes).toEqual(["o"]);
  });

  it("拉取发出之后才写入的行不删：这次结果早于那次保存，里面当然没有它", () => {
    const justSaved = { ...one("new"), _syncedAt: WIN.fetchStartedAt + 50 };
    expect(M.planWindowMerge([justSaved], [], WIN).deletes).toEqual([]);
  });

  it("响应晚到的旧拉取不能赖着不走：后发的拉取里没有的行照删（记的是发出时刻，不是到达时刻）", () => {
    // F1 发出早、响应晚到；F2 发出晚、那时事件已经被删了
    const f1 = { ...WIN, fetchStartedAt: NOW - 1000, now: NOW + 500 };
    const db0 = apply([], M.planWindowMerge([], ["02", "09"].map((d) => occ("e1", d)), f1));
    const f2 = { ...WIN, fetchStartedAt: NOW, now: NOW + 600 };
    expect(read(apply(db0, M.planWindowMerge(db0, [], f2)))).toEqual([]);
  });

  it("老版本留下的行（按 id 存的最后一次）被换掉，不会多显示一次", () => {
    const legacy = { ...occ("e1", "23"), _syncedAt: 1 };
    const db = apply([legacy], M.planWindowMerge([legacy], ["02", "09", "16", "23"].map((d) => occ("e1", d)), WIN));
    expect(read(db)).toHaveLength(4);
  });
});

describe("本地还没同步出去的改动不能丢", () => {
  it("系列有本地改动：服务端结果不覆盖它，旧的每一次也不显示，只显示改动那一行", () => {
    const db0 = apply([], M.planWindowMerge([], ["02", "09"].map((d) => occ("e1", d)), { ...WIN, now: NOW - 5000, fetchStartedAt: NOW - 5100 }));
    const dirty = { ...occ("e1", "02", { summary: "改了标题" }), id: "e1", _dirty: true };
    const db1 = [...db0, dirty];
    const plan = M.planWindowMerge(db1, ["02", "09"].map((d) => occ("e1", d)), WIN);
    expect(plan.puts).toEqual([]);
    expect(plan.deletes).toEqual([]);
    const out = read(apply(db1, plan));
    expect(out.map((e) => e.summary)).toEqual(["改了标题"]);
  });

  it("系列本地删了（墓碑只有一个 id）：每一次都不显示", () => {
    const db0 = apply([], M.planWindowMerge([], ["02", "09"].map((d) => occ("e1", d)), WIN));
    const out = read([...db0, { id: "e1", _tombstone: true, _dirty: true }]);
    expect(out).toEqual([]);
  });

  it("单次事件本地删了：墓碑不显示；拉取结果也不覆盖它", () => {
    const tomb = { ...one("e2"), _tombstone: true, _dirty: true };
    const plan = M.planWindowMerge([tomb], [one("e2")], WIN);
    expect(plan.puts).toEqual([]);
    expect(plan.deletes).toEqual([]);
    expect(read([tomb])).toEqual([]);
  });

  it("离线新建的（local- 开头、_dirty）不被窗口替换删掉", () => {
    const local = { ...one("local-1"), _dirty: true };
    expect(M.planWindowMerge([local], [], WIN).deletes).toEqual([]);
    expect(read([local]).map((e) => e.id)).toEqual(["local-1"]);
  });
});

describe("服务端接受之后写回的那一行", () => {
  it("重复事件按 id@开始时刻 存，和拉取回来的是同一行，不会多一次", () => {
    const master = occ("e1", "02");
    const saved = M.toLocalRow(master, NOW);
    const db = apply([saved], M.planWindowMerge([saved], ["02", "09"].map((d) => occ("e1", d)), { ...WIN, fetchStartedAt: NOW + 1, now: NOW + 2 }));
    expect(read(db)).toHaveLength(2);
  });
});
