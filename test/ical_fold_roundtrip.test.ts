import { describe, expect, it } from "vitest";
import { parseEvent, serializeEvent, wrapSingleEvent, type IcalEvent } from "../src/lib/ical.js";

const event = (start: string, end: string, timezone: string, endTimezone?: string): IcalEvent => ({
  uid: "fold-roundtrip", summary: "Clock-change meeting", allDay: false,
  startsAt: new Date(start), endsAt: new Date(end), timezone, endTimezone,
});
const lines = (body: string) => body.replace(/\r?\n[\t ]/g, "").split(/\r?\n/);
const parsedWith = (extra: string[], start = "DTSTART:20261101T063000Z", end = "DTEND:20261101T073000Z") => parseEvent([
  "BEGIN:VEVENT", "UID:input", "SUMMARY:Imported meeting", start, end, ...extra, "END:VEVENT",
].join("\r\n"))!;

describe("single-event iCalendar clock-change round trips", () => {
  it.each([
    ["New York second start", "2026-11-01T06:30:00Z", "2026-11-01T07:30:00Z", "America/New_York", undefined, true, false],
    ["New York second end", "2026-11-01T05:15:00Z", "2026-11-01T06:45:00Z", "America/New_York", undefined, false, true],
    ["New York both second", "2026-11-01T06:10:00Z", "2026-11-01T06:40:00Z", "America/New_York", undefined, true, true],
    ["Melbourne second hour", "2026-04-04T16:15:00Z", "2026-04-04T16:45:00Z", "Australia/Melbourne", undefined, true, true],
    ["Lord Howe half-hour fold", "2026-04-04T15:15:00Z", "2026-04-04T15:25:00Z", "Australia/Lord_Howe", undefined, true, true],
    ["independent New York and Chicago zones", "2026-11-01T06:30:00Z", "2026-11-01T07:30:00Z", "America/New_York", "America/Chicago", true, true],
  ] as const)("preserves %s through export, parse and re-export", (_label, start, end, zone, endZone, startUtc, endUtc) => {
    const original = event(start, end, zone, endZone);
    const serialized = wrapSingleEvent(original);
    const content = lines(serialized);
    for (const [name, date, expectedZone, utc] of [
      ["DTSTART", original.startsAt, zone, startUtc],
      ["DTEND", original.endsAt, endZone ?? zone, endUtc],
    ] as const) {
      const prop = content.find((line) => line.startsWith(name + ":") || line.startsWith(name + ";"))!;
      expect(prop).toBeDefined();
      const marker = `X-BYWAVE-${name === "DTSTART" ? "START" : "END"}-TIMEZONE:${expectedZone}`;
      if (utc) {
        expect(prop).toBe(`${name}:${date.toISOString().replace(/[-:]/g, "").replace(/\.000Z$/, "Z")}`);
        expect(content).toContain(marker);
      } else {
        expect(prop).toContain(`${name};TZID=${expectedZone}:`);
        expect(content).not.toContain(marker);
      }
    }
    const parsed = parseEvent(serialized)!;
    expect(parsed.startsAt).toEqual(original.startsAt);
    expect(parsed.endsAt).toEqual(original.endsAt);
    expect(parsed.endsAt.getTime() - parsed.startsAt.getTime()).toBe(original.endsAt.getTime() - original.startsAt.getTime());
    expect(parsed.timezone).toBe(zone);
    expect(parsed.endTimezone).toBe(endZone ?? null);
    const again = parseEvent(wrapSingleEvent(parsed))!;
    expect(again.startsAt).toEqual(original.startsAt);
    expect(again.endsAt).toEqual(original.endsAt);
    expect(again.timezone).toBe(zone);
    expect(again.endTimezone).toBe(endZone ?? null);
  });

  it("keeps the RFC first occurrence and ordinary local times in TZID form", () => {
    for (const original of [
      event("2026-11-01T05:30:00Z", "2026-11-01T05:45:00Z", "America/New_York"),
      event("2026-11-28T13:30:00Z", "2026-11-28T14:30:00Z", "Australia/Melbourne"),
    ]) {
      const serialized = serializeEvent(original);
      expect(serialized).toContain(`DTSTART;TZID=${original.timezone}:`);
      expect(serialized).toContain(`DTEND;TZID=${original.timezone}:`);
      expect(serialized).not.toContain("X-BYWAVE-");
      expect(parseEvent(serialized)?.startsAt).toEqual(original.startsAt);
      expect(parseEvent(serialized)?.endsAt).toEqual(original.endsAt);
    }
  });

  it("does not mistake existing second-resolution truncation for an ambiguous clock", () => {
    const original = event("2026-11-28T13:30:00.123Z", "2026-11-28T14:30:00.456Z", "Australia/Melbourne");
    expect(serializeEvent(original)).not.toContain("X-BYWAVE-");
    expect(parseEvent(serializeEvent(original))?.startsAt.toISOString()).toBe("2026-11-28T13:30:00.000Z");
  });

  it("leaves RRULE anchors and EXDATE wall clocks unchanged", () => {
    const serialized = serializeEvent({
      ...event("2026-11-01T06:30:00Z", "2026-11-01T07:30:00Z", "America/New_York"),
      rrule: "FREQ=WEEKLY;COUNT=3", exdates: ["2026-11-08T06:30:00Z"],
    });
    expect(serialized).toContain("DTSTART;TZID=America/New_York:20261101T013000");
    expect(serialized).toContain("EXDATE;TZID=America/New_York:20261108T013000");
    expect(serialized).toContain("RRULE:FREQ=WEEKLY;COUNT=3");
    expect(serialized).not.toContain("X-BYWAVE-");
  });

  it("leaves all-day DATE values and exclusive end dates unchanged", () => {
    const serialized = serializeEvent({ ...event("2026-11-01T00:00:00Z", "2026-11-02T00:00:00Z", "America/New_York"), allDay: true });
    expect(serialized).toContain("DTSTART;VALUE=DATE:20261101");
    expect(serialized).toContain("DTEND;VALUE=DATE:20261102");
    expect(serialized).not.toContain("TZID=");
    expect(serialized).not.toContain("X-BYWAVE-");
    const parsed = parseEvent(serialized)!;
    expect(parsed.allDay).toBe(true);
    expect(parsed.startsAt.toISOString()).toBe("2026-11-01T00:00:00.000Z");
    expect(parsed.endsAt.toISOString()).toBe("2026-11-02T00:00:00.000Z");
  });
});

