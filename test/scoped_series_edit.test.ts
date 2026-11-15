import { describe, expect, it } from "vitest";
import { activeSeriesOccurrence, planFutureSeries, truncateSeriesBefore, unchangedEventForWrite } from "../src/lib/scoped_series_edit.js";
import { expandEvent } from "../src/lib/rrule_expand.js";

const at = (day: number, minute = 0) => new Date(Date.UTC(2026, 10, day, 9, minute));
const series = (rrule: string, exdates: string[] = []) => ({ startsAt: at(1), endsAt: new Date(+at(1) + 3600000), rrule, allDay: false, exdates });
const dates = (event: ReturnType<typeof series>) => expandEvent({ ...event, id: "e", timeZone: "UTC" }, at(1), at(20)).map(v => v.startsAt.toISOString());

describe("scoped recurrence planning", () => {
  it("keeps the remaining count and prior cancellations when splitting", () => {
    const master = series("FREQ=DAILY;COUNT=5", [at(4).toISOString()]);
    const suffix = planFutureSeries(master, {}, at(3), at(3), "UTC", "UTC")!;
    expect(suffix.rrule).toBe("FREQ=DAILY;COUNT=3");
    expect(suffix.exdates).toEqual([at(4).toISOString()]);
    const prefix = { ...master, rrule: truncateSeriesBefore(master.rrule, at(3)) };
    expect(prefix.rrule).not.toContain("COUNT=");
    expect([...dates(prefix), ...dates({ ...master, ...suffix, startsAt: at(3), endsAt: new Date(+at(3) + 3600000), rrule: suffix.rrule! })]).toEqual(dates(master));
  });

  it("retains UNTIL and shifts future cancellations with a time edit", () => {
    const master = series("FREQ=DAILY;UNTIL=20261105T090000Z", [at(4).toISOString()]);
    const suffix = planFutureSeries(master, { startsAt: at(3, 30).toISOString() }, at(3), at(3, 30), "UTC", "UTC")!;
    expect(suffix.rrule).toBe("FREQ=DAILY;UNTIL=20261105T093000Z");
    expect(suffix.exdates).toEqual([at(4, 30).toISOString()]);
    expect(dates({ ...master, ...suffix, startsAt: at(3, 30), endsAt: new Date(+at(3, 30) + 3600000), rrule: suffix.rrule! })).toEqual([at(3, 30).toISOString(), at(5, 30).toISOString()]);
  });

  it("rejects stale, excluded and non-occurring identities", () => {
    const master = series("FREQ=DAILY;COUNT=5", [at(4).toISOString()]);
    expect(activeSeriesOccurrence(master, "UTC", at(3))).toBe(true);
    expect(activeSeriesOccurrence(master, "UTC", at(4))).toBe(false);
    expect(activeSeriesOccurrence(master, "UTC", at(6))).toBe(false);
    expect(activeSeriesOccurrence(master, "UTC", at(3, 30))).toBe(false);
  });

  it("rejects an ambiguous zone change and a new start forbidden by its unchanged rule", () => {
    const master = series("FREQ=DAILY;BYHOUR=9;COUNT=5");
    expect(planFutureSeries(master, {}, at(3), at(3), "UTC", "Asia/Shanghai")).toBeNull();
    expect(planFutureSeries(master, { startsAt: at(3, 30).toISOString() }, at(3), new Date(+at(3) + 3600000), "UTC", "UTC")).toBeNull();
  });

  it("allows timezone-only suffix edits while preserving remaining count and end boundary", () => {
    const master = series("FREQ=DAILY;COUNT=5");
    expect(planFutureSeries(master, {}, at(3), at(3), "UTC", "Asia/Tokyo")).toEqual({
      rrule: "FREQ=DAILY;COUNT=3", exdates: [],
    });
    const bounded = series("FREQ=DAILY;UNTIL=20261105T090000Z");
    expect(planFutureSeries(bounded, {}, at(3), at(3), "UTC", "Asia/Tokyo")?.rrule)
      .toBe("FREQ=DAILY;UNTIL=20261105T090000Z");
    expect(planFutureSeries({ ...master, exdates: [at(4).toISOString()] }, {}, at(3), at(3), "UTC", "Asia/Tokyo"))
      .toBeNull();
    expect(planFutureSeries(master, { startsAt: at(3, 30).toISOString() }, at(3), at(3, 30), "UTC", "Asia/Tokyo"))
      .toBeNull();
  });

  it("refuses a suffix whose consumed COUNT cannot be checked within the bounded scan", () => {
    const master = series("FREQ=DAILY;COUNT=20000");
    const later = new Date(+master.startsAt + 10001 * 86400000);
    expect(planFutureSeries(master, {}, later, later, "UTC", "UTC")).toBeNull();
  });

  it("an explicit stop repeating creates a single suffix event", () => {
    const master = series("FREQ=DAILY;COUNT=5");
    expect(planFutureSeries(master, { rrule: "" }, at(3), at(3), "UTC", "UTC")).toEqual({ rrule: null, exdates: [] });
  });
});


describe("event write guard", () => {
  it("detects a simultaneous exclusion even when updatedAt is unchanged", () => {
    const expected = { ...series("FREQ=DAILY;COUNT=5"), updatedAt: at(1), summary: "Before" };
    expect(unchangedEventForWrite(expected, { ...expected })).toBe(true);
    expect(unchangedEventForWrite(expected, { ...expected, exdates: [at(3).toISOString()] })).toBe(false);
    expect(unchangedEventForWrite(expected, { ...expected, rrule: "FREQ=DAILY;COUNT=2" })).toBe(false);
  });
});
