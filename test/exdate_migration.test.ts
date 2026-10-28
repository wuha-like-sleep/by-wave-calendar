import { describe, it, expect } from "vitest";
import { remapLegacyExdates } from "../src/lib/data_migrations.js";
import { remapSeriesForZoneChange } from "../src/lib/exdate_remap.js";
import { expandEvent, seriesStartsBetween } from "../src/lib/rrule_expand.js";

// 老数据：「删掉这一次 / 只改这一次」往 exdates 里记的是**旧算法**（DTSTART 写成 UTC）
// 算出来的那一次的时刻。展开改成按事件时区之后，口径是「删掉的是当时看到的那一次」：
// 那个时刻新排法里还有就不动，没有了就换成离它最近的那一次（一天之内）。
//
// 旧算法的第 k 次用「按 UTC 展开」现算，不写死，免得测试和实现一起错。

const MEL = "Australia/Melbourne";
const NY = "America/New_York";
const D = (iso: string) => new Date(iso);

/** 旧算法（按 UTC 展开）的第 k 次（从 0 数）。 */
function legacyNth(startsAt: Date, rrule: string, k: number): string {
  const all = seriesStartsBetween({ startsAt, rrule, allDay: false, timeZone: "UTC" }, startsAt, new Date(startsAt.getTime() + 400 * 86400_000))!;
  return all[k]!.toISOString();
}

function dayIn(tz: string, d: Date | string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(d));
}
function weekdayIn(tz: string, d: Date | string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(new Date(d));
}

/** 新算法展开、扣掉 exdates 之后剩下的日期（按 tz 的日历）。 */
function visibleDays(startsAt: Date, rrule: string, exdates: string[], tz = MEL): string[] {
  return expandEvent(
    { id: "e", startsAt, endsAt: new Date(startsAt.getTime() + 3600_000), rrule, exdates, allDay: false, timeZone: tz },
    D("2026-09-01T00:00:00Z"), D("2027-03-01T00:00:00Z"),
  ).map((o) => dayIn(tz, o.startsAt));
}

const remap = (startsAt: Date, rrule: string, exdates: unknown[], tz = MEL) =>
  remapLegacyExdates({ startsAt, rrule, allDay: false, exdates, timeZone: tz })!;

describe("墨尔本周一 9:30「每周一」：以前画在周二", () => {
  const startsAt = D("2026-09-27T23:30:00Z");   // 2026-09-28 周一 09:30 AEST
  const rrule = "FREQ=WEEKLY;BYDAY=MO;COUNT=6";
  const oldThird = legacyNth(startsAt, rrule, 2);

  it("前提：旧算法的第 3 次落在墨尔本的周二（就是那个 bug）", () => {
    expect(weekdayIn(MEL, oldThird)).toBe("Tue");
  });

  it("迁移把它改成那一周的周一（墨尔本 10-12 09:30）", () => {
    const r = remap(startsAt, rrule, [oldThird]);
    expect(r.rewritten).toBe(1);
    expect(r.exdates).toEqual(["2026-10-11T22:30:00.000Z"]);
    expect(visibleDays(startsAt, rrule, r.exdates)).toEqual(["2026-09-28", "2026-10-05", "2026-10-19", "2026-10-26", "2026-11-02"]);
  });

  it("不迁移的话，被删的那次会冒出来（这条证明上一条不是白测）", () => {
    expect(visibleDays(startsAt, rrule, [oldThird])).toHaveLength(6);
  });

  it("迁移过的再跑一遍：一条都不改", () => {
    const once = remap(startsAt, rrule, [oldThird]);
    const twice = remap(startsAt, rrule, once.exdates);
    expect(twice.rewritten).toBe(0);
    expect(twice.exdates).toEqual(once.exdates);
  });
});

