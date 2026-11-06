import { describe, it, expect, afterEach } from "vitest";
import { __setFastForwardForTest, expandEvent, seriesStartsBetween } from "../src/lib/rrule_expand.js";

// 展开时把 DTSTART 跳到窗口附近（rrule_expand.ts 的 fastForwarded）。这是纯优化：
// 窗口里的结果必须和「老老实实从第一次数起」逐条相同。这里不写死日子，拿两条路互相对照，
// 覆盖规则形状 × 开始时刻 × 时区 × 窗口（故意包括夏令时切换、月底、闰日）。

const MEL = "Australia/Melbourne";
const ZONES = [null, MEL, "America/New_York", "Asia/Shanghai", "Australia/Lord_Howe", "Europe/London"];

const STARTS = [
  "2019-03-31T01:30:00.000Z",   // 周日，欧洲进夏令时那天
  "2020-02-29T22:30:00.000Z",   // 闰日
  "2021-01-31T15:45:30.000Z",   // 月底，带秒
  "2024-10-05T16:30:00.000Z",   // 墨尔本进夏令时前一晚
  "2025-11-02T05:30:00.000Z",   // 纽约拨回那一小时
];

// 小时级以下的规则从头数很慢（这正是要优化的），对照时开始日期放近一点，时区少几个。
const RECENT_STARTS = ["2026-03-01T01:30:00.000Z", "2026-09-07T15:45:30.000Z"];
const SUB_DAILY_ZONES = [null, MEL, "America/New_York"];
const isSubDaily = (rule: string) => /FREQ=(HOURLY|MINUTELY|SECONDLY)/.test(rule);

const RULES = [
  "FREQ=DAILY",
  "FREQ=DAILY;INTERVAL=3",
  "FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR",
  "FREQ=DAILY;BYHOUR=9,17;BYMINUTE=0;BYSECOND=0",
  "FREQ=DAILY;BYMONTH=1,7",
  "FREQ=DAILY;BYMONTHDAY=1,15,31",
  "FREQ=WEEKLY",
  "FREQ=WEEKLY;INTERVAL=2",
  "FREQ=WEEKLY;INTERVAL=2;WKST=SU",
  "FREQ=WEEKLY;INTERVAL=3;WKST=SA;BYDAY=SU,MO",
  "FREQ=WEEKLY;BYDAY=MO",
  "FREQ=WEEKLY;BYDAY=SU",
  "FREQ=WEEKLY;BYDAY=MO,WE,FR",
  "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1",
  "FREQ=WEEKLY;BYDAY=MO,TU;BYHOUR=8,20",
  "FREQ=WEEKLY;UNTIL=20261115T000000Z",
  "FREQ=DAILY;UNTIL=20261103T120000Z",
  "FREQ=HOURLY;INTERVAL=5",
  "FREQ=HOURLY;BYHOUR=9,10,11;BYDAY=MO",
  "FREQ=HOURLY;INTERVAL=7;BYHOUR=1,8,15,22",
  "FREQ=MINUTELY;INTERVAL=90;BYMINUTE=0,30",
  "FREQ=MINUTELY;INTERVAL=60;BYDAY=MO",
  "FREQ=SECONDLY;INTERVAL=3600;BYSECOND=0",
  "FREQ=SECONDLY;INTERVAL=5400;BYDAY=TU",
  // 这几种的相位取决于从头数的路径（rrule 库的毛病），跳了结果就变。不能跳，这里盯着。
  "FREQ=MINUTELY;INTERVAL=45;BYHOUR=9,10",
  "FREQ=SECONDLY;INTERVAL=45;BYHOUR=9",
  "FREQ=SECONDLY;INTERVAL=45;BYMINUTE=0,15",
  // 不会跳的那几种也要相同（跳跃不许碰它们）
  "FREQ=MONTHLY",
  "FREQ=MONTHLY;BYDAY=1MO",
  "FREQ=MONTHLY;BYMONTHDAY=-1",
  "FREQ=YEARLY",
  "FREQ=WEEKLY;COUNT=400",
  "FREQ=DAILY;COUNT=2500;BYDAY=MO",
];

const WINDOWS: Array<[string, string]> = [
  ["2026-11-02T00:00:00Z", "2026-11-09T00:00:00Z"],   // 普通的一周（含纽约 11-01 拨回之后）
  ["2026-10-01T00:00:00Z", "2026-10-08T00:00:00Z"],   // 跨墨尔本 10-04 进夏令时
  ["2026-03-27T00:00:00Z", "2026-03-31T00:00:00Z"],   // 跨欧洲 03-29 进夏令时
  ["2028-02-26T00:00:00Z", "2028-03-03T00:00:00Z"],   // 跨闰日
  ["2026-12-28T00:00:00Z", "2027-01-06T00:00:00Z"],   // 跨年（周编号边界）
];

afterEach(() => __setFastForwardForTest(true));

const toIso = (d: Date) => d.toISOString();

function both<T>(fn: () => T): { fast: T; slow: T } {
  __setFastForwardForTest(true);
  const fast = fn();
  __setFastForwardForTest(false);
  const slow = fn();
  __setFastForwardForTest(true);
  return { fast, slow };
}

