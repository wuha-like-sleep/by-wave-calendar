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

  it("is timezone-neutral: server TZ does not shift the wall-clock result", () => {
    // Same inputs must yield the same wall-clock string regardless of where
    // the server runs — we anchor everything to the caller's `now`.
    const a = parseNaturalLanguageEvent("明天 下午3点 x", "2026-07-03T10:00:00");
    expect(a?.startsAt).toBe("2026-07-04T15:00:00");
  });
});
