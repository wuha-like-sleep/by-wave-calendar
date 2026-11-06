import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { expandEvent } from "../src/lib/rrule_expand.js";

// rrule 字符串是用户和订阅源写的。有些规则 rrule 库数不完：小时级以下的 for (;;) 碰不上就是
// 死循环，整个进程卡死、不会自己恢复；日期上不可能的条件要数到 9999 年，「每天」每次 3 秒多。
// 这些规则要在交给 rrule 库之前拦下来，只显示主事件。

const MEL = "Australia/Melbourne";
const EVEN_HOUR = "2026-09-07T16:00:00.000Z";     // UTC 16 点
const AT_45M = "2026-09-07T15:45:00.000Z";
const AT_30S = "2026-09-07T15:45:30.000Z";

// 守卫漏了的话这里每一条都可能永远回不来
const HAZARDS: Array<{ start: string; rule: string; tz: string | null; why: string }> = [
  { start: EVEN_HOUR, rule: "FREQ=HOURLY;INTERVAL=2;BYHOUR=1", tz: null, why: "偶数点开始，每 2 小时，永远到不了 1 点" },
  { start: EVEN_HOUR, rule: "FREQ=HOURLY;BYHOUR=25", tz: null, why: "没有 25 点" },
  { start: AT_45M, rule: "FREQ=MINUTELY;INTERVAL=60;BYMINUTE=30", tz: null, why: "每小时的 45 分，永远到不了 30 分" },
  { start: AT_45M, rule: "FREQ=MINUTELY;BYMINUTE=61", tz: null, why: "没有 61 分" },
  { start: AT_45M, rule: "FREQ=MINUTELY;INTERVAL=120;BYHOUR=1", tz: null, why: "进位一次跳两小时" },
  { start: AT_45M, rule: "FREQ=MINUTELY;BYHOUR=24", tz: null, why: "没有 24 点" },
  { start: AT_30S, rule: "FREQ=SECONDLY;INTERVAL=3600;BYSECOND=0", tz: null, why: "每小时的 30 秒，永远到不了 0 秒" },
  { start: AT_30S, rule: "FREQ=SECONDLY;BYSECOND=60", tz: null, why: "没有 60 秒" },
  { start: AT_30S, rule: "FREQ=SECONDLY;INTERVAL=7200;BYHOUR=1", tz: null, why: "进位一次跳两小时" },
  { start: AT_30S, rule: "FREQ=SECONDLY;INTERVAL=3600;BYMINUTE=1", tz: null, why: "进位一次跳一小时" },
  { start: EVEN_HOUR, rule: "FREQ=DAILY;INTERVAL=-1", tz: null, why: "负的间隔往回数" },
  { start: "2020-01-01T00:00:00.000Z", rule: "FREQ=SECONDLY;COUNT=2000000000", tz: null, why: "COUNT 不能跳，从头数几亿次" },
  { start: "2020-01-01T00:00:00.000Z", rule: "FREQ=SECONDLY;BYHOUR=9", tz: null, why: "结果取决于路径不能跳，从头数几百万次" },
  { start: EVEN_HOUR, rule: "FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30", tz: null, why: "2 月 30 日" },
  { start: EVEN_HOUR, rule: "FREQ=HOURLY;BYMONTH=2;BYMONTHDAY=30", tz: null, why: "2 月 30 日，小时级" },
  { start: EVEN_HOUR, rule: "FREQ=WEEKLY;BYMONTH=4;BYMONTHDAY=31", tz: null, why: "4 月 31 日" },
  { start: EVEN_HOUR, rule: "FREQ=DAILY;BYMONTH=13", tz: null, why: "13 月" },
  { start: EVEN_HOUR, rule: "FREQ=DAILY;BYMONTHDAY=32", tz: null, why: "32 号" },
  { start: EVEN_HOUR, rule: "FREQ=DAILY;BYYEARDAY=1;BYMONTH=6", tz: null, why: "一年第 1 天不在 6 月" },
  { start: EVEN_HOUR, rule: "FREQ=WEEKLY;BYWEEKNO=1;BYMONTH=6", tz: null, why: "第 1 周不在 6 月" },
  { start: EVEN_HOUR, rule: "FREQ=DAILY;BYSETPOS=3", tz: null, why: "一天只有一个候选" },
  { start: EVEN_HOUR, rule: "FREQ=WEEKLY;BYDAY=MO;BYSETPOS=3", tz: null, why: "一周只有一个候选" },
  // 判断要看实际展开用的时钟：UTC 16:00（偶数点，按 UTC 碰得上）= 墨尔本 03:00（奇数点，碰不上）
  { start: "2026-10-26T16:00:00.000Z", rule: "FREQ=HOURLY;INTERVAL=2;BYHOUR=2", tz: MEL, why: "墨尔本 3 点开始，奇数点，到不了 2 点" },
];

type ChildLine = { rule: string; tz: string | null; n: number; ms: number; series: number | null };

function runChild(cases: Array<{ start: string; rule: string; tz: string | null }>) {
  const run = spawnSync(
    process.execPath,
    ["--import", "tsx", path.resolve("test/fixtures/rrule_hazards_child.ts"), JSON.stringify(cases)],
    { encoding: "utf8", timeout: 60_000, killSignal: "SIGKILL" },
  );
  const lines = run.stdout.split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l) as ChildLine);
  return { run, lines };
}

