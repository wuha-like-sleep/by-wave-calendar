import { describe, it, expect } from "vitest";
import { parseNaturalLanguageEvent } from "../src/lib/nl_parse.js";

// Fixed reference: 2026-07-03 is a Thursday, 10:00 local.
const NOW = "2026-07-03T10:00:00";

describe("parseNaturalLanguageEvent", () => {
  it("明天 + 下午 time + summary", () => {
    expect(parseNaturalLanguageEvent("明天 下午3点 牙医", NOW)).toEqual({
      summary: "牙医",
      startsAt: "2026-07-04T15:00:00",
      endsAt: "2026-07-04T16:00:00",
    });
  });

  it("后天 + time + explicit 30分钟 duration", () => {
    expect(parseNaturalLanguageEvent("后天 9点 30分钟 站会", NOW)).toEqual({
      summary: "站会",
      startsAt: "2026-07-05T09:00:00",
      endsAt: "2026-07-05T09:30:00",
    });
  });

  it("time only, already passed today → pushes to tomorrow", () => {
    // 8:00 < 10:00 now, no date given → tomorrow.
    expect(parseNaturalLanguageEvent("8点 晨会", NOW)).toEqual({
      summary: "晨会",
      startsAt: "2026-07-04T08:00:00",
      endsAt: "2026-07-04T09:00:00",
    });
  });

  it("date only → defaults to 09:00, 1h", () => {
    expect(parseNaturalLanguageEvent("明天 体检", NOW)).toEqual({
      summary: "体检",
      startsAt: "2026-07-04T09:00:00",
      endsAt: "2026-07-04T10:00:00",
    });
  });

  it("周一 (Fri → +3, always upcoming) with 1小时 duration", () => {
    expect(parseNaturalLanguageEvent("周一 10点 1小时 团建", NOW)).toEqual({
      summary: "团建",
      startsAt: "2026-07-06T10:00:00",
      endsAt: "2026-07-06T11:00:00",
    });
  });

  it("下周一 forces +7 over 周一", () => {
    expect(parseNaturalLanguageEvent("下周一 10点 复盘", NOW)?.startsAt).toBe("2026-07-13T10:00:00");
  });

  it("X月X日 absolute date", () => {
    expect(parseNaturalLanguageEvent("8月1日 上午9点 出差", NOW)?.startsAt).toBe("2026-08-01T09:00:00");
  });

  it("returns null when there is no date or time to anchor on", () => {
    expect(parseNaturalLanguageEvent("买牛奶", NOW)).toBeNull();
    expect(parseNaturalLanguageEvent("", NOW)).toBeNull();
  });

  // ---- 口语化扩充 (v1.6.7) ----

  it("今晚 → 今天晚上", () => {
    expect(parseNaturalLanguageEvent("今晚8点 聚餐", NOW)).toEqual({
      summary: "聚餐",
      startsAt: "2026-07-03T20:00:00",
      endsAt: "2026-07-03T21:00:00",
    });
  });

  it("礼拜五/星期五 normalize to 周五 (Fri now → next Fri)", () => {
    expect(parseNaturalLanguageEvent("礼拜五 9点 打球", NOW)?.startsAt).toBe("2026-07-10T09:00:00");
    expect(parseNaturalLanguageEvent("星期五 9点 打球", NOW)?.startsAt).toBe("2026-07-10T09:00:00");
  });

  it("做礼拜 in summary is NOT eaten by the weekday rule", () => {
    const r = parseNaturalLanguageEvent("明天 上午10点 去教堂做礼拜", NOW);
    expect(r?.summary).toBe("去教堂做礼拜");
  });

  it("三天后", () => {
    expect(parseNaturalLanguageEvent("三天后 交报告", NOW)?.startsAt).toBe("2026-07-06T09:00:00");
  });

  it("下周 alone → next week's Monday", () => {
    expect(parseNaturalLanguageEvent("下周 述职", NOW)?.startsAt).toBe("2026-07-06T09:00:00");
  });

  it("下个月5号", () => {
    expect(parseNaturalLanguageEvent("下个月5号 还信用卡", NOW)?.startsAt).toBe("2026-08-05T09:00:00");
  });

  it("bare 15号 → this month when still ahead", () => {
    expect(parseNaturalLanguageEvent("15号 交房租", NOW)?.startsAt).toBe("2026-07-15T09:00:00");
  });

  it("bare 1号 already passed → next month", () => {
    expect(parseNaturalLanguageEvent("1号 交房租", NOW)?.startsAt).toBe("2026-08-01T09:00:00");
  });

  it("时间区间 下午3点到5点 → duration 2h", () => {
    expect(parseNaturalLanguageEvent("明天下午3点到5点 培训", NOW)).toEqual({
      summary: "培训",
      startsAt: "2026-07-04T15:00:00",
      endsAt: "2026-07-04T17:00:00",
    });
  });

  it("时间区间 end inherits start period + 半", () => {
    expect(parseNaturalLanguageEvent("明天下午3点半到5点 复盘", NOW)).toEqual({
      summary: "复盘",
      startsAt: "2026-07-04T15:30:00",
      endsAt: "2026-07-04T17:00:00",
    });
  });

  it("period without hour → colloquial default (下午 → 15:00)", () => {
    expect(parseNaturalLanguageEvent("明天下午 开会", NOW)?.startsAt).toBe("2026-07-04T15:00:00");
  });

  it("中午一点 means 13:00, not 12:00", () => {
    expect(parseNaturalLanguageEvent("中午一点 午饭", NOW)?.startsAt).toBe("2026-07-03T13:00:00");
  });

  it("傍晚6点 / 夜里11点 pm handling", () => {
    expect(parseNaturalLanguageEvent("明天傍晚6点 散步", NOW)?.startsAt).toBe("2026-07-04T18:00:00");
    expect(parseNaturalLanguageEvent("明天夜里11点 追剧", NOW)?.startsAt).toBe("2026-07-04T23:00:00");
  });

  it("俩钟头 duration", () => {
    expect(parseNaturalLanguageEvent("明天10点 俩钟头 培训", NOW)).toEqual({
      summary: "培训",
      startsAt: "2026-07-04T10:00:00",
      endsAt: "2026-07-04T12:00:00",
    });
  });

  it("is timezone-neutral: server TZ does not shift the wall-clock result", () => {
    // Same inputs must yield the same wall-clock string regardless of where
    // the server runs — we anchor everything to the caller's `now`.
    const a = parseNaturalLanguageEvent("明天 下午3点 x", "2026-07-03T10:00:00");
    expect(a?.startsAt).toBe("2026-07-04T15:00:00");
  });

  // ---- connected input (no spaces between tokens) ----
  it("parses fully connected input '明天下午三点开会'", () => {
    expect(parseNaturalLanguageEvent("明天下午三点开会", NOW)).toEqual({
      summary: "开会",
      startsAt: "2026-07-04T15:00:00",
      endsAt: "2026-07-04T16:00:00",
    });
  });

  it("大后天 wins over its 后天 substring (no whitespace guard)", () => {
    // 大后天 = +3 days → 2026-07-06, not +2.
    expect(parseNaturalLanguageEvent("大后天体检", NOW)?.startsAt).toBe("2026-07-06T09:00:00");
  });

  // ---- Chinese numerals ----
  it("Chinese-numeral hour '晚上八点半'", () => {
    expect(parseNaturalLanguageEvent("晚上八点半 吃饭", NOW)).toEqual({
      summary: "吃饭",
      startsAt: "2026-07-03T20:30:00",
      endsAt: "2026-07-03T21:30:00",
    });
  });

  it("Chinese-numeral hour ≥10 '十点二十'", () => {
    // 10:20 today already passed? no, 10:20 > 10:00 now → stays today.
    expect(parseNaturalLanguageEvent("十点二十 晨跑", NOW)?.startsAt).toBe("2026-07-03T10:20:00");
  });

  it("二十三点 (24h Chinese numeral)", () => {
    expect(parseNaturalLanguageEvent("明天二十三点 值班", NOW)?.startsAt).toBe("2026-07-04T23:00:00");
  });

  // ---- 刻 quarters ----
  it("'3点一刻' → :15 and '3点三刻' → :45", () => {
    expect(parseNaturalLanguageEvent("明天3点一刻 x", NOW)?.startsAt).toBe("2026-07-04T03:15:00");
    expect(parseNaturalLanguageEvent("明天3点三刻 x", NOW)?.startsAt).toBe("2026-07-04T03:45:00");
  });

  // ---- colon time ----
  it("colon time '15:30'", () => {
    expect(parseNaturalLanguageEvent("明天15:30 复盘", NOW)?.startsAt).toBe("2026-07-04T15:30:00");
  });

  // ---- Chinese durations ----
  it("'两小时' duration", () => {
    const r = parseNaturalLanguageEvent("明天10点 两小时 团建", NOW);
    expect(r?.startsAt).toBe("2026-07-04T10:00:00");
    expect(r?.endsAt).toBe("2026-07-04T12:00:00");
  });

  it("'一个半小时' duration → 90min", () => {
    const r = parseNaturalLanguageEvent("明天10点 一个半小时 workshop", NOW);
    expect(r?.endsAt).toBe("2026-07-04T11:30:00");
  });

  it("'半小时' duration → 30min", () => {
    const r = parseNaturalLanguageEvent("明天10点 半小时 站会", NOW);
    expect(r?.endsAt).toBe("2026-07-04T10:30:00");
  });

  // ---- 周末 ----
  it("周末 → upcoming Saturday", () => {
    // NOW is 2026-07-03 (Fri) → Saturday is +1 → 2026-07-04.
    expect(parseNaturalLanguageEvent("周末爬山", NOW)?.startsAt).toBe("2026-07-04T09:00:00");
  });

  it("下下周一 → +14 over 周一", () => {
    expect(parseNaturalLanguageEvent("下下周一 10点 复盘", NOW)?.startsAt).toBe("2026-07-20T10:00:00");
  });

  it("does not treat a numeral inside a word as a time ('三国杀')", () => {
    // 三 without a 点/时 marker must not become 03:00.
    expect(parseNaturalLanguageEvent("三国杀", NOW)).toBeNull();
  });
});