describe("validated source-zone metadata", () => {
  it("canonicalizes supported aliases and preserves both labels without interpreting UTC as wall time", () => {
    const parsed = parsedWith(["X-BYWAVE-START-TIMEZONE;VALUE=TEXT:US/Eastern", "X-BYWAVE-END-TIMEZONE:Australia/Victoria"]);
    expect(parsed.timezone).toBe("America/New_York");
    expect(parsed.endTimezone).toBe("Australia/Melbourne");
    expect(parsed.startsAt.toISOString()).toBe("2026-11-01T06:30:00.000Z");
    expect(parsed.endsAt.toISOString()).toBe("2026-11-01T07:30:00.000Z");
  });

  it.each(["Not/A_Zone", "+08:00", " America/New_York", "America/New_York;STATUS=CANCELLED", "America/New_York\\nDTSTART:20260101T000000Z"])("rejects invalid source zone %j", (value) => {
    const parsed = parsedWith([`X-BYWAVE-START-TIMEZONE:${value}`, `X-BYWAVE-END-TIMEZONE:${value}`]);
    expect(parsed.timezone).toBeNull();
    expect(parsed.endTimezone).toBeNull();
    expect(serializeEvent(parsed)).not.toContain("X-BYWAVE-");
    expect(parsed.startsAt.toISOString()).toBe("2026-11-01T06:30:00.000Z");
  });

  it("ignores unknown properties and unsupported parameters", () => {
    const parsed = parsedWith(["X-BYWAVE-TIMEZONE:America/New_York", "X-BYWAVE-START-TIMEZONE;VALUE=URI:America/New_York", "X-BYWAVE-END-TIMEZONE;TZID=UTC:America/Chicago"]);
    expect(parsed.timezone).toBeNull();
    expect(parsed.endTimezone).toBeNull();
  });

  it("never overrides explicit TZID, floating times, all-day dates or recurring anchors", () => {
    const markers = ["X-BYWAVE-START-TIMEZONE:America/New_York", "X-BYWAVE-END-TIMEZONE:America/Chicago"];
    const zoned = parsedWith(markers, "DTSTART;TZID=Asia/Shanghai:20261101T143000", "DTEND;TZID=Asia/Shanghai:20261101T153000");
    expect(zoned.timezone).toBe("Asia/Shanghai");
    expect(zoned.endTimezone).toBeNull();
    expect(zoned.startsAt.toISOString()).toBe("2026-11-01T06:30:00.000Z");
    const floating = parsedWith(markers, "DTSTART:20261101T063000", "DTEND:20261101T073000");
    expect(floating.timezone).toBeNull();
    expect(floating.endTimezone).toBeNull();
    const allDay = parsedWith(markers, "DTSTART;VALUE=DATE:20261101", "DTEND;VALUE=DATE:20261102");
    expect(allDay.timezone).toBeNull();
    expect(allDay.endTimezone).toBeNull();
    const recurring = parsedWith([...markers, "RRULE:FREQ=WEEKLY"]);
    expect(recurring.timezone).toBeNull();
    expect(recurring.endTimezone).toBeNull();
    expect(recurring.startsAt.toISOString()).toBe("2026-11-01T06:30:00.000Z");
  });
});
