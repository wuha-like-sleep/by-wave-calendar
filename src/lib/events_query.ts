import { and, asc, gte, inArray, isNotNull, isNull, lte, or } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import type { Event } from "../db/schema.js";

/**
 * Select the event MASTER rows that can contribute an occurrence to the
 * window [fromDate, toDate] for the given (already access-checked) calendar
 * ids, ordered by start.
 *
 * A master qualifies when it starts on/before the window end AND either:
 *   - it's non-recurring and its own [startsAt, endsAt] overlaps the window
 *     (endsAt >= fromDate), or
 *   - it's recurring (rrule IS NOT NULL) — kept regardless of the master's
 *     own endsAt, because a weekly/monthly series created long ago still has
 *     occurrences landing inside the window.
 *
 * Callers pass each row through expandEvent(), which trims non-recurring rows
 * to the exact window and materializes recurring occurrences.
 *
 * NB: the recurring branch is load-bearing. Approximating the OR with a
 * widened `endsAt >= fromDate - 1y` (as an earlier version did) silently drops
 * any recurring master whose start/end predates the window by over a year —
 * its occurrences vanish from the grid.
 */
export function fetchEventMastersInWindow(
  allowed: string[],
  fromDate: Date,
  toDate: Date,
): Promise<Event[]> {
  return db
    .select()
    .from(schema.events)
    .where(
      and(
        inArray(schema.events.calendarId, allowed),
        lte(schema.events.startsAt, toDate),
        or(
          gte(schema.events.endsAt, fromDate),
          isNotNull(schema.events.rrule),
        ),
        isNull(schema.events.deletedAt),
      ),
    )
    .orderBy(asc(schema.events.startsAt));
}