// 「从头数」那一路本来就慢（这正是要优化的），机器忙的时候单条会过默认的 5 秒。
describe("跳到窗口附近再数：结果和从头数逐条相同", { timeout: 120_000 }, () => {
  for (const rrule of RULES) {
    it(rrule, () => {
      let compared = 0;
      for (const startIso of isSubDaily(rrule) ? RECENT_STARTS : STARTS) {
        const startsAt = new Date(startIso);
        const endsAt = new Date(startsAt.getTime() + 3600_000);
        for (const timeZone of isSubDaily(rrule) ? SUB_DAILY_ZONES : ZONES) {
          for (const [a, b] of WINDOWS) {
            const from = new Date(a), to = new Date(b);
            const { fast, slow } = both(() => expandEvent(
              { id: "e", startsAt, endsAt, rrule, allDay: false, timeZone }, from, to,
            ).map((o) => [toIso(o.startsAt), toIso(o.endsAt), o.isOccurrence]));
            expect(fast, `${startIso} ${timeZone} ${a}`).toEqual(slow);
            compared += slow.length;
          }
        }
      }
      // 防判空：这条规则确实在这些窗口里出过结果（UNTIL 那两条早于部分窗口，但不会全空）
      expect(compared, "一次都没展开出来，这条对照什么也没验到").toBeGreaterThan(0);
    });
  }

  it("全天事件（按 UTC 那条路）也相同", () => {
    const startsAt = new Date("2021-03-01T00:00:00.000Z");
    const endsAt = new Date("2021-03-01T23:59:59.999Z");
    for (const rrule of ["FREQ=DAILY", "FREQ=WEEKLY;BYDAY=MO", "FREQ=WEEKLY;INTERVAL=2", "FREQ=DAILY;INTERVAL=5"]) {
      let compared = 0;
      for (const [a, b] of WINDOWS) {
        const { fast, slow } = both(() => expandEvent(
          { id: "e", startsAt, endsAt, rrule, allDay: true, timeZone: MEL }, new Date(a), new Date(b),
        ).map((o) => toIso(o.startsAt)));
        expect(fast).toEqual(slow);
        compared += slow.length;
      }
      expect(compared, rrule).toBeGreaterThan(0);
    }
  });

  it("窗口包住第一次、或者紧贴第一次：不跳，第一次还是主事件本身", () => {
    const startsAt = new Date("2026-11-02T22:30:00.123Z");
    const endsAt = new Date(startsAt.getTime() + 3600_000);
    for (const [a, b] of [["2026-11-01T00:00:00Z", "2026-11-10T00:00:00Z"], ["2026-11-03T00:00:00Z", "2026-11-20T00:00:00Z"]] as const) {
      const { fast, slow } = both(() => expandEvent(
        { id: "e", startsAt, endsAt, rrule: "FREQ=DAILY", allDay: false, timeZone: MEL }, new Date(a), new Date(b),
      ).map((o) => toIso(o.startsAt)));
      expect(fast).toEqual(slow);
    }
  });

  it("seriesStartsBetween（迁移和改时区用的）同一条路", () => {
    const startsAt = new Date("2020-01-06T22:30:00.000Z");
    for (const timeZone of [null, MEL]) {
      const { fast, slow } = both(() => seriesStartsBetween(
        { startsAt, rrule: "FREQ=WEEKLY;INTERVAL=2;BYDAY=TU", allDay: false, timeZone },
        new Date("2026-06-01T00:00:00Z"), new Date("2026-12-01T00:00:00Z"), 200_000,
      )!.map(toIso));
      expect(fast).toEqual(slow);
      expect(slow.length).toBeGreaterThan(5);
    }
  });
});

describe("跳了之后确实快：密集规则不再把进程卡住", () => {
  const MIN = "FREQ=MINUTELY";
  const startsAt = new Date("2020-01-06T22:30:00.000Z");
  const endsAt = new Date(startsAt.getTime() + 60_000);

  it("2020 年开始的「每分钟」看一周：几十毫秒内给满上限（以前要 4.8 秒）", () => {
    const t0 = performance.now();
    const occ = expandEvent(
      { id: "e", startsAt, endsAt, rrule: MIN, allDay: false, timeZone: MEL },
      new Date("2026-11-02T00:00:00Z"), new Date("2026-11-09T00:00:00Z"),
    );
    expect(occ).toHaveLength(366);
    // 窗口往前多算一个事件时长（一分钟）：开始于窗口前、还没结束的那次也算。
    expect(occ[0]!.startsAt.toISOString()).toBe("2026-11-01T23:59:00.000Z");
    expect(performance.now() - t0, "又回到从头数了").toBeLessThan(1500);
  });

  it("FREQ=SECONDLY 同样", () => {
    const t0 = performance.now();
    const occ = expandEvent(
      { id: "e", startsAt, endsAt, rrule: "FREQ=SECONDLY", allDay: false, timeZone: null },
      new Date("2026-11-02T00:00:00Z"), new Date("2026-11-09T00:00:00Z"),
    );
    expect(occ).toHaveLength(366);
    expect(performance.now() - t0).toBeLessThan(1500);
  });
});
