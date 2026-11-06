import { describe, it, expect } from "vitest";
import { planSeriesEdit, sameRule, type SeriesEditInput } from "../src/lib/series_edit.js";

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
