import { and, eq, isNull, sql } from "drizzle-orm";
import { db, schema } from "../../db/client.js";

const listeners = new Set<() => void>();
export function onCalendarSyncRequested(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function wakeCalendarSync(): void {
  for (const listener of listeners) listener();
}
/** Called after a local edit commits. DB state survives worker restarts.
 * A failed external connection keeps its Retry-After/backoff, and a paused
 * calendar must never be resumed by an edit. Periodic scanning is the fallback. */
export async function requestCalendarSync(calendarId: string): Promise<void> {
  await db.update(schema.calendarSyncPairs).set({ nextRunAt: new Date(),
    requestVersion: sql`${schema.calendarSyncPairs.requestVersion} + 1`,
  }).where(and(eq(schema.calendarSyncPairs.calendarId, calendarId), eq(schema.calendarSyncPairs.enabled, true), isNull(schema.calendarSyncPairs.error)));
  wakeCalendarSync();
}
