-- Performance indexes on events. Backfill — existing rows already exist,
-- these just add covering indexes to hot query paths.
--
--  events_cal_deleted_idx: every CalDAV REPORT and /api/events query
--    filters by (calendar_id AND deleted_at IS NULL). The single-column
--    calendar_idx still requires a heap re-scan to evaluate deleted_at;
--    the composite resolves both predicates from the index alone.
--
--  events_rrule_idx: the reminders cron scans WHERE rrule IS NOT NULL
--    every minute. Without this it does a full table scan once a minute,
--    quadratic with table growth.
--
--  events_deleted_at_idx: the soft-delete purge cron (running once a day)
--    queries WHERE deleted_at < (now - 90 days). Sequential scan without
--    this; quick range scan with it.
--
-- All three use CREATE INDEX IF NOT EXISTS to stay idempotent — running
-- the migration twice (or on a DB that already has them) is safe.

CREATE INDEX IF NOT EXISTS events_cal_deleted_idx ON events (calendar_id, deleted_at);
CREATE INDEX IF NOT EXISTS events_rrule_idx ON events (rrule);
CREATE INDEX IF NOT EXISTS events_deleted_at_idx ON events (deleted_at);
