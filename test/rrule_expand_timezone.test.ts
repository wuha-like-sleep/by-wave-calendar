import { describe, it, expect } from "vitest";
import { expandEvent, type EventForExpansion } from "../src/lib/rrule_expand.js";

// 重复事件按**事件自己的时区**展开。
//
// 以前 DTSTART 写成 UTC 交给 rrule，BYDAY / BYMONTHDAY 全按 UTC 的日历算：
// 墨尔本周一 9:30（= UTC 周日 22:30）的「每周一」画在周二；不带 BY* 的「每周」
// 按固定的 UTC 间隔走，夏令时一切换，9:30 变 10:30。
//
// 断言一律按「那个时区的人看到的周几、几点」来写（Intl 换算），不写死 UTC 时刻：
// 写死 UTC 的话，测试和被测代码犯同一个错也能对上。
// 测试本身不依赖进程时区（TZ=Asia/Shanghai / America/New_York 下跑结果一样）。

const D = (iso: string) => new Date(iso);

function local(d: Date, tz: string): { weekday: string; time: string; day: number; ymd: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return {
    weekday: get("weekday"),
    time: `${get("hour")}:${get("minute")}`,
    day: Number(get("day")),
    ymd: `${get("year")}-${get("month")}-${get("day")}`,
  };
}

function ev(over: Partial<EventForExpansion> & Pick<EventForExpansion, "startsAt" | "rrule">): EventForExpansion {
  return {
    id: "e",
    endsAt: new Date(over.startsAt.getTime() + 60 * 60 * 1000),
    allDay: false,
    timeZone: null,
    ...over,
  };
}

const MEL = "Australia/Melbourne";
const SHA = "Asia/Shanghai";
const NYC = "America/New_York";

describe("BYDAY 按事件时区的周几", () => {
  it("墨尔本周一 9:30「每周一」12 次：全部是墨尔本的周一 9:30（跨 10-04 进夏令时）", () => {
    // 2026-09-28 周一 09:30 AEST（UTC+10）= 2026-09-27T23:30Z（UTC 周日）
    const out = expandEvent(
      ev({ startsAt: D("2026-09-27T23:30:00Z"), rrule: "FREQ=WEEKLY;BYDAY=MO;COUNT=12", timeZone: MEL }),
      D("2026-09-01T00:00:00Z"), D("2027-01-31T00:00:00Z"),
    );
    expect(out, "COUNT=12 应该恰好 12 次").toHaveLength(12);
    for (const o of out) {
      const l = local(o.startsAt, MEL);
      expect(`${l.ymd} ${l.weekday} ${l.time}`, "落到了别的日子或别的钟点").toMatch(/ Mon 09:30$/);
    }
    // 第一次就是主事件本身
    expect(out[0]!.startsAt.toISOString()).toBe("2026-09-27T23:30:00.000Z");
    expect(out[0]!.isOccurrence).toBe(false);
    expect(out[1]!.isOccurrence).toBe(true);
  });

  it("北京周一 07:00「每周一」：北京的周一（UTC 还是周日）", () => {
    // 2026-10-05 周一 07:00 CST = 2026-10-04T23:00Z
    const out = expandEvent(
      ev({ startsAt: D("2026-10-04T23:00:00Z"), rrule: "FREQ=WEEKLY;BYDAY=MO", timeZone: SHA }),
      D("2026-10-01T00:00:00Z"), D("2026-11-01T00:00:00Z"),
    );
    expect(out.length).toBe(4);
    for (const o of out) expect(local(o.startsAt, SHA).weekday + " " + local(o.startsAt, SHA).time).toBe("Mon 07:00");
  });

  it("纽约周一 20:00「每周一」：纽约的周一（UTC 已经是周二），跨 11-01 出夏令时照样 20:00", () => {
    // 2026-10-05 周一 20:00 EDT（UTC-4）= 2026-10-06T00:00Z
    const out = expandEvent(
      ev({ startsAt: D("2026-10-06T00:00:00Z"), rrule: "FREQ=WEEKLY;BYDAY=MO", timeZone: NYC }),
      D("2026-10-01T00:00:00Z"), D("2026-11-20T00:00:00Z"),
    );
    expect(out.length).toBe(7);
    for (const o of out) expect(local(o.startsAt, NYC).weekday + " " + local(o.startsAt, NYC).time).toBe("Mon 20:00");
    // 夏令时前后对应的 UTC 小时确实不一样（00:00Z → 01:00Z），说明不是按固定 UTC 间隔走的。
    expect(new Set(out.map((o) => o.startsAt.getUTCHours()))).toEqual(new Set([0, 1]));
  });
});

