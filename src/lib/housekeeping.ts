import { lt, isNotNull, and } from "drizzle-orm";
import { db, schema } from "../db/client.js";

// Days after which soft-deleted events are physically purged. 90 days is
// long enough that the user can recover via DB backup if they realize a
// week later, but short enough that the table doesn't grow unbounded
// for power users who delete 10+ events a day.
const SOFT_DELETE_RETENTION_DAYS = 90;

// Once-a-day cron tick. Returns the count of rows purged for logging /
// admin dashboard metrics.
export async function purgeOldSoftDeletes(): Promise<{ events: number }> {
  const cutoff = new Date(Date.now() - SOFT_DELETE_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const result = await db
    .delete(schema.events)
    .where(and(
      isNotNull(schema.events.deletedAt),
      lt(schema.events.deletedAt, cutoff),
    ))
    .returning({ id: schema.events.id });
  return { events: result.length };
}

let started = false;
export function startHousekeepingScheduler(log: { info: (m: string) => void; warn: (m: unknown) => void }): void {
  if (started) return;
  started = true;

  const tick = async () => {
    try {
      const { events } = await purgeOldSoftDeletes();
      if (events > 0) {
        log.info(`[housekeeping] purged ${events} soft-deleted event(s) older than ${SOFT_DELETE_RETENTION_DAYS}d`);
      }
    } catch (err) {
      log.warn({ err });
    }
  };

  // First run 5 minutes after boot (don't compete with start-up traffic),
  // then daily. Daily is fine — the cutoff is 90 days; missing a day
  // doesn't matter.
  setTimeout(() => { void tick(); }, 5 * 60_000);
  setInterval(() => { void tick(); }, 24 * 60 * 60 * 1000);
  log.info(`housekeeping scheduler started (purge soft-deletes > ${SOFT_DELETE_RETENTION_DAYS}d, 1-day tick)`);
}
