import { describe, it, expect } from "vitest";
import { expandEvent } from "../src/lib/rrule_expand.js";

// All times in UTC for deterministic tests.
const D = (iso: string) => new Date(iso);

describe("expandEvent — non-recurring", () => {
  it("returns the master once when it overlaps the window", () => {
    const out = expandEvent(
      { id: "e1", startsAt: D("2026-06-01T10:00:00Z"), endsAt: D("2026-06-01T11:00:00Z"), rrule: null },
      D("2026-06-01T00:00:00Z"),
      D("2026-06-02T00:00:00Z"),
    );
    expect(out).toHaveLength(1);
    expect(out[0].isOccurrence).toBe(false);
    expect(out[0].startsAt.toISOString()).toBe("2026-06-01T10:00:00.000Z");
  });

  it("returns empty when the event is entirely outside the window", () => {
    const out = expandEvent(
      { id: "e1", startsAt: D("2026-06-01T10:00:00Z"), endsAt: D("2026-06-01T11:00:00Z"), rrule: null },
      D("2026-07-01T00:00:00Z"),
      D("2026-07-02T00:00:00Z"),
    );
    expect(out).toHaveLength(0);
  });

  it("falls back to master for a malformed RRULE rather than crashing", () => {
    const out = expandEvent(
      {
        id: "e1",
        startsAt: D("2026-06-01T10:00:00Z"),
        endsAt: D("2026-06-01T11:00:00Z"),
        rrule: "this is not a valid RRULE",
      },
      D("2026-06-01T00:00:00Z"),
      D("2026-06-02T00:00:00Z"),
    );
    expect(out).toHaveLength(1);
    expect(out[0].isOccurrence).toBe(false);
  });
});

describe("expandEvent — recurring", () => {
  it("expands a weekly RRULE across the window", () => {
    // Monday 2026-06-01 10:00–11:00, weekly on Monday for 4 weeks.
    const out = expandEvent(
      {
        id: "e2",
        startsAt: D("2026-06-01T10:00:00Z"),
        endsAt: D("2026-06-01T11:00:00Z"),
        rrule: "FREQ=WEEKLY;COUNT=4",
      },
      D("2026-06-01T00:00:00Z"),
      D("2026-07-31T00:00:00Z"),
    );
    expect(out).toHaveLength(4);
    expect(out[0].isOccurrence).toBe(false);
    expect(out[1].isOccurrence).toBe(true);
    // Endings shift in lockstep with starts (duration preserved).
    expect(out[1].endsAt.getTime() - out[1].startsAt.getTime()).toBe(60 * 60 * 1000);
  });

  it("skips occurrences listed in exdates", () => {
    const out = expandEvent(
      {
        id: "e3",
        startsAt: D("2026-06-01T10:00:00Z"),
        endsAt: D("2026-06-01T11:00:00Z"),
        rrule: "FREQ=WEEKLY;COUNT=4",
        // Exclude the second instance (2026-06-08).
        exdates: ["2026-06-08T10:00:00.000Z"],
      },
      D("2026-06-01T00:00:00Z"),
      D("2026-07-31T00:00:00Z"),
    );
    expect(out).toHaveLength(3);
    const dates = out.map((o) => o.startsAt.toISOString());
    expect(dates).not.toContain("2026-06-08T10:00:00.000Z");
    expect(dates).toContain("2026-06-15T10:00:00.000Z");
  });

  it("respects UNTIL bounds inside the RRULE", () => {
    const out = expandEvent(
      {
        id: "e4",
        startsAt: D("2026-06-01T10:00:00Z"),
        endsAt: D("2026-06-01T11:00:00Z"),
        rrule: "FREQ=WEEKLY;UNTIL=20260615T100000Z",
      },
      D("2026-06-01T00:00:00Z"),
      D("2026-07-31T00:00:00Z"),
    );
    // Inclusive UNTIL: 06-01, 06-08, 06-15 — three instances.
    expect(out.length).toBe(3);
  });

  it("includes recurring events that started before the window if any occurrence overlaps", () => {
    const out = expandEvent(
      {
        id: "e5",
        startsAt: D("2026-01-01T10:00:00Z"),
        endsAt: D("2026-01-01T11:00:00Z"),
        rrule: "FREQ=WEEKLY",
      },
      D("2026-06-01T00:00:00Z"),
      D("2026-06-07T00:00:00Z"),
    );
    // Five months later there should still be weekly occurrences.
    expect(out.length).toBeGreaterThanOrEqual(1);
    // First occurrence in the window has isOccurrence=true (master is in January).
    expect(out[0].isOccurrence).toBe(true);
  });
});

describe("expandEvent — bounded expansion (DoS guard)", () => {
  it("caps a long-running daily RRULE at 366 occurrences over a multi-year window", () => {
    // 3 years of a daily event = ~1095 occurrences; the iterator must halt
    // at MAX_OCCURRENCES_PER_EVENT (366) instead of materializing them all.
    const out = expandEvent(
      { id: "e1", startsAt: D("2026-01-01T09:00:00Z"), endsAt: D("2026-01-01T10:00:00Z"), rrule: "FREQ=DAILY" },
      D("2026-01-01T00:00:00Z"),
      D("2029-01-01T00:00:00Z"),
    );
    expect(out).toHaveLength(366);
  });

  it("bounds a pathological sub-daily RRULE quickly without exploding", () => {
    // FREQ=HOURLY over a month is ~744 occurrences; without the iterator cap
    // this would materialize all of them first. Must return fast + bounded.
    const t0 = Date.now();
    const out = expandEvent(
      { id: "e1", startsAt: D("2026-01-01T00:00:00Z"), endsAt: D("2026-01-01T00:30:00Z"), rrule: "FREQ=HOURLY" },
      D("2026-01-01T00:00:00Z"),
      D("2026-02-01T00:00:00Z"),
    );
    expect(out.length).toBeLessThanOrEqual(366);
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});