describe("夏令时：墙上时间不动", () => {
  it("墨尔本每周 9:30（不带 BYDAY），跨 2026-10-04 前后都是 9:30", () => {
    // 2026-09-21 周一 09:30 AEST = 2026-09-20T23:30Z
    const out = expandEvent(
      ev({ startsAt: D("2026-09-20T23:30:00Z"), rrule: "FREQ=WEEKLY", timeZone: MEL }),
      D("2026-09-01T00:00:00Z"), D("2026-10-31T00:00:00Z"),
    );
    expect(out.map((o) => local(o.startsAt, MEL).ymd)).toEqual([
      "2026-09-21", "2026-09-28", "2026-10-05", "2026-10-12", "2026-10-19", "2026-10-26",
    ]);
    for (const o of out) expect(local(o.startsAt, MEL).time, "夏令时之后挪了一小时").toBe("09:30");
    // 切换前 23:30Z、切换后 22:30Z
    expect(out[1]!.startsAt.toISOString()).toBe("2026-09-27T23:30:00.000Z");
    expect(out[2]!.startsAt.toISOString()).toBe("2026-10-04T22:30:00.000Z");
  });

  it("COUNT 跨夏令时：恰好 COUNT 次，每次都是 9:30", () => {
    const out = expandEvent(
      ev({ startsAt: D("2026-09-20T23:30:00Z"), rrule: "FREQ=WEEKLY;COUNT=5", timeZone: MEL }),
      D("2026-09-01T00:00:00Z"), D("2027-12-31T00:00:00Z"),
    );
    expect(out).toHaveLength(5);
    expect(out.map((o) => local(o.startsAt, MEL).time)).toEqual(["09:30", "09:30", "09:30", "09:30", "09:30"]);
  });

  it("夏令时跳过的时刻往后顺延（02:30 → 03:30），拨回重叠的时刻取第一次", () => {
    // 墨尔本每天 02:30，从 2026-10-02 起 4 次：10-04 那天 02:00–03:00 不存在
    const gap = expandEvent(
      ev({ startsAt: D("2026-10-01T16:30:00Z"), rrule: "FREQ=DAILY;COUNT=4", timeZone: MEL }),
      D("2026-09-30T00:00:00Z"), D("2026-10-10T00:00:00Z"),
    );
    expect(gap.map((o) => `${local(o.startsAt, MEL).ymd} ${local(o.startsAt, MEL).time}`)).toEqual([
      "2026-10-02 02:30", "2026-10-03 02:30", "2026-10-04 03:30", "2026-10-05 02:30",
    ]);
    // 2027-04-04 02:00–03:00 出现两次：取第一次（还在夏令时，UTC+11 → 15:30Z）
    const overlap = expandEvent(
      ev({ startsAt: D("2027-04-01T15:30:00Z"), rrule: "FREQ=DAILY;COUNT=4", timeZone: MEL }),
      D("2027-03-30T00:00:00Z"), D("2027-04-10T00:00:00Z"),
    );
    expect(overlap.map((o) => o.startsAt.toISOString())).toEqual([
      "2027-04-01T15:30:00.000Z", "2027-04-02T15:30:00.000Z", "2027-04-03T15:30:00.000Z", "2027-04-04T16:30:00.000Z",
    ]);
  });
});

describe("常见规则", () => {
  it("每个工作日 FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR：墨尔本 08:00 的周一到周五，两周 10 次", () => {
    // 2026-09-28 周一 08:00 AEST = 2026-09-27T22:00Z（UTC 周日）
    const out = expandEvent(
      ev({ startsAt: D("2026-09-27T22:00:00Z"), rrule: "FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR", timeZone: MEL }),
      D("2026-09-27T00:00:00Z"), D("2026-10-10T12:00:00Z"),
    );
    expect(out.map((o) => local(o.startsAt, MEL).weekday)).toEqual([
      "Mon", "Tue", "Wed", "Thu", "Fri", "Mon", "Tue", "Wed", "Thu", "Fri",
    ]);
    for (const o of out) expect(local(o.startsAt, MEL).time).toBe("08:00");
  });

  it("每月第一个周一 FREQ=MONTHLY;BYDAY=1MO：墨尔本每月 1–7 号之间的周一 9:30", () => {
    // 2026-10-05 周一 09:30 AEDT = 2026-10-04T22:30Z
    const out = expandEvent(
      ev({ startsAt: D("2026-10-04T22:30:00Z"), rrule: "FREQ=MONTHLY;BYDAY=1MO;COUNT=6", timeZone: MEL }),
      D("2026-10-01T00:00:00Z"), D("2027-06-01T00:00:00Z"),
    );
    expect(out.map((o) => local(o.startsAt, MEL).ymd)).toEqual([
      "2026-10-05", "2026-11-02", "2026-12-07", "2027-01-04", "2027-02-01", "2027-03-01",
    ]);
    for (const o of out) {
      const l = local(o.startsAt, MEL);
      expect(l.weekday).toBe("Mon");
      expect(l.day).toBeLessThanOrEqual(7);
      expect(l.time).toBe("09:30");
    }
  });

  it("UNTIL 是一个真实时刻、含边界：恰好卡在第 4 次上就是 4 次，早一秒就是 3 次", () => {
    // 第 4 次 = 2026-10-19 周一 09:30 AEDT = 2026-10-18T22:30Z
    const base = { startsAt: D("2026-09-27T23:30:00Z"), timeZone: MEL };
    const at = expandEvent(
      ev({ ...base, rrule: "FREQ=WEEKLY;BYDAY=MO;UNTIL=20261018T223000Z" }),
      D("2026-09-01T00:00:00Z"), D("2027-01-01T00:00:00Z"),
    );
    expect(at.map((o) => local(o.startsAt, MEL).ymd)).toEqual(["2026-09-28", "2026-10-05", "2026-10-12", "2026-10-19"]);
    const before = expandEvent(
      ev({ ...base, rrule: "FREQ=WEEKLY;BYDAY=MO;UNTIL=20261018T222959Z" }),
      D("2026-09-01T00:00:00Z"), D("2027-01-01T00:00:00Z"),
    );
    expect(before.map((o) => local(o.startsAt, MEL).ymd)).toEqual(["2026-09-28", "2026-10-05", "2026-10-12"]);
  });

  it("exdates 按真实时刻扣：扣掉的是墨尔本 10-12 那一次", () => {
    const out = expandEvent(
      ev({
        startsAt: D("2026-09-27T23:30:00Z"), rrule: "FREQ=WEEKLY;BYDAY=MO;COUNT=4", timeZone: MEL,
        exdates: ["2026-10-11T22:30:00.000Z"],
      }),
      D("2026-09-01T00:00:00Z"), D("2027-01-01T00:00:00Z"),
    );
    expect(out.map((o) => local(o.startsAt, MEL).ymd)).toEqual(["2026-09-28", "2026-10-05", "2026-10-19"]);
  });

  it("窗口只截一段：从中间开始的窗口里也是周一 9:30，跨窗口起点的那次（开始在前、结束在后）也算", () => {
    const out = expandEvent(
      ev({ startsAt: D("2026-09-27T23:30:00Z"), rrule: "FREQ=WEEKLY;BYDAY=MO", timeZone: MEL }),
      // 窗口起点落在 11-16 那次的中间（09:30–10:30 AEDT = 22:30–23:30Z 11-15）
      D("2026-11-15T23:00:00Z"), D("2026-11-29T12:00:00Z"),
    );
    expect(out.map((o) => local(o.startsAt, MEL).ymd)).toEqual(["2026-11-16", "2026-11-23"]);
  });
});