describe("纽约周一晚上 8 点（UTC 以西）：以前画在周日，而且旧算法里第一次就少了", () => {
  // 2026-10-05 周一 20:00 EDT = 10-06 00:00Z。旧算法按 UTC 的周一算：第一次是 10-12 00:00Z
  // （纽约周日 10-11 20:00），主事件那一次根本不在旧序列里 —— 按「第几次」对应会差整整一周。
  const startsAt = D("2026-10-06T00:00:00Z");
  const rrule = "FREQ=WEEKLY;BYDAY=MO;COUNT=8";

  it("前提：旧序列第 0 次是纽约周日 10-11，不是主事件", () => {
    expect(legacyNth(startsAt, rrule, 0)).toBe("2026-10-12T00:00:00.000Z");
    expect(weekdayIn(NY, legacyNth(startsAt, rrule, 0))).toBe("Sun");
  });

  it("删掉的「周日 10-18」→ 那一周的周一 10-19，不是 10-12", () => {
    const oldSun1018 = legacyNth(startsAt, rrule, 1);
    expect(dayIn(NY, oldSun1018)).toBe("2026-10-18");
    const r = remap(startsAt, rrule, [oldSun1018], NY);
    expect(r.exdates).toEqual(["2026-10-20T00:00:00.000Z"]);
    expect(visibleDays(startsAt, rrule, r.exdates, NY).slice(0, 4)).toEqual(["2026-10-05", "2026-10-12", "2026-10-26", "2026-11-02"]);
  });

  it("夏令时结束之后（11 月）的也对得上：周日 11-08 20:00 EST → 周一 11-09 20:00 EST", () => {
    const old = legacyNth(startsAt, rrule, 4);
    expect(dayIn(NY, old)).toBe("2026-11-08");
    const r = remap(startsAt, rrule, [old], NY);
    expect(r.exdates).toEqual(["2026-11-10T01:00:00.000Z"]);
    expect(remap(startsAt, rrule, r.exdates, NY).rewritten).toBe(0);
  });

  it("每月 15 号（BYMONTHDAY）同理：以前画在 14 号，对到 15 号", () => {
    const monthly = "FREQ=MONTHLY;BYMONTHDAY=15;COUNT=6";
    const start = D("2026-09-16T00:00:00Z");   // 纽约 09-15 20:00 EDT（UTC 是 16 号，旧序列从 10 月才开始）
    const old = legacyNth(start, monthly, 0);
    expect(dayIn(NY, old)).toBe("2026-10-14");
    const r = remap(start, monthly, [old], NY);
    expect(r.exdates.map((x) => dayIn(NY, x))).toEqual(["2026-10-15"]);
  });
});

describe("墨尔本早上 9:30「每个工作日」站会：以前画在周二到周六", () => {
  const startsAt = D("2026-09-27T23:30:00Z");   // 周一 09-28 09:30 AEST
  const rrule = "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR";

  it("删掉的是画在周二的那次：新排法里周二 09:30 本来就有一次，删的就是它，不动", () => {
    const tue = "2026-09-28T23:30:00.000Z";   // 墨尔本 09-29 周二 09:30
    expect(weekdayIn(MEL, tue)).toBe("Tue");
    const r = remap(startsAt, rrule, [tue]);
    expect(r.rewritten).toBe(0);
    expect(r.exdates).toEqual([tue]);
  });

  it("删掉的是画在周六的那次：新排法周六没有，对到最近的周五", () => {
    const sat = "2026-10-02T23:30:00.000Z";   // 墨尔本 10-03 周六 09:30
    expect(weekdayIn(MEL, sat)).toBe("Sat");
    const r = remap(startsAt, rrule, [sat]);
    expect(r.exdates.map((x) => `${dayIn(MEL, x)} ${weekdayIn(MEL, x)}`)).toEqual(["2026-10-02 Fri"]);
  });

  it("夏令时之后：画在周二 10:30 的那次 → 周二 09:30（同一天，不跳到周一）", () => {
    const tue = "2026-10-12T23:30:00.000Z";   // 墨尔本 10-13 周二 10:30 AEDT
    const r = remap(startsAt, rrule, [tue]);
    expect(r.exdates).toEqual(["2026-10-12T22:30:00.000Z"]);
  });

  it("周五、周六两次都删了：周六那条对到周五、和周五那条并成一条，周四不受牵连", () => {
    const fri = "2026-10-01T23:30:00.000Z";   // 墨尔本 10-02 周五
    const sat = "2026-10-02T23:30:00.000Z";
    const r = remap(startsAt, rrule, [fri, sat]);
    expect(r.exdates).toEqual([fri]);
    expect(visibleDays(startsAt, rrule, r.exdates)).toContain("2026-10-01");
  });
});

