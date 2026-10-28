import { describe, it, expect } from "vitest";
import { remapLegacyExdates } from "../src/lib/data_migrations.js";
import { expandEvent, listSeriesStartsLegacyUtc } from "../src/lib/rrule_expand.js";

// 老数据：「删掉这一次 / 只改这一次」往 exdates 里记的是**旧算法**（DTSTART 写成 UTC）
// 算出来的那一次的时刻。展开改成按事件时区之后，要把它们对到新算法里同序号的那一次。
//
// 断言的口径是「用户以前看到被删掉的是第几次，迁移之后被删掉的还是第几次」——
// 旧算法的第 k 次用 listSeriesStartsLegacyUtc 现算，不写死，免得测试和实现一起错。

const MEL = "Australia/Melbourne";
const D = (iso: string) => new Date(iso);

/** 旧算法的第 k 次（从 0 数）。 */
function legacyNth(startsAt: Date, rrule: string, k: number): string {
  const l = listSeriesStartsLegacyUtc({ startsAt, rrule }, { minCount: k + 1, cap: 1000 })!;
  return l.starts[k]!.toISOString();
}

/** 新算法展开、扣掉 exdates 之后剩下的墨尔本日期。 */
function visibleDays(startsAt: Date, rrule: string, exdates: string[]): string[] {
  return expandEvent(
    { id: "e", startsAt, endsAt: new Date(startsAt.getTime() + 3600_000), rrule, exdates, allDay: false, timeZone: MEL },
    D("2026-09-01T00:00:00Z"), D("2027-03-01T00:00:00Z"),
  ).map((o) => new Intl.DateTimeFormat("en-CA", { timeZone: MEL, year: "numeric", month: "2-digit", day: "2-digit" }).format(o.startsAt));
}

describe("墨尔本周一 9:30「每周一」：以前画在周二，删掉的是第 3 次", () => {
  const startsAt = D("2026-09-27T23:30:00Z");   // 2026-09-28 周一 09:30 AEST
  const rrule = "FREQ=WEEKLY;BYDAY=MO;COUNT=6";
  const oldThird = legacyNth(startsAt, rrule, 2);

  it("前提：旧算法的第 3 次落在墨尔本的周二（就是那个 bug）", () => {
    const wd = new Intl.DateTimeFormat("en-US", { timeZone: MEL, weekday: "short" }).format(new Date(oldThird));
    expect(wd).toBe("Tue");
  });

  it("迁移把它改成新算法的第 3 次（墨尔本 10-12 周一），删掉的还是第 3 次", () => {
    const r = remapLegacyExdates({ startsAt, rrule, allDay: false, exdates: [oldThird], timeZone: MEL })!;
    expect(r.rewritten).toBe(1);
    expect(r.exdates).toEqual(["2026-10-11T22:30:00.000Z"]);
    expect(visibleDays(startsAt, rrule, r.exdates)).toEqual(["2026-09-28", "2026-10-05", "2026-10-19", "2026-10-26", "2026-11-02"]);
  });

  it("不迁移的话，被删的那次会冒出来（这条证明上一条不是白测）", () => {
    expect(visibleDays(startsAt, rrule, [oldThird])).toHaveLength(6);
  });

  it("迁移过的再跑一遍：一条都不改", () => {
    const once = remapLegacyExdates({ startsAt, rrule, allDay: false, exdates: [oldThird], timeZone: MEL })!;
    const twice = remapLegacyExdates({ startsAt, rrule, allDay: false, exdates: once.exdates, timeZone: MEL })!;
    expect(twice.rewritten).toBe(0);
    expect(twice.exdates).toEqual(once.exdates);
  });
});

describe("只差夏令时（不带 BYDAY）", () => {
  const startsAt = D("2026-09-20T23:30:00Z");   // 2026-09-21 周一 09:30 AEST
  const rrule = "FREQ=WEEKLY";

  it("夏令时之前删掉的：两种算法是同一个时刻，不动；夏令时之后删掉的：对到同序号（同一天 09:30）", () => {
    const before = legacyNth(startsAt, rrule, 1);   // 09-28，两边都是 23:30Z
    const after = legacyNth(startsAt, rrule, 4);    // 10-19：旧算法 23:30Z = 10:30 AEDT
    const r = remapLegacyExdates({ startsAt, rrule, allDay: false, exdates: [before, after], timeZone: MEL })!;
    expect(r.rewritten).toBe(1);
    expect(r.exdates).toEqual([before, "2026-10-18T22:30:00.000Z"]);
  });
});

describe("该原样留着的", () => {
  const startsAt = D("2026-09-27T23:30:00Z");
  const rrule = "FREQ=WEEKLY;BYDAY=MO";

  it("新算法本来就算得出的（升级后删的、手机通过 CalDAV 写上来的）：不动", () => {
    const r = remapLegacyExdates({ startsAt, rrule, allDay: false, exdates: ["2026-10-04T22:30:00.000Z"], timeZone: MEL })!;
    expect(r.rewritten).toBe(0);
    expect(r.exdates).toEqual(["2026-10-04T22:30:00.000Z"]);
  });

  it("两边都算得出、但序号不同的：新算法算得出就不动（「已经对得上」优先于按序号对齐）", () => {
    // 每个工作日 9:30：旧算法是 UTC 的周一到周五 23:30Z（= 墨尔本周二到周六），
    // 新算法是墨尔本的周一到周五。2026-09-28T23:30Z 在旧算法里是第 1 次、新算法里是第 2 次。
    const weekdays = "FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR";
    expect(legacyNth(startsAt, weekdays, 0)).toBe("2026-09-28T23:30:00.000Z");
    const r = remapLegacyExdates({ startsAt, rrule: weekdays, allDay: false, exdates: ["2026-09-28T23:30:00.000Z"], timeZone: MEL })!;
    expect(r.rewritten).toBe(0);
    expect(r.exdates).toEqual(["2026-09-28T23:30:00.000Z"]);
  });

  it("两边都算不出的孤儿、写坏的字符串：原样保留，不猜", () => {
    const r = remapLegacyExdates({
      startsAt, rrule, allDay: false, exdates: ["2026-10-07T01:02:03.000Z", "garbage"], timeZone: MEL,
    })!;
    expect(r.rewritten).toBe(0);
    expect(r.exdates).toEqual(["2026-10-07T01:02:03.000Z", "garbage"]);
  });

  it("改写出来的那次已经在列表里了（两条本来指同一次）：只留一条", () => {
    const oldSecond = legacyNth(startsAt, rrule, 1);              // 旧算法第 2 次
    const newSecond = "2026-10-04T22:30:00.000Z";                  // 新算法第 2 次
    const r = remapLegacyExdates({ startsAt, rrule, allDay: false, exdates: [newSecond, oldSecond], timeZone: MEL })!;
    expect(r.rewritten).toBe(1);
    expect(r.exdates).toEqual([newSecond]);
  });

  it("全天、按 UTC 展开的、不重复的：不处理", () => {
    const ex = [legacyNth(startsAt, rrule, 1)];
    expect(remapLegacyExdates({ startsAt, rrule, allDay: true, exdates: ex, timeZone: MEL })).toBeNull();
    expect(remapLegacyExdates({ startsAt, rrule, allDay: false, exdates: ex, timeZone: "UTC" })).toBeNull();
    expect(remapLegacyExdates({ startsAt, rrule: null, allDay: false, exdates: ex, timeZone: MEL })).toBeNull();
  });
});
