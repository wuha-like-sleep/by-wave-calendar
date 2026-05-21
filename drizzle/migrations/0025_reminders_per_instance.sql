-- reminders_sent needs a per-occurrence key so recurring events get
-- reminded every time, not just on the first occurrence.
--
-- Before: unique (event_id, trigger) — a weekly meeting with a
-- "-PT15M" alarm only fires once, ever.
-- After:  unique (event_id, trigger, instance_start) — each occurrence
-- gets its own row.

ALTER TABLE reminders_sent ADD COLUMN IF NOT EXISTS instance_start TIMESTAMPTZ;

-- Backfill existing rows: they came from non-recurring sends only,
-- so the instance_start equals the event's starts_at.
UPDATE reminders_sent rs
SET instance_start = e.starts_at
FROM events e
WHERE rs.event_id = e.id AND rs.instance_start IS NULL;

ALTER TABLE reminders_sent ALTER COLUMN instance_start SET NOT NULL;

DROP INDEX IF EXISTS reminders_sent_event_trigger_unique;
CREATE UNIQUE INDEX IF NOT EXISTS reminders_sent_event_trigger_instance_unique
  ON reminders_sent (event_id, trigger, instance_start);
