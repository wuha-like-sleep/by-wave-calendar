// Bounded RRULE expansion. Without this, /api/events returns only the
// master row for recurring events and the in-app calendar grid renders
// daily/weekly meetings as a single occurrence at the original startsAt.
//
// We use the well-tested `rrule` library rather than rolling our own —
// RFC 5545 has too many edge cases (BYDAY with negative offsets, MONTHLY
// with BYSETPOS, leap-day YEARLY) to hand-roll without subtle bugs.

// rrule v2.x ships only a CommonJS build with a fake-ESM shim that doesn't
// expose named exports correctly in Node's strict ESM mode. Native named
// imports throw at module load:
//   SyntaxError: Named export 'rrulestr' not found.
// Workaround: default-import the whole module and destructure. The default
// export is the CJS module.exports object. We also pull the *type* RRule
// in via a type-only named import — TS strips type-only imports at
// runtime, so this doesn't trigger the CJS-named-export crash.
import rrulePkg from "rrule";
import type { RRule as RRuleType } from "rrule";
const { RRule, rrulestr } = rrulePkg as unknown as {
  RRule: typeof RRuleType;
  rrulestr: (s: string) => RRuleType;
};

// Soft cap on how many occurrences we'll emit per event in one expansion.
// Prevents a malicious or malformed RRULE (e.g. FREQ=SECONDLY) from
// blowing up the JSON payload. Reasonable for a UI that paints a month
// at a time.
const MAX_OCCURRENCES_PER_EVENT = 366;

export type EventForExpansion = {
  id: string;
  startsAt: Date;
  endsAt: Date;
  rrule: string | null;
};

export type ExpandedOccurrence = {
  // The master event's id stays the same for every occurrence — the client
  // distinguishes them by startsAt. This matches how Google Calendar / Toast
  // UI Calendar render recurring instances.
  id: string;
  startsAt: Date;
  endsAt: Date;
  isOccurrence: boolean;  // true for non-first occurrences
};

// Given an event with optional RRULE and a [from, to] window, return all
// occurrence start/end pairs that overlap the window. For non-recurring
// events this is just the single (startsAt, endsAt) pair (filtered to the
// window). For recurring events, expansion is bounded by:
//   - the rrule's own COUNT / UNTIL
//   - MAX_OCCURRENCES_PER_EVENT
//   - the requested [from, to] window
export function expandEvent(event: EventForExpansion, from: Date, to: Date): ExpandedOccurrence[] {
  const durationMs = event.endsAt.getTime() - event.startsAt.getTime();

  if (!event.rrule) {
    // Non-recurring: keep only if it actually overlaps the window. The DB
    // query that loaded this event has already filtered by the window for
    // master rows, but we double-check here so the helper is safe to call
    // standalone.
    if (event.endsAt < from || event.startsAt > to) return [];
    return [{ id: event.id, startsAt: event.startsAt, endsAt: event.endsAt, isOccurrence: false }];
  }

  let rule: RRuleType;
  try {
    // The DB stores just the RRULE: line (e.g. "FREQ=WEEKLY;BYDAY=MO"),
    // so prefix it with DTSTART before parsing. rrulestr accepts both
    // forms but DTSTART is needed for it to anchor occurrences.
    const dtstartUtc = event.startsAt.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    rule = rrulestr(`DTSTART:${dtstartUtc}\nRRULE:${event.rrule}`);
  } catch {
    // Malformed RRULE — fall back to just the master. Better to show
    // something than to crash the whole calendar grid.
    if (event.endsAt < from || event.startsAt > to) return [];
    return [{ id: event.id, startsAt: event.startsAt, endsAt: event.endsAt, isOccurrence: false }];
  }

  // rrule.between expects inclusive=true for the boundary instants. We pull
  // occurrences whose START is in [from - duration, to] so events that
  // START before `from` but END after `from` still get included.
  const expandFrom = new Date(from.getTime() - Math.max(0, durationMs));
  const starts = rule.between(expandFrom, to, true).slice(0, MAX_OCCURRENCES_PER_EVENT);

  const masterStartTime = event.startsAt.getTime();
  return starts.map((start: Date) => {
    const startMs = start.getTime();
    return {
      id: event.id,
      startsAt: start,
      endsAt: new Date(startMs + durationMs),
      isOccurrence: startMs !== masterStartTime,
    };
  });
}