describe("隔天的规则（一三五）：两边各有一次，只能往错一天的那一侧找", () => {
  const rrule = "FREQ=WEEKLY;BYDAY=MO,WE,FR";
  const label = (tz: string, x: string) => `${dayIn(tz, x)} ${weekdayIn(tz, x)}`;

  it("墨尔本 9 月建的 09:30，10 月（夏令时）删的：画在周二 10:30 的是周一那次，不是周三", () => {
    const startsAt = D("2026-09-27T23:30:00Z");   // 周一 09-28 09:30 AEST
    // 旧算法按 UTC 的一三五 23:30Z = 墨尔本二四六 10:30 AEDT
    const tue = "2026-10-12T23:30:00.000Z", thu = "2026-10-14T23:30:00.000Z", sat = "2026-10-16T23:30:00.000Z";
    expect([tue, thu, sat].map((x) => weekdayIn(MEL, x))).toEqual(["Tue", "Thu", "Sat"]);
    const r = remap(startsAt, rrule, [tue, thu, sat]);
    expect(r.exdates.map((x) => label(MEL, x))).toEqual(["2026-10-12 Mon", "2026-10-14 Wed", "2026-10-16 Fri"]);
  });

  it("纽约周一三五晚上 8 点（冬令时）：画在周二的是周三那次，不是周一（两边一样近也不能取早的）", () => {
    const startsAt = D("2026-11-03T01:00:00Z");   // 纽约 11-02 周一 20:00 EST
    // 旧算法：UTC 的一三五 01:00Z = 纽约日二四 20:00
    const tue = "2026-11-11T01:00:00.000Z", thu = "2026-11-13T01:00:00.000Z";
    expect([tue, thu].map((x) => weekdayIn(NY, x))).toEqual(["Tue", "Thu"]);
    const r = remap(startsAt, rrule, [tue, thu], NY);
    expect(r.exdates.map((x) => label(NY, x))).toEqual(["2026-11-11 Wed", "2026-11-13 Fri"]);
  });

  it("改日历时区（上海 → 纽约），纽约周一三五 13:00：上海排法里画在周二的对到周三", () => {
    // 纽约 11-02 周一 13:00 EST = 18:00Z = 上海周二 02:00。按上海排的「一三五」落在纽约的日二四。
    const startsAt = D("2026-11-02T18:00:00Z");
    const tue = "2026-11-10T18:00:00.000Z";   // 上海 11-11 周三 02:00 = 纽约 11-10 周二 13:00
    expect(weekdayIn(NY, tue)).toBe("Tue");
    const r = remapSeriesForZoneChange({ startsAt, rrule, allDay: false, exdates: [tue], fromZone: "Asia/Shanghai", toZone: NY });
    expect(r.exdates!.map((x) => label(NY, x))).toEqual(["2026-11-11 Wed"]);
  });
});

describe("只差夏令时（不带 BYDAY）", () => {
  const startsAt = D("2026-09-20T23:30:00Z");   // 2026-09-21 周一 09:30 AEST
  const rrule = "FREQ=WEEKLY";

  it("夏令时之前删掉的：两种算法是同一个时刻，不动；之后删掉的：同一天 09:30", () => {
    const before = legacyNth(startsAt, rrule, 1);   // 09-28，两边都是 23:30Z
    const after = legacyNth(startsAt, rrule, 4);    // 10-19：旧算法 23:30Z = 10:30 AEDT
    const r = remap(startsAt, rrule, [before, after]);
    expect(r.rewritten).toBe(1);
    expect(r.exdates).toEqual([before, "2026-10-18T22:30:00.000Z"]);
  });
});

