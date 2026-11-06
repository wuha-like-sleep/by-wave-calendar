import { describe, it, expect } from "vitest";
import { planSeriesEdit, sameRule, type SeriesEditInput } from "../src/lib/series_edit.js";
import { expandEvent } from "../src/lib/rrule_expand.js";

// 「所有事件」保存的规则（series_edit.ts）。走 HTTP 的场景在
// test/integration/series_edit_keeps_start.int.test.ts，这里盯算法的边角。

const MEL = "Australia/Melbourne";
const NY = "America/New_York";
const master = (o: Partial<SeriesEditInput["master"]> = {}): SeriesEditInput["master"] => ({
  // 墨尔本 10-26 周一 09:30 AEDT
  startsAt: new Date("2026-10-25T22:30:00.000Z"), endsAt: new Date("2026-10-25T23:30:00.000Z"),
  rrule: "FREQ=WEEKLY;BYDAY=MO", allDay: false, exdates: null, ...o,
});
const LATER = "2026-11-15T22:30:00.000Z";   // 墨尔本 11-16 周一 09:30
const iso = (d?: Date) => d?.toISOString();

describe("重发（网页发送队列超时、两个标签页）不能做两遍", () => {
  const send = { startsAt: "2026-11-16T22:30:00.000Z", endsAt: "2026-11-16T23:30:00.000Z", rrule: "FREQ=WEEKLY;BYDAY=MO" };
  const base = "2026-10-25T22:30:00.000Z";

  it("跨天转过规则：重发带的还是旧规则，也不能当成换了规则写回去", () => {
    const first = planSeriesEdit({ master: master(), zone: MEL, sent: send, recurrenceId: LATER, seriesBase: base })!;
    expect(first.rrule).toBe("FREQ=WEEKLY;BYDAY=TU");
    expect(iso(first.startsAt)).toBe("2026-10-26T22:30:00.000Z");
    const replay = planSeriesEdit({
      master: master({ startsAt: first.startsAt!, endsAt: first.endsAt!, rrule: first.rrule! }), zone: MEL, sent: send, recurrenceId: LATER, seriesBase: base,
    })!;
    expect(replay).toEqual({ startsAt: first.startsAt, endsAt: first.endsAt, rrule: "FREQ=WEEKLY;BYDAY=TU" });
  });

  it("平移过的 exdates 重发不再挪（plan 里没有 exdates = 不写这一列）", () => {
    const replay = planSeriesEdit({
      master: master({ startsAt: new Date("2026-10-25T23:30:00.000Z"), exdates: ["2026-11-01T23:30:00.000Z"] }),
      zone: MEL, sent: { startsAt: "2026-11-15T23:30:00.000Z" }, recurrenceId: LATER, seriesBase: base,
    })!;
    expect(replay.exdates).toBeUndefined();
  });

  it("只改标题没有差值，发几遍都一样", () => {
    const once = planSeriesEdit({ master: master(), zone: MEL, sent: { startsAt: LATER, endsAt: "2026-11-15T23:30:00.000Z" }, recurrenceId: LATER, seriesBase: base })!;
    expect(iso(once.startsAt)).toBe(base);
    expect(once.exdates).toBeUndefined();
  });
});

describe("跨天时规则跟着转", () => {
  const rotate = (rrule: string, startsAt: string, ref = LATER) =>
    planSeriesEdit({ master: master({ rrule }), zone: MEL, sent: { startsAt }, recurrenceId: ref })!.rrule;

  it("周一 → 周二；周日跨到周一；往前挪；挪整一周不转", () => {
    expect(rotate("FREQ=WEEKLY;BYDAY=MO,WE,FR", "2026-11-16T22:30:00.000Z")).toBe("FREQ=WEEKLY;BYDAY=TU,TH,SA");
    expect(rotate("FREQ=WEEKLY;BYDAY=SU", "2026-11-16T22:30:00.000Z")).toBe("FREQ=WEEKLY;BYDAY=MO");
    expect(rotate("FREQ=WEEKLY;BYDAY=MO", "2026-11-14T22:30:00.000Z")).toBe("FREQ=WEEKLY;BYDAY=SU");
    expect(rotate("FREQ=WEEKLY;BYDAY=MO", "2026-11-22T22:30:00.000Z")).toBe("FREQ=WEEKLY;BYDAY=MO");
    expect(rotate("FREQ=WEEKLY;BYDAY=MO", "2026-11-05T22:30:00.000Z")).toBe("FREQ=WEEKLY;BYDAY=FR");   // −10 天
  });

  it("跨过午夜也算跨天（周一 23:30 → 周二 00:30，按墙上日期）", () => {
    const ref = "2026-11-16T12:30:00.000Z";       // 墨尔本 11-16 周一 23:30
    expect(rotate("FREQ=WEEKLY;BYDAY=MO", "2026-11-16T13:30:00.000Z", ref)).toBe("FREQ=WEEKLY;BYDAY=TU");
  });

  it("只挪几小时不转；UNTIL 一起平移", () => {
    expect(rotate("FREQ=WEEKLY;BYDAY=MO;UNTIL=20261129T223000Z", "2026-11-15T23:30:00.000Z")).toBe("FREQ=WEEKLY;BYDAY=MO;UNTIL=20261129T233000Z");
  });

  it("「每月第一个周一」「每月 15 号」挪不了：规则和 exdates 都不动", () => {
    for (const rrule of ["FREQ=MONTHLY;BYDAY=1MO", "FREQ=MONTHLY;BYMONTHDAY=15"]) {
      const ex = ["2026-11-01T22:30:00.000Z"];
      const p = planSeriesEdit({ master: master({ rrule, exdates: ex }), zone: MEL, sent: { startsAt: "2026-11-16T22:30:00.000Z" }, recurrenceId: LATER })!;
      expect(p.rrule).toBe(rrule);
      expect(p.exdates).toBeUndefined();
    }
  });
});