describe("数不完的规则不交给 rrule 库", () => {
  const { run, lines } = runChild(HAZARDS.map(({ start, rule, tz }) => ({ start, rule, tz })));

  it("子进程跑完了（有一条死循环就回不来，超时被杀）", () => {
    const stuck = HAZARDS[lines.length];
    expect(run.signal, stuck ? `卡在这一条：${stuck.rule}（${stuck.why}）` : run.stderr.slice(0, 400)).toBeNull();
    expect(lines).toHaveLength(HAZARDS.length);
  });

  HAZARDS.forEach((h, i) => {
    it(`${h.rule} — ${h.why}`, () => {
      const got = lines[i];
      expect(got, "没算到这一条").toBeTruthy();
      // 没拦住的话最少要 3 秒（数到 9999 年），机器再忙也分得开。
      expect(got!.ms, "拦住了就不该花时间").toBeLessThan(1500);
      // 只显示主事件：主事件不在这个窗口里，所以是 0 条。
      expect(got!.n).toBe(0);
    });
  });
});

describe("拦下的规则：主事件照常显示（同样在子进程里算）", () => {
  const out = runChild([
    { start: "2026-11-03T16:00:00.000Z", rule: "FREQ=HOURLY;INTERVAL=2;BYHOUR=1", tz: null },
    { start: "2026-11-03T16:00:00.000Z", rule: "FREQ=DAILY\nRRULE:FREQ=HOURLY;INTERVAL=2;BYHOUR=1", tz: null },
  ]);

  it("窗口包住主事件时，那一次还在", () => {
    expect(out.lines[0]?.n).toBe(1);
  });

  it("一个字符串里塞多条规则（只有直接调接口才写得出来）：只显示主事件", () => {
    expect(out.lines[1]?.n).toBe(1);
  });

  it("迁移和改时区用的 seriesStartsBetween 返回 null（不处理，不是「这条规则一次都没有」）", () => {
    expect(out.lines[0]?.series).toBeNull();
  });
});

describe("正常规则一条都不能误拦", () => {
  const WIN: [Date, Date] = [new Date("2026-01-01T00:00:00Z"), new Date("2030-01-01T00:00:00Z")];
  // 主事件在窗口之外：被拦下就是 0 条，没被拦下至少有一次。
  const count = (rrule: string, start = "2025-11-03T16:00:00.000Z", timeZone: string | null = null) => {
    const startsAt = new Date(start);
    return expandEvent(
      { id: "e", startsAt, endsAt: new Date(startsAt.getTime() + 3600_000), rrule, allDay: false, timeZone }, WIN[0], WIN[1],
    ).length;
  };

  for (const rule of [
    "FREQ=DAILY", "FREQ=WEEKLY", "FREQ=MONTHLY", "FREQ=YEARLY",
    "FREQ=DAILY;INTERVAL=2", "FREQ=WEEKLY;INTERVAL=2;BYDAY=TU", "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR",
    "FREQ=DAILY;BYHOUR=9,17", "FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=30",
    "FREQ=MONTHLY;BYMONTHDAY=31", "FREQ=MONTHLY;BYMONTHDAY=-1", "FREQ=MONTHLY;BYDAY=1MO", "FREQ=MONTHLY;BYDAY=-1FR",
    "FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1",
    "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1", "FREQ=WEEKLY;BYDAY=MO;BYHOUR=9,17;BYSETPOS=2",
    "FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=29", "FREQ=DAILY;BYMONTH=2;BYMONTHDAY=29",
    "FREQ=YEARLY;BYWEEKNO=20;BYDAY=MO", "FREQ=YEARLY;BYYEARDAY=100", "FREQ=YEARLY;BYEASTER=0",
    "FREQ=HOURLY", "FREQ=HOURLY;INTERVAL=4", "FREQ=HOURLY;INTERVAL=2;BYHOUR=2,4", "FREQ=HOURLY;BYHOUR=9,10,11",
    "FREQ=MINUTELY;INTERVAL=30", "FREQ=MINUTELY;INTERVAL=30;BYHOUR=9,10,11", "FREQ=MINUTELY;INTERVAL=15;BYMINUTE=0,30",
    "FREQ=SECONDLY;INTERVAL=30",
    "FREQ=WEEKLY;COUNT=20", "FREQ=DAILY;COUNT=500", "FREQ=WEEKLY;UNTIL=20290101T000000Z",
  ]) {
    it(rule, () => {
      expect(count(rule), "规则被当成数不完拦下了").toBeGreaterThan(0);
    });
  }

  it("碰不碰得上要按实际展开用的那个时钟算：墨尔本墙上时间碰得上（UTC 下碰不上的那一半在上面的危险名单里）", () => {
    // UTC 16:00（偶数点）= 墨尔本 03:00（奇数点，夏令时）
    expect(count("FREQ=HOURLY;INTERVAL=2;BYHOUR=1", "2025-11-03T16:00:00.000Z", MEL)).toBeGreaterThan(0);
  });
});