describe("该原样留着的", () => {
  const startsAt = D("2026-09-27T23:30:00Z");
  const rrule = "FREQ=WEEKLY;BYDAY=MO";

  it("新算法本来就算得出的（升级后删的、手机通过 CalDAV 写上来的）：不动", () => {
    const r = remap(startsAt, rrule, ["2026-10-04T22:30:00.000Z"]);
    expect(r.rewritten).toBe(0);
    expect(r.exdates).toEqual(["2026-10-04T22:30:00.000Z"]);
  });

  it("两边都算不出的孤儿、写坏的字符串：原样保留，不猜", () => {
    const r = remap(startsAt, rrule, ["2026-10-07T01:02:03.000Z", "garbage"]);
    expect(r.rewritten).toBe(0);
    expect(r.exdates).toEqual(["2026-10-07T01:02:03.000Z", "garbage"]);
  });

  it("改写出来的那次已经在列表里了（两条本来指同一次）：只留一条", () => {
    const oldSecond = legacyNth(startsAt, rrule, 1);
    const newSecond = "2026-10-04T22:30:00.000Z";
    const r = remap(startsAt, rrule, [newSecond, oldSecond]);
    expect(r.rewritten).toBe(1);
    expect(r.exdates).toEqual([newSecond]);
  });

  it("全天、按 UTC 展开的、不重复的：不处理", () => {
    const ex = [legacyNth(startsAt, rrule, 1)];
    expect(remapLegacyExdates({ startsAt, rrule, allDay: true, exdates: ex, timeZone: MEL })).toBeNull();
    expect(remapLegacyExdates({ startsAt, rrule, allDay: false, exdates: ex, timeZone: "UTC" })).toBeNull();
    expect(remapLegacyExdates({ startsAt, rrule: null, allDay: false, exdates: ex, timeZone: MEL })).toBeNull();
  });

  it("小时级以下的规则不处理（不在开机路径上从头数几百万次）", () => {
    const r = remapSeriesForZoneChange({
      startsAt, rrule: "FREQ=MINUTELY;INTERVAL=30", allDay: false,
      exdates: ["2026-10-01T00:00:00.000Z"], fromZone: "UTC", toZone: MEL,
    });
    expect(r).toEqual({ rewritten: 0, unmapped: 0 });
  });
});

describe("「这次及以后」留下的 UNTIL", () => {
  const startsAt = D("2026-09-20T23:30:00Z");   // 2026-09-21 周一 09:30 AEST

  it("只差夏令时：UNTIL 跟着挪到新排法那一次之前，旧系列在拆分那天不再多一次", () => {
    // 升级前在 10-19 那次（旧算法 23:30Z = 10:30 AEDT）上点了「这次及以后」：UNTIL = 那一次 − 1 秒
    const rrule = "FREQ=WEEKLY;UNTIL=20261018T232959Z";
    expect(visibleDays(startsAt, rrule, []), "前提：不挪的话 10-19 09:30 还在，和新系列撞在同一天").toContain("2026-10-19");
    const r = remapSeriesForZoneChange({ startsAt, rrule, allDay: false, exdates: null, fromZone: "UTC", toZone: MEL });
    expect(r.rrule).toBe("FREQ=WEEKLY;UNTIL=20261018T222959Z");
    expect(visibleDays(startsAt, r.rrule!, [])).toEqual(["2026-09-21", "2026-09-28", "2026-10-05", "2026-10-12"]);
    // 再跑一遍不动
    expect(remapSeriesForZoneChange({ startsAt, rrule: r.rrule!, allDay: false, exdates: null, fromZone: "UTC", toZone: MEL }).rrule).toBeUndefined();
  });

  it("差一天的（「每周一」以前画在周二）不挪：宁可那周多一次旧的，也不让那周一次都没有", () => {
    const s = D("2026-09-27T23:30:00Z");
    const rrule = "FREQ=WEEKLY;BYDAY=MO;UNTIL=20261012T232959Z";   // 在画在周二 10-13 的那次上拆的
    const r = remapSeriesForZoneChange({ startsAt: s, rrule, allDay: false, exdates: null, fromZone: "UTC", toZone: MEL });
    expect(r.rrule).toBeUndefined();
  });

  it("用户自己设的结束日期（UNTIL+1 秒不是旧排法的一次）：不动", () => {
    const rrule = "FREQ=WEEKLY;UNTIL=20261231T125959Z";
    const r = remapSeriesForZoneChange({ startsAt, rrule, allDay: false, exdates: null, fromZone: "UTC", toZone: MEL });
    expect(r.rrule).toBeUndefined();
  });
});

