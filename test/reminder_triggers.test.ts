import { describe, it, expect } from "vitest";
import {
  TIMED_TRIGGERS,
  ALLDAY_TRIGGERS,
  MAX_ALARMS_PER_EVENT,
  parseTrigger,
  normalizeAlarms,
  resolveTriggerAt,
  type TriggerEventLike,
} from "../src/lib/reminder_triggers.js";

const D = (iso: string) => new Date(iso);
const iso = (d: Date | null) => (d === null ? null : d.toISOString());

// 断言「算出来的那一刻在 tz 里读作几点」。全天提醒的验收标准是当地墙上时间，
// 只断言 UTC 的 ISO 会让夏令时那条测试失去意义。
function wallClock(d: Date | null, tz: string): string | null {
  if (d === null) return null;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(d);
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe("parseTrigger — 相对 duration 的各种合法写法", () => {
  it("裸的负号写法", () => {
    expect(parseTrigger("-PT15M")).toEqual({ kind: "relative", ms: -15 * MIN, relatedToEnd: false });
  });

  it("周（今天的正则吃不下 W，整条被静默丢弃）", () => {
    expect(parseTrigger("-P1W")).toEqual({ kind: "relative", ms: -7 * DAY, relatedToEnd: false });
  });

  it("秒（今天的正则吃不下 S）", () => {
    expect(parseTrigger("-PT30S")).toEqual({ kind: "relative", ms: -30_000, relatedToEnd: false });
  });

  it("零偏移是合法的，不是 null —— 今天 `total > 0` 把准时提醒判成了非法", () => {
    expect(parseTrigger("PT0S")).toEqual({ kind: "relative", ms: 0, relatedToEnd: false });
    expect(parseTrigger("-PT0M")).toEqual({ kind: "relative", ms: 0, relatedToEnd: false });
    expect(parseTrigger("P0D")).toEqual({ kind: "relative", ms: 0, relatedToEnd: false });
  });

  it("正数触发保留正号（表示事件之后）—— 今天符号被 Math 吃掉，提醒提前而不是延后响", () => {
    expect(parseTrigger("PT10M")).toEqual({ kind: "relative", ms: 10 * MIN, relatedToEnd: false });
    expect(parseTrigger("+PT10M")).toEqual({ kind: "relative", ms: 10 * MIN, relatedToEnd: false });
  });

  it("组合写法", () => {
    expect(parseTrigger("-P1DT15H")).toEqual({ kind: "relative", ms: -(DAY + 15 * HOUR), relatedToEnd: false });
    expect(parseTrigger("-P6DT15H")).toEqual({ kind: "relative", ms: -(6 * DAY + 15 * HOUR), relatedToEnd: false });
  });

  it("大小写混写", () => {
    expect(parseTrigger("-p1dT15h")).toEqual({ kind: "relative", ms: -(DAY + 15 * HOUR), relatedToEnd: false });
    expect(parseTrigger("-Pt15m")).toEqual({ kind: "relative", ms: -15 * MIN, relatedToEnd: false });
  });

  it("前后空白", () => {
    expect(parseTrigger("  -PT15M \n")).toEqual({ kind: "relative", ms: -15 * MIN, relatedToEnd: false });
  });

  it("W 和 D/T 同现按相加处理（放宽，因为没有歧义）", () => {
    expect(parseTrigger("-P1W2D")).toEqual({ kind: "relative", ms: -9 * DAY, relatedToEnd: false });
  });
});

describe("parseTrigger — 参数前缀", () => {
  it("RELATED=END 要被认出来", () => {
    expect(parseTrigger("RELATED=END:-PT15M")).toEqual({ kind: "relative", ms: -15 * MIN, relatedToEnd: true });
  });

  it("RELATED=START 和不写一样", () => {
    expect(parseTrigger("RELATED=START:-PT15M")).toEqual({ kind: "relative", ms: -15 * MIN, relatedToEnd: false });
  });

  it("RELATED 写了看不懂的值就整条丢掉，不默认按 START 猜", () => {
    expect(parseTrigger("RELATED=BANANA:-PT15M")).toBeNull();
  });

  it("多个参数、大小写混写", () => {
    expect(parseTrigger("related=end;VALUE=DURATION:-PT15M"))
      .toEqual({ kind: "relative", ms: -15 * MIN, relatedToEnd: true });
  });

  it("VALUE=DURATION 前缀", () => {
    expect(parseTrigger("VALUE=DURATION:-PT1H")).toEqual({ kind: "relative", ms: -HOUR, relatedToEnd: false });
  });
});

describe("parseTrigger — 绝对时间触发", () => {
  it("VALUE=DATE-TIME 按绝对时刻处理", () => {
    const p = parseTrigger("VALUE=DATE-TIME:20260101T090000Z");
    expect(p?.kind).toBe("absolute");
    expect(p && p.kind === "absolute" ? p.at.toISOString() : null).toBe("2026-01-01T09:00:00.000Z");
  });

  it("整行属性（带 TRIGGER 名）也认，省得调用方自己剥", () => {
    const p = parseTrigger("TRIGGER;VALUE=DATE-TIME:20260101T090000Z");
    expect(p && p.kind === "absolute" ? p.at.toISOString() : null).toBe("2026-01-01T09:00:00.000Z");
    expect(parseTrigger("TRIGGER;RELATED=END:-PT15M"))
      .toEqual({ kind: "relative", ms: -15 * MIN, relatedToEnd: true });
    expect(parseTrigger("TRIGGER:-PT15M"))
      .toEqual({ kind: "relative", ms: -15 * MIN, relatedToEnd: false });
  });

  it("裸的 DATE-TIME（没带 VALUE 参数）也认，按 UTC 解释", () => {
    const p = parseTrigger("20260101T090000Z");
    expect(p && p.kind === "absolute" ? p.at.toISOString() : null).toBe("2026-01-01T09:00:00.000Z");
  });

  it("不存在的日期不认，不能被悄悄顺延", () => {
    expect(parseTrigger("VALUE=DATE-TIME:20260230T090000Z")).toBeNull();
  });
});

describe("parseTrigger — 故意不支持的写法返回 null", () => {
  it.each([
    ["空串（「不提醒」的哨兵值，不是触发器）", ""],
    ["纯空白", "   "],
    ["banana", "banana"],
    ["光一个 P", "P"],
    ["光一个 PT", "PT"],
    ["月（P1M 在 RFC 5545 里不是合法 duration，也绝不能当成 1 分钟）", "P1M"],
    ["年", "P1Y"],
    ["小数", "PT1.5H"],
    ["带冒号但不是参数写法", "banana:-PT15M"],
    ["只有参数没有值", "RELATED=END:"],
  ])("%s", (_label, raw) => {
    expect(parseTrigger(raw)).toBeNull();
  });
});

describe("resolveTriggerAt — 定时事件", () => {
  const ev: TriggerEventLike = {
    startsAt: D("2026-06-10T09:00:00Z"),
    endsAt: D("2026-06-10T11:00:00Z"),
    allDay: false,
    timezone: "Asia/Shanghai",
  };

  it("默认相对开始", () => {
    expect(iso(resolveTriggerAt(ev, "-PT15M"))).toBe("2026-06-10T08:45:00.000Z");
  });

  it("RELATED=END 相对结束：09:00–11:00 + RELATED=END:-PT15M → 10:45，不是 08:45", () => {
    expect(iso(resolveTriggerAt(ev, "RELATED=END:-PT15M"))).toBe("2026-06-10T10:45:00.000Z");
  });

  it("正数触发落在事件之后", () => {
    expect(iso(resolveTriggerAt(ev, "PT30M"))).toBe("2026-06-10T09:30:00.000Z");
  });

  it("零偏移就是开始那一刻", () => {
    expect(iso(resolveTriggerAt(ev, "-PT0M"))).toBe("2026-06-10T09:00:00.000Z");
  });

  it("定时事件的偏移是绝对时长，夏令时切换不影响", () => {
    // 2026-03-08 美东 02:00 跳到 03:00。01:30 EST 往后 1 小时 = 03:30 EDT。
    const dstEv: TriggerEventLike = {
      startsAt: D("2026-03-08T06:30:00Z"), endsAt: D("2026-03-08T07:30:00Z"),
      allDay: false, timezone: "America/New_York",
    };
    expect(iso(resolveTriggerAt(dstEv, "PT1H"))).toBe("2026-03-08T07:30:00.000Z");
  });

  it("RELATED=END 但没有 endsAt → null，不退回 startsAt 算出个错时刻", () => {
    const noEnd: TriggerEventLike = { startsAt: D("2026-06-10T09:00:00Z"), endsAt: null, allDay: false, timezone: "UTC" };
    expect(resolveTriggerAt(noEnd, "RELATED=END:-PT15M")).toBeNull();
  });

  it("解析不了的 trigger → null", () => {
    expect(resolveTriggerAt(ev, "banana")).toBeNull();
  });
});

describe("resolveTriggerAt — 全天事件锚定当天 00:00", () => {
  // 2026-03-05 的全天事件：存的是当天的 UTC 午夜。
  const allDay = (timezone: string | null): TriggerEventLike => ({
    startsAt: D("2026-03-05T00:00:00Z"),
    endsAt: D("2026-03-06T00:00:00Z"),
    allDay: true,
    timezone,
  });

  it("Asia/Shanghai + PT9H → 2026-03-05 09:00 +08", () => {
    const at = resolveTriggerAt(allDay("Asia/Shanghai"), "PT9H");
    expect(iso(at)).toBe("2026-03-05T01:00:00.000Z");
    expect(wallClock(at, "Asia/Shanghai")).toBe("2026-03-05, 09:00");
  });

  it("America/New_York + PT9H → 2026-03-05 09:00 -05（同一个档位在另一个时区是另一个瞬间）", () => {
    const at = resolveTriggerAt(allDay("America/New_York"), "PT9H");
    expect(iso(at)).toBe("2026-03-05T14:00:00.000Z");
    expect(wallClock(at, "America/New_York")).toBe("2026-03-05, 09:00");
  });

  it("Europe/Berlin + -PT15H → 2026-03-04 09:00 +01", () => {
    const at = resolveTriggerAt(allDay("Europe/Berlin"), "-PT15H");
    expect(iso(at)).toBe("2026-03-04T08:00:00.000Z");
    expect(wallClock(at, "Europe/Berlin")).toBe("2026-03-04, 09:00");
  });

  it("-P1DT15H → 两天前 09:00；-P6DT15H → 一周前 09:00", () => {
    expect(wallClock(resolveTriggerAt(allDay("Asia/Shanghai"), "-P1DT15H"), "Asia/Shanghai")).toBe("2026-03-03, 09:00");
    expect(wallClock(resolveTriggerAt(allDay("Asia/Shanghai"), "-P6DT15H"), "Asia/Shanghai")).toBe("2026-02-26, 09:00");
  });

  it("夏令时切换当天（America/New_York 2026-03-08）算出来仍是当地 09:00", () => {
    const ev: TriggerEventLike = {
      startsAt: D("2026-03-08T00:00:00Z"), endsAt: D("2026-03-09T00:00:00Z"),
      allDay: true, timezone: "America/New_York",
    };
    const at = resolveTriggerAt(ev, "PT9H");
    // 当地午夜是 05:00Z（还是 EST），若按「绝对时长 +9h」会得到 14:00Z = 当地 10:00。
    expect(iso(at)).toBe("2026-03-08T13:00:00.000Z");
    expect(wallClock(at, "America/New_York")).toBe("2026-03-08, 09:00");
  });

  it("往回跨过夏令时切换点也是当地 09:00", () => {
    const ev: TriggerEventLike = {
      startsAt: D("2026-03-09T00:00:00Z"), endsAt: D("2026-03-10T00:00:00Z"),
      allDay: true, timezone: "America/New_York",
    };
    // 03-09 的前一天 = 03-08，切换已经发生 → 09:00 EDT = 13:00Z
    expect(wallClock(resolveTriggerAt(ev, "-PT15H"), "America/New_York")).toBe("2026-03-08, 09:00");
    // 03-09 的两天前 = 03-07，还在 EST → 09:00 EST = 14:00Z
    expect(iso(resolveTriggerAt(ev, "-P1DT15H"))).toBe("2026-03-07T14:00:00.000Z");
    expect(wallClock(resolveTriggerAt(ev, "-P1DT15H"), "America/New_York")).toBe("2026-03-07, 09:00");
  });

  // 下面两条盯的是换算里的二次迭代修正。第一次取偏移用的是「先当 UTC 猜出来的那个瞬间」，
  // 当这个瞬间和真正的答案分处夏令时切换点两侧时，第一次取到的偏移是错的、结果整整差一小时。
  // 09:00 这个锚点正好躲开了这个窗口，所以要用第三方 .ics 完全可能发来的 PT4H / PT3H 来打。
  it("跨过春季切换点的偏移要修正（America/New_York 2026-03-08 + PT4H → 当地 04:00）", () => {
    const ev: TriggerEventLike = {
      startsAt: D("2026-03-08T00:00:00Z"), endsAt: D("2026-03-09T00:00:00Z"),
      allDay: true, timezone: "America/New_York",
    };
    const at = resolveTriggerAt(ev, "PT4H");
    expect(iso(at)).toBe("2026-03-08T08:00:00.000Z");
    expect(wallClock(at, "America/New_York")).toBe("2026-03-08, 04:00");
  });

  it("跨过秋季切换点的偏移要修正（America/New_York 2026-11-01 + PT3H → 当地 03:00）", () => {
    const ev: TriggerEventLike = {
      startsAt: D("2026-11-01T00:00:00Z"), endsAt: D("2026-11-02T00:00:00Z"),
      allDay: true, timezone: "America/New_York",
    };
    const at = resolveTriggerAt(ev, "PT3H");
    expect(iso(at)).toBe("2026-11-01T08:00:00.000Z");
    expect(wallClock(at, "America/New_York")).toBe("2026-11-01, 03:00");
  });

  it("timezone 为空 → null（调用方记 skip，绝不回落到服务器本地时区）", () => {
    expect(resolveTriggerAt(allDay(null), "PT9H")).toBeNull();
    expect(resolveTriggerAt(allDay(""), "PT9H")).toBeNull();
    expect(resolveTriggerAt(allDay("   "), "PT9H")).toBeNull();
  });

  it("timezone 不是合法 IANA 名 → null，不静默回落", () => {
    expect(resolveTriggerAt(allDay("Not/AZone"), "PT9H")).toBeNull();
  });

  it("全天事件的绝对触发不需要时区", () => {
    const at = resolveTriggerAt(allDay(null), "VALUE=DATE-TIME:20260101T090000Z");
    expect(iso(at)).toBe("2026-01-01T09:00:00.000Z");
  });
});

describe("normalizeAlarms", () => {
  it("同一个 trigger 原文重复只留一条", () => {
    expect(normalizeAlarms([{ trigger: "-PT15M" }, { trigger: "-PT15M" }])).toEqual([{ trigger: "-PT15M" }]);
  });

  it("语义相同但写法不同的也去重，并且保留先到那条的原文（原文是幂等键的一部分）", () => {
    const out = normalizeAlarms([{ trigger: "-PT15M" }, { trigger: "RELATED=START:-PT15M" }]);
    expect(out).toEqual([{ trigger: "-PT15M" }]);
  });

  it("RELATED=END 和 RELATED=START 是两条不同的提醒，不该被去掉", () => {
    const out = normalizeAlarms([{ trigger: "-PT15M" }, { trigger: "RELATED=END:-PT15M" }]);
    expect(out.map((a) => a.trigger)).toEqual(["-PT15M", "RELATED=END:-PT15M"]);
  });

  it("9 条截到 8 条，保持原顺序", () => {
    const nine = ["-PT5M", "-PT10M", "-PT15M", "-PT20M", "-PT25M", "-PT30M", "-PT35M", "-PT40M", "-PT45M"];
    const out = normalizeAlarms(nine.map((trigger) => ({ trigger })));
    expect(out).toHaveLength(MAX_ALARMS_PER_EVENT);
    expect(out.map((a) => a.trigger)).toEqual(nine.slice(0, 8));
  });

  it("混入垃圾值只丢那一条，其余保留", () => {
    const out = normalizeAlarms([
      { trigger: "-PT15M" },
      { trigger: "banana" },
      { trigger: "" },
      { trigger: 42 },
      null,
      "-PT1H",
      { trigger: "-PT1H" },
    ]);
    expect(out.map((a) => a.trigger)).toEqual(["-PT15M", "-PT1H"]);
  });

  it("非数组 → 空数组", () => {
    expect(normalizeAlarms(null)).toEqual([]);
    expect(normalizeAlarms(undefined)).toEqual([]);
    expect(normalizeAlarms({ trigger: "-PT15M" })).toEqual([]);
  });

  it("保留 action / description，空白的不写进去", () => {
    const out = normalizeAlarms([{ trigger: "-PT15M", action: "DISPLAY", description: " 开会 ", extra: "x" }]);
    expect(out).toEqual([{ trigger: "-PT15M", action: "DISPLAY", description: "开会" }]);
  });
});

describe("档位常量本身要自洽", () => {
  it("两组的第一项都是「不提醒」的空串", () => {
    expect(TIMED_TRIGGERS[0]?.value).toBe("");
    expect(ALLDAY_TRIGGERS[0]?.value).toBe("");
  });

  it("每个非空档位都解析得出来", () => {
    for (const opt of [...TIMED_TRIGGERS, ...ALLDAY_TRIGGERS]) {
      if (!opt.value) continue;
      expect(parseTrigger(opt.value), `${opt.value} 解析不了`).not.toBeNull();
    }
  });

  it("i18nKey 不含中文，值不重复", () => {
    for (const opt of [...TIMED_TRIGGERS, ...ALLDAY_TRIGGERS]) {
      expect(opt.i18nKey).toMatch(/^[a-zA-Z0-9.]+$/);
    }
    expect(new Set(TIMED_TRIGGERS.map((o) => o.value)).size).toBe(TIMED_TRIGGERS.length);
    expect(new Set(ALLDAY_TRIGGERS.map((o) => o.value)).size).toBe(ALLDAY_TRIGGERS.length);
  });

  it("全天档位在任何时区都落在当地 09:00 —— 这是 C2 定这组值的全部理由", () => {
    const ev = (tz: string): TriggerEventLike => ({
      startsAt: D("2026-07-15T00:00:00Z"), endsAt: D("2026-07-16T00:00:00Z"), allDay: true, timezone: tz,
    });
    for (const tz of ["Asia/Shanghai", "America/New_York", "Europe/Berlin", "Pacific/Auckland", "Asia/Kolkata"]) {
      for (const opt of ALLDAY_TRIGGERS) {
        if (!opt.value) continue;
        const at = resolveTriggerAt(ev(tz), opt.value);
        expect(wallClock(at, tz), `${tz} / ${opt.value}`).toMatch(/, 09:00$/);
      }
    }
  });

  it("定时档位全是「事件之前或准时」，没有一个是正数", () => {
    for (const opt of TIMED_TRIGGERS) {
      if (!opt.value) continue;
      const p = parseTrigger(opt.value);
      expect(p?.kind).toBe("relative");
      expect(p && p.kind === "relative" ? p.ms : 1).toBeLessThanOrEqual(0);
    }
  });
});
