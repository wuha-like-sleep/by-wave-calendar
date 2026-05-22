import { describe, it, expect } from "vitest";
import { serializeEvent, parseEvent, type IcalEvent } from "../src/lib/ical.js";

const D = (iso: string) => new Date(iso);

function baseEvent(): IcalEvent {
  return {
    uid: "abc-123",
    summary: "Team sync",
    startsAt: D("2026-06-01T10:00:00Z"),
    endsAt: D("2026-06-01T11:00:00Z"),
    allDay: false,
  };
}

describe("serializeEvent", () => {
  it("emits a basic VEVENT block", () => {
    const ics = serializeEvent(baseEvent());
    expect(ics).toContain("BEGIN:VEVENT");
    expect(ics).toContain("UID:abc-123");
    expect(ics).toContain("DTSTART:20260601T100000Z");
    expect(ics).toContain("DTEND:20260601T110000Z");
    expect(ics).toContain("SUMMARY:Team sync");
    expect(ics).toContain("END:VEVENT");
  });

  it("emits EXDATE lines for excluded occurrences", () => {
    const ics = serializeEvent({
      ...baseEvent(),
      rrule: "FREQ=WEEKLY",
      exdates: ["2026-06-08T10:00:00.000Z", "2026-06-15T10:00:00.000Z"],
    });
    expect(ics).toContain("RRULE:FREQ=WEEKLY");
    expect(ics).toContain("EXDATE:20260608T100000Z");
    expect(ics).toContain("EXDATE:20260615T100000Z");
  });

  it("emits all-day EXDATE with VALUE=DATE", () => {
    const ics = serializeEvent({
      ...baseEvent(),
      allDay: true,
      rrule: "FREQ=DAILY",
      exdates: ["2026-06-02T00:00:00.000Z"],
    });
    expect(ics).toContain("EXDATE;VALUE=DATE:20260602");
  });

  it("emits DTSTART;TZID with wall-clock time when timezone set", () => {
    // 10:00 UTC = 18:00 Asia/Shanghai. Expect 20260601T180000 (no Z).
    const ics = serializeEvent({
      ...baseEvent(),
      timezone: "Asia/Shanghai",
    });
    expect(ics).toContain("DTSTART;TZID=Asia/Shanghai:20260601T180000");
    expect(ics).toContain("DTEND;TZID=Asia/Shanghai:20260601T190000");
    // Should NOT also emit the Z-suffixed form.
    expect(ics).not.toMatch(/DTSTART:\d{8}T\d{6}Z/);
  });

  it("falls back to UTC Z form when timezone is null", () => {
    const ics = serializeEvent(baseEvent());
    expect(ics).toContain("DTSTART:20260601T100000Z");
    expect(ics).not.toMatch(/TZID=/);
  });

  it("captures DTSTART;TZID through parse → serialize round-trip", () => {
    const original = [
      "BEGIN:VEVENT",
      "UID:e1",
      "DTSTAMP:20260601T000000Z",
      "DTSTART;TZID=America/New_York:20260601T140000",
      "DTEND;TZID=America/New_York:20260601T150000",
      "SUMMARY:NY meeting",
      "END:VEVENT",
    ].join("\r\n");
    const parsed = parseEvent(original);
    expect(parsed?.timezone).toBe("America/New_York");
    // Round-trip: serialize the parsed event and confirm TZID survives.
    const reSerialized = serializeEvent(parsed!);
    expect(reSerialized).toContain("DTSTART;TZID=America/New_York:20260601T140000");
  });

  it("emits ORGANIZER and ATTENDEE lines when present", () => {
    const raw = serializeEvent({
      ...baseEvent(),
      organizer: "alice@example.com",
      attendees: [
        { email: "bob@example.com", cn: "Bob", partstat: "ACCEPTED" },
        { email: "carol@example.com" },
      ],
    });
    // RFC 5545 folds lines >75 chars (CRLF + space). Unfold for assertion.
    const ics = raw.replace(/\r?\n[\t ]/g, "");
    expect(ics).toContain("ORGANIZER:mailto:alice@example.com");
    expect(ics).toMatch(/ATTENDEE;CN=Bob;ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED;RSVP=TRUE:mailto:bob@example.com/);
    // Default PARTSTAT for attendees without explicit status:
    expect(ics).toMatch(/PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:carol@example.com/);
  });
});