describe("改日历时区（上海 → 墨尔本）：没有自己时区的老事件跟着换", () => {
  // 墨尔本周一 09:30 AEST 建的、没填时区，日历是默认的上海：按上海 07:30 每周排，
  // 墨尔本夏令时之后变成 10:30。日历改成墨尔本之后是 09:30。
  const startsAt = D("2026-09-27T23:30:00Z");
  const rrule = "FREQ=WEEKLY;BYDAY=MO";

  it("以前删掉的 10-19 那次（上海排法 23:30Z）对到墨尔本排法的同一天 09:30", () => {
    const r = remapSeriesForZoneChange({
      startsAt, rrule, allDay: false, exdates: ["2026-10-18T23:30:00.000Z"], fromZone: "Asia/Shanghai", toZone: MEL,
    });
    expect(r.exdates).toEqual(["2026-10-18T22:30:00.000Z"]);
  });
});

describe("展开本身的几处边角", () => {
  it("startsAt 带毫秒：每一次都是整秒（手机写回来的 EXDATE 只到秒，带毫秒就删不掉）", () => {
    const s = D("2026-09-27T23:30:00.123Z");
    const occ = expandEvent(
      { id: "e", startsAt: s, endsAt: new Date(s.getTime() + 3600_000), rrule: "FREQ=WEEKLY;COUNT=3", exdates: ["2026-10-04T22:30:00Z"], allDay: false, timeZone: MEL },
      D("2026-09-01T00:00:00Z"), D("2026-12-01T00:00:00Z"),
    );
    expect(occ.map((o) => o.startsAt.getUTCMilliseconds())).toEqual([0, 0]);
    expect(occ.map((o) => dayIn(MEL, o.startsAt))).toEqual(["2026-09-28", "2026-10-12"]);
  });

  it("FREQ=SECONDLY 也照样给满 366 次（两头的余量不占额度）", () => {
    const s = D("2026-10-01T00:00:00Z");
    const occ = expandEvent(
      { id: "e", startsAt: s, endsAt: new Date(s.getTime() + 1000), rrule: "FREQ=SECONDLY", allDay: false, timeZone: MEL },
      D("2026-10-01T06:00:00Z"), D("2026-10-01T07:00:00Z"),
    );
    expect(occ).toHaveLength(366);
  });

  it("UNTIL 按真实时刻截：夏令时拨回那一小时里也不多给、不少给", () => {
    // 墨尔本 2027-04-04 03:00 AEDT 拨回 02:00 AEST。每小时一次，从 01:30 AEDT（14:30Z）起，
    // UNTIL = 15:30Z（= 02:30 AEDT，拨回之前那一遍）。墙上读数里第二遍 02:30 AEST（16:30Z）
    // 和它读数相同，只按墙上时间比会多给一次；UNTIL 那一次本身（含）要给。
    const s = D("2027-04-03T14:30:00Z");
    const occ = expandEvent(
      { id: "e", startsAt: s, endsAt: new Date(s.getTime() + 60_000), rrule: "FREQ=HOURLY;UNTIL=20270403T153000Z", allDay: false, timeZone: MEL },
      D("2027-04-03T00:00:00Z"), D("2027-04-05T00:00:00Z"),
    );
    expect(occ.map((o) => o.startsAt.toISOString())).toEqual(["2027-04-03T14:30:00.000Z", "2027-04-03T15:30:00.000Z"]);
  });
});