describe("不该变的", () => {
  it("全天重复事件不管传什么时区，都按 UTC 日期展开（和以前一个字节不差）", () => {
    // 全天存的是 UTC 午夜。2026-10-05（周一）每周一次。
    const allDay = (timeZone: string | null) => expandEvent(
      {
        id: "a", startsAt: D("2026-10-05T00:00:00Z"), endsAt: D("2026-10-05T23:59:59.999Z"),
        rrule: "FREQ=WEEKLY;BYDAY=MO;COUNT=4", allDay: true, timeZone,
      },
      D("2026-10-01T00:00:00Z"), D("2026-11-30T00:00:00Z"),
    ).map((o) => o.startsAt.toISOString());
    const expected = ["2026-10-05T00:00:00.000Z", "2026-10-12T00:00:00.000Z", "2026-10-19T00:00:00.000Z", "2026-10-26T00:00:00.000Z"];
    expect(allDay(null)).toEqual(expected);
    expect(allDay(NYC), "UTC 以西的时区把全天事件挪到了前一天").toEqual(expected);
    expect(allDay(MEL)).toEqual(expected);
  });

  it("非法时区名回落 UTC（不报错、不挪到别的时区）", () => {
    const run = (timeZone: string | null) => expandEvent(
      ev({ startsAt: D("2026-09-27T23:30:00Z"), rrule: "FREQ=WEEKLY;BYDAY=MO;COUNT=3", timeZone }),
      D("2026-09-01T00:00:00Z"), D("2027-01-01T00:00:00Z"),
    ).map((o) => o.startsAt.toISOString());
    // UTC 下 BYDAY=MO 是 UTC 的周一（DTSTART 本身是 UTC 周日，不算一次）
    const utc = ["2026-09-28T23:30:00.000Z", "2026-10-05T23:30:00.000Z", "2026-10-12T23:30:00.000Z"];
    expect(run(null)).toEqual(utc);
    expect(run("UTC")).toEqual(utc);
    expect(run("Mars/Olympus_Mons")).toEqual(utc);
    expect(run("")).toEqual(utc);
  });

  it("上限照旧：带时区的每天一次跨三年，最多 366 次", () => {
    const out = expandEvent(
      ev({ startsAt: D("2026-01-01T09:00:00Z"), rrule: "FREQ=DAILY", timeZone: MEL }),
      D("2026-01-01T00:00:00Z"), D("2029-01-01T00:00:00Z"),
    );
    expect(out).toHaveLength(366);
  });

  it("FREQ=SECONDLY 带时区也被上限挡住，很快返回", () => {
    const t0 = Date.now();
    const out = expandEvent(
      ev({ startsAt: D("2026-06-01T00:00:00Z"), rrule: "FREQ=SECONDLY", timeZone: MEL }),
      D("2026-06-01T00:00:00Z"), D("2026-07-01T00:00:00Z"),
    );
    expect(out.length).toBeLessThanOrEqual(366);
    expect(out.length).toBeGreaterThan(0);
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});