describe("parseEvent", () => {
  it("round-trips a basic event", () => {
    const ics = serializeEvent(baseEvent());
    const parsed = parseEvent(ics);
    expect(parsed).not.toBeNull();
    expect(parsed!.uid).toBe("abc-123");
    expect(parsed!.summary).toBe("Team sync");
    expect(parsed!.startsAt.toISOString()).toBe("2026-06-01T10:00:00.000Z");
    expect(parsed!.allDay).toBe(false);
  });

  it("parses EXDATE with multiple comma-joined values", () => {
    const ics = [
      "BEGIN:VEVENT",
      "UID:e1",
      "DTSTAMP:20260601T000000Z",
      "DTSTART:20260601T100000Z",
      "DTEND:20260601T110000Z",
      "SUMMARY:Recurring",
      "RRULE:FREQ=WEEKLY",
      "EXDATE:20260608T100000Z,20260615T100000Z",
      "END:VEVENT",
    ].join("\r\n");
    const parsed = parseEvent(ics);
    expect(parsed?.exdates).toEqual([
      "2026-06-08T10:00:00.000Z",
      "2026-06-15T10:00:00.000Z",
    ]);
  });

  it("parses EXDATE across multiple lines", () => {
    const ics = [
      "BEGIN:VEVENT",
      "UID:e1",
      "DTSTAMP:20260601T000000Z",
      "DTSTART:20260601T100000Z",
      "DTEND:20260601T110000Z",
      "SUMMARY:Recurring",
      "RRULE:FREQ=WEEKLY",
      "EXDATE:20260608T100000Z",
      "EXDATE:20260615T100000Z",
      "END:VEVENT",
    ].join("\r\n");
    const parsed = parseEvent(ics);
    expect(parsed?.exdates).toHaveLength(2);
  });

  it("parses ATTENDEE with PARTSTAT and CN", () => {
    const ics = [
      "BEGIN:VEVENT",
      "UID:e1",
      "DTSTAMP:20260601T000000Z",
      "DTSTART:20260601T100000Z",
      "DTEND:20260601T110000Z",
      "SUMMARY:Meeting",
      "ATTENDEE;CN=Alice;ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED;RSVP=TRUE:mailto:alice@example.com",
      "ORGANIZER:mailto:bob@example.com",
      "END:VEVENT",
    ].join("\r\n");
    const parsed = parseEvent(ics);
    expect(parsed?.organizer).toBe("bob@example.com");
    expect(parsed?.attendees).toHaveLength(1);
    expect(parsed?.attendees?.[0]?.email).toBe("alice@example.com");
    expect(parsed?.attendees?.[0]?.partstat).toBe("ACCEPTED");
    expect(parsed?.attendees?.[0]?.cn).toBe("Alice");
  });

  it("returns null for an empty or malformed body", () => {
    expect(parseEvent("")).toBeNull();
    expect(parseEvent("hello world")).toBeNull();
    expect(parseEvent("BEGIN:VEVENT\r\nUID:no-dates\r\nEND:VEVENT")).toBeNull();
  });

  it("survives TZID-tagged DTSTART by treating wall-clock as that zone", () => {
    const ics = [
      "BEGIN:VEVENT",
      "UID:e1",
      "DTSTAMP:20260601T000000Z",
      "DTSTART;TZID=Asia/Shanghai:20260601T180000",
      "DTEND;TZID=Asia/Shanghai:20260601T190000",
      "SUMMARY:Asia event",
      "END:VEVENT",
    ].join("\r\n");
    const parsed = parseEvent(ics);
    // Shanghai is UTC+8, no DST → 18:00 local = 10:00 UTC.
    expect(parsed?.startsAt.toISOString()).toBe("2026-06-01T10:00:00.000Z");
  });
});
