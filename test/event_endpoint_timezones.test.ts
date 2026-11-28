import { describe, it, expect } from "vitest";
import { parseEvent, serializeEvent, type IcalEvent } from "../src/lib/ical.js";
import { mergeImportExtra } from "../src/lib/ics_import.js";
import { expansionTimeZone } from "../src/lib/event_zone.js";

process.env.PUBLIC_BASE_URL ||= "http://localhost:3000";
process.env.DATABASE_URL ||= "postgres://local-tests/unused";
process.env.SESSION_SECRET ||= "local-test-secret-at-least-32-characters";
const { extraSchema, mergeEventExtra } = await import("../src/routes/events.js");
const trip: IcalEvent = {
  uid: "melbourne-shanghai", summary: "Flight", allDay: false,
  startsAt: new Date("2026-11-28T12:00:00Z"), endsAt: new Date("2026-11-28T21:00:00Z"),
  timezone: "Australia/Melbourne", endTimezone: "Asia/Shanghai",
};

describe("independent event endpoint timezones", () => {
  it("validates the new IANA field and canonicalizes aliases", () => {
    expect(extraSchema.parse({ endTimezone: "PRC" })).toEqual({ endTimezone: "Asia/Shanghai" });
    for (const zone of ["Not/AZone", "+08:00", "Asia/Shanghai\nDTSTART:x", "", " Asia/Shanghai"])
      expect(extraSchema.safeParse({ endTimezone: zone }).success, zone).toBe(false);
    expect(extraSchema.parse({ endTimezone: null })).toEqual({ endTimezone: null });
  });
  it("older PATCH payloads preserve the arrival zone; explicit null removes only that override", () => {
    const current = { timezone: trip.timezone, endTimezone: trip.endTimezone, category: "travel" };
    expect(mergeEventExtra(current, extraSchema.parse({ category: "flight" }))).toEqual({ ...current, category: "flight" });
    expect(mergeEventExtra(current, undefined)).toEqual(current);
    expect(mergeEventExtra(current, extraSchema.parse({ endTimezone: null }))).toEqual({ timezone: trip.timezone, category: "travel" });
    expect(mergeEventExtra(current, null)).toBeNull();
  });
  it("round-trips Melbourne 23:00 to Shanghai next-day 05:00 as the same nine-hour interval", () => {
    const ics = serializeEvent(trip);
    expect(ics).toContain("DTSTART;TZID=Australia/Melbourne:20261128T230000");
    expect(ics).toContain("DTEND;TZID=Asia/Shanghai:20261129T050000");
    const decoded = parseEvent(ics)!;
    expect(decoded.timezone).toBe(trip.timezone);
    expect(decoded.endTimezone).toBe(trip.endTimezone);
    expect(decoded.startsAt).toEqual(trip.startsAt);
    expect(decoded.endsAt).toEqual(trip.endsAt);
    expect(decoded.endsAt.getTime() - decoded.startsAt.getTime()).toBe(9 * 3_600_000);
  });
  it("does not mistake a lower arrival wall-clock reading for a negative duration", () => {
    const decoded = parseEvent(serializeEvent({ ...trip, startsAt: new Date("2026-11-27T23:00:00Z"), endsAt: new Date("2026-11-28T01:00:00Z") }))!;
    expect(decoded.endsAt.getTime() - decoded.startsAt.getTime()).toBe(2 * 3_600_000);
  });
  it("can preserve an independent arrival zone when DTSTART is UTC", () => {
    const ics = serializeEvent({ ...trip, timezone: null });
    expect(ics).toContain("DTSTART:20261128T120000Z");
    expect(ics).toContain("DTEND;TZID=Asia/Shanghai:20261129T050000");
    expect(parseEvent(ics)?.endsAt).toEqual(trip.endsAt);
  });
  it("clearing the override reverts DTEND to the start zone; all-day dates ignore both zones", () => {
    expect(serializeEvent({ ...trip, endTimezone: null })).toContain("DTEND;TZID=Australia/Melbourne:20261129T080000");
    expect(serializeEvent({ ...trip, allDay: true })).not.toContain("TZID=");
  });
  it("imports the arrival metadata and preserves it when a source has no endpoint override", () => {
    const imported = mergeImportExtra(null, "file:trip.ics", null, trip.timezone!, { endTimezone: trip.endTimezone });
    expect(imported).toMatchObject({ timezone: trip.timezone, endTimezone: trip.endTimezone });
    expect(mergeImportExtra(imported, null, null, null, {})).toEqual(imported);
  });
  it("never moves the recurrence anchor or EXDATE zone to the arrival zone", () => {
    expect(expansionTimeZone({ allDay: false, extra: { timezone: trip.timezone, endTimezone: trip.endTimezone }, calendarTimezone: "UTC" })).toBe(trip.timezone);
    expect(serializeEvent({ ...trip, rrule: "FREQ=WEEKLY", exdates: ["2026-12-05T12:00:00Z"] }))
      .toContain("EXDATE;TZID=Australia/Melbourne:20261205T230000");
  });
});

describe("endpoint metadata normalization for imported calendars", () => {
  function parsed(start: string, end: string) {
    return parseEvent(["BEGIN:VEVENT", "UID:zones", "SUMMARY:Trip", start, end, "END:VEVENT"].join("\r\n"))!;
  }
  it("does not invent an arrival override for ordinary UTC or same-zone events", () => {
    expect(parsed("DTSTART:20261128T120000Z", "DTEND:20261128T210000Z")).toMatchObject({ timezone: null, endTimezone: null });
    expect(parsed("DTSTART;TZID=Asia/Shanghai:20261128T120000", "DTEND;TZID=PRC:20261128T210000")).toMatchObject({ timezone: "Asia/Shanghai", endTimezone: null });
  });
  it("pins a UTC origin only when paired with an explicit different arrival zone", () => {
    expect(parsed("DTSTART:20261128T120000Z", "DTEND;TZID=Asia/Shanghai:20261129T050000")).toMatchObject({ timezone: "UTC", endTimezone: "Asia/Shanghai" });
    expect(parsed("DTSTART;TZID=Australia/Melbourne:20261128T230000", "DTEND:20261128T210000Z")).toMatchObject({ timezone: "Australia/Melbourne", endTimezone: "UTC" });
  });
  it("clears an obsolete override when a full import explicitly becomes same-zone or all-day", () => {
    const existing = { timezone: "Australia/Melbourne", endTimezone: "Asia/Shanghai", category: "travel" };
    const allDay = parsed("DTSTART;VALUE=DATE:20261128", "DTEND;VALUE=DATE:20261129");
    expect(allDay.endTimezone).toBeNull();
    expect(mergeImportExtra(existing, null, null, null, { endTimezone: allDay.endTimezone }))
      .toEqual({ timezone: "Australia/Melbourne", category: "travel" });
  });
});