describe("规则里写死的东西挪不了：不丢任何一次（复核挖出来的，都从展开结果验）", () => {
  const WIN: [Date, Date] = [new Date("2026-10-01T00:00:00Z"), new Date("2027-03-01T00:00:00Z")];
  const startsOf = (m: SeriesEditInput["master"], p: ReturnType<typeof planSeriesEdit>) => {
    const startsAt = p?.startsAt ?? m.startsAt;
    const endsAt = p?.endsAt ?? m.endsAt;
    return expandEvent(
      { id: "e", startsAt, endsAt, rrule: p?.rrule ?? m.rrule, exdates: (p?.exdates ?? m.exdates) as string[] | null, allDay: m.allDay, timeZone: m.allDay ? null : MEL },
      WIN[0], WIN[1],
    ).map((o) => o.startsAt.toISOString());
  };

  it("每月 15 号拖到 16 号：日子写死，第一次还在，其余不变", () => {
    const m = master({ rrule: "FREQ=MONTHLY;BYMONTHDAY=15", startsAt: new Date("2026-11-14T22:30:00.000Z"), endsAt: new Date("2026-11-14T23:30:00.000Z") });
    const p = planSeriesEdit({ master: m, zone: MEL, sent: { startsAt: "2026-12-15T22:30:00.000Z" }, recurrenceId: "2026-12-14T22:30:00.000Z" });
    expect(startsOf(m, p)).toEqual(startsOf(m, null));
  });

  it("全天的每月 15 号同样", () => {
    const m = master({ allDay: true, rrule: "FREQ=MONTHLY;BYMONTHDAY=15", startsAt: new Date("2026-11-15T00:00:00.000Z"), endsAt: new Date("2026-11-15T23:59:59.999Z") });
    const p = planSeriesEdit({ master: m, zone: MEL, sent: { startsAt: "2026-12-16T00:00:00.000Z" }, recurrenceId: "2026-12-15T00:00:00.000Z" });
    expect(startsOf(m, p)).toEqual(startsOf(m, null));
  });

  it("每月第一个周一 09:30，拖到周三 10:30：日子不动，钟点平移，删过的那次还是删的", () => {
    const m = master({ rrule: "FREQ=MONTHLY;BYDAY=1MO", startsAt: new Date("2026-11-01T22:30:00.000Z"), endsAt: new Date("2026-11-01T23:30:00.000Z"), exdates: ["2027-01-03T22:30:00.000Z"] });
    const p = planSeriesEdit({ master: m, zone: MEL, sent: { startsAt: "2026-12-08T23:30:00.000Z", endsAt: "2026-12-09T00:30:00.000Z" }, recurrenceId: "2026-12-06T22:30:00.000Z" })!;
    expect(p.rrule).toBe("FREQ=MONTHLY;BYDAY=1MO");
    expect(p.exdates).toEqual(["2027-01-03T23:30:00.000Z"]);
    const before = startsOf(m, null);
    const after = startsOf(m, p);
    expect(after, "第一次、次数都不变，只是晚一小时").toEqual(before.map((s) => new Date(+new Date(s) + 3600_000).toISOString()));
  });

  it("每天 BYHOUR=9：钟点写死，改到 10 点不动（改了第一次会丢、删过的会回来）", () => {
    const m = master({ rrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0", startsAt: new Date("2026-10-25T22:00:00.000Z"), endsAt: new Date("2026-10-25T23:00:00.000Z"), exdates: ["2026-10-27T22:00:00.000Z"] });
    const p = planSeriesEdit({ master: m, zone: MEL, sent: { startsAt: "2026-11-15T23:00:00.000Z" }, recurrenceId: "2026-11-15T22:00:00.000Z" })!;
    expect(iso(p.startsAt)).toBe("2026-10-25T22:00:00.000Z");
    expect(p.exdates).toBeUndefined();
    expect(startsOf(m, p)).toEqual(startsOf(m, null));
  });

  it("隔周多天：转过 WKST 周次会错，日子不动", () => {
    const m = master({ rrule: "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE,FR;WKST=MO" });
    const p = planSeriesEdit({ master: m, zone: MEL, sent: { startsAt: "2026-11-21T22:30:00.000Z" }, recurrenceId: LATER });
    expect(startsOf(m, p)).toEqual(startsOf(m, null));
  });

  it("隔周单天：跟着转，周期不变", () => {
    const m = master({ rrule: "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO" });
    const p = planSeriesEdit({ master: m, zone: MEL, sent: { startsAt: "2026-11-16T22:30:00.000Z" }, recurrenceId: LATER })!;
    expect(p.rrule).toBe("FREQ=WEEKLY;INTERVAL=2;BYDAY=TU");
    const before = startsOf(m, null), after = startsOf(m, p);
    // 最后一次往后一天可能出了统计窗口，比前面这些就够了
    expect(after.slice(0, 8)).toEqual(before.slice(0, 8).map((s) => new Date(+new Date(s) + 86_400_000).toISOString()));
  });

  it("指定月份、BYSETPOS 也算日子写死", () => {
    for (const rrule of ["FREQ=WEEKLY;BYDAY=MO;BYMONTH=11,12", "FREQ=WEEKLY;BYDAY=MO,TU;BYSETPOS=-1"]) {
      const m = master({ rrule });
      const p = planSeriesEdit({ master: m, zone: MEL, sent: { startsAt: "2026-11-16T22:30:00.000Z" }, recurrenceId: LATER });
      expect(startsOf(m, p), rrule).toEqual(startsOf(m, null));
    }
  });
});

describe("UNTIL 的几种写法都跟着挪，最后一次不丢", () => {
  const WIN: [Date, Date] = [new Date("2026-10-01T00:00:00Z"), new Date("2027-03-01T00:00:00Z")];

  it("只有日期（全天系列的 RFC 写法）", () => {
    const m = master({ allDay: true, rrule: "FREQ=WEEKLY;UNTIL=20261123", startsAt: new Date("2026-11-02T00:00:00.000Z"), endsAt: new Date("2026-11-02T23:59:59.999Z") });
    const p = planSeriesEdit({ master: m, zone: MEL, sent: { startsAt: "2026-11-10T00:00:00.000Z" }, recurrenceId: "2026-11-09T00:00:00.000Z" })!;
    expect(p.rrule).toBe("FREQ=WEEKLY;UNTIL=20261124");
    const n = expandEvent({ id: "e", startsAt: p.startsAt!, endsAt: p.endsAt!, rrule: p.rrule!, allDay: true, timeZone: null }, WIN[0], WIN[1]);
    expect(n).toHaveLength(4);
  });

  it("浮动写法（不带 Z）", () => {
    const m = master({ rrule: "FREQ=WEEKLY;UNTIL=20261130T093000" });
    const p = planSeriesEdit({ master: m, zone: MEL, sent: { startsAt: "2026-11-15T23:30:00.000Z" }, recurrenceId: LATER })!;
    expect(p.rrule).toBe("FREQ=WEEKLY;UNTIL=20261130T103000");
  });
});

describe("全天事件：老页面发来本地午夜，差值只是时区偏移", () => {
  for (const [zone, ref] of [["新西兰夏令时 +13", "2026-11-15T11:00:00.000Z"], ["基里巴斯 +14", "2026-11-15T10:00:00.000Z"], ["夏威夷 -10", "2026-11-16T10:00:00.000Z"]] as const) {
    it(`${zone}：不算挪动`, () => {
      const m = master({ allDay: true, rrule: "FREQ=WEEKLY", startsAt: new Date("2026-10-26T00:00:00.000Z"), endsAt: new Date("2026-10-26T23:59:59.999Z") });
      const p = planSeriesEdit({ master: m, zone: "UTC", sent: { startsAt: "2026-11-16T00:00:00.000Z", endsAt: "2026-11-16T23:59:59.999Z" }, recurrenceId: ref })!;
      expect(iso(p.startsAt)).toBe("2026-10-26T00:00:00.000Z");
    });
  }

  it("跨夏令时拖两天，差值 47 小时：算 2 天", () => {
    const m = master({ allDay: true, rrule: "FREQ=WEEKLY", startsAt: new Date("2026-10-26T00:00:00.000Z"), endsAt: new Date("2026-10-26T23:59:59.999Z") });
    const p = planSeriesEdit({ master: m, zone: "UTC", sent: { startsAt: "2026-11-18T00:00:00.000Z" }, recurrenceId: "2026-11-16T01:00:00.000Z" })!;
    expect(iso(p.startsAt)).toBe("2026-10-28T00:00:00.000Z");
  });
});

describe("平移按墙上时间算", () => {
  it("墨尔本：09-28 09:00（AEST）拖到 10-05 09:00（AEDT），时间不变，exdate 对得上", () => {
    const m = master({ startsAt: new Date("2026-09-27T23:00:00.000Z"), endsAt: new Date("2026-09-28T00:00:00.000Z"), rrule: "FREQ=WEEKLY", exdates: ["2026-09-27T23:00:00.000Z", "2026-10-11T22:00:00.000Z"] });
    const p = planSeriesEdit({ master: m, zone: MEL, sent: { startsAt: "2026-10-04T22:00:00.000Z" }, recurrenceId: "2026-09-27T23:00:00.000Z" })!;
    expect(iso(p.startsAt)).toBe("2026-10-04T22:00:00.000Z");
    expect(p.exdates).toEqual(["2026-10-04T22:00:00.000Z", "2026-10-18T22:00:00.000Z"]);
  });

  it("纽约：10-26 20:00（EDT）拖到 11-02 20:00（EST）同理", () => {
    const m = master({ startsAt: new Date("2026-10-27T00:00:00.000Z"), endsAt: new Date("2026-10-27T01:00:00.000Z"), rrule: "FREQ=WEEKLY" });
    const p = planSeriesEdit({ master: m, zone: NY, sent: { startsAt: "2026-11-03T01:00:00.000Z" }, recurrenceId: "2026-10-27T00:00:00.000Z" })!;
    expect(iso(p.startsAt)).toBe("2026-11-03T01:00:00.000Z");
  });

  it("时长按真实时刻：跨夏令时的事件不差一小时", () => {
    const p = planSeriesEdit({ master: master(), zone: MEL, sent: { startsAt: "2026-11-15T23:00:00.000Z", endsAt: "2026-11-16T01:00:00.000Z" }, recurrenceId: LATER })!;
    expect(p.endsAt!.getTime() - p.startsAt!.getTime()).toBe(2 * 3600_000);
  });
});

describe("照发来的存（返回 null）", () => {
  it("清除重复（规则发空串）", () => {
    expect(planSeriesEdit({ master: master(), zone: MEL, sent: { startsAt: LATER, rrule: "" }, recurrenceId: LATER })).toBeNull();
  });
  it("规则真的换了", () => {
    expect(planSeriesEdit({ master: master(), zone: MEL, sent: { startsAt: LATER, rrule: "FREQ=DAILY" }, recurrenceId: LATER })).toBeNull();
  });
  it("全天和定时互换", () => {
    expect(planSeriesEdit({ master: master(), zone: MEL, sent: { startsAt: LATER, allDay: true }, recurrenceId: LATER })).toBeNull();
  });
  it("不重复的事件", () => {
    expect(planSeriesEdit({ master: master({ rrule: null }), zone: MEL, sent: { startsAt: LATER }, recurrenceId: LATER })).toBeNull();
  });
  it("没有 recurrenceId、也不是系列里的一次（改的就是主事件）", () => {
    expect(planSeriesEdit({ master: master(), zone: MEL, sent: { startsAt: "2026-10-26T22:30:00.000Z" } })).toBeNull();
  });
  it("只发结束时刻又不知道是哪一次", () => {
    expect(planSeriesEdit({ master: master(), zone: MEL, sent: { endsAt: "2026-10-26T00:30:00.000Z" } })).toBeNull();
  });
});

describe("sameRule：桌面端重建规则不算换规则", () => {
  it("去掉 INTERVAL=1、UNTIL 同一天、顺序不同：同一条", () => {
    expect(sameRule("FREQ=WEEKLY;BYDAY=MO;UNTIL=20261129T223000Z", "FREQ=WEEKLY;INTERVAL=1;UNTIL=20261129T235959Z;BYDAY=MO")).toBe(true);
  });
  it("真的不同：不是同一条", () => {
    expect(sameRule("FREQ=WEEKLY;BYDAY=MO", "FREQ=WEEKLY;BYDAY=TU")).toBe(false);
    expect(sameRule("FREQ=WEEKLY;INTERVAL=2", "FREQ=WEEKLY")).toBe(false);
    expect(sameRule("FREQ=WEEKLY;UNTIL=20261129T223000Z", "FREQ=WEEKLY;UNTIL=20261130T223000Z")).toBe(false);
  });
});
