-- Per-instance exclusions for recurring event masters.
--
-- When a user deletes "just this occurrence" of a weekly meeting (or
-- detaches it via edit-仅此次), we append the original instance start
-- (ISO timestamp string) to this JSONB array on the master row.
-- rrule_expand.ts reads it and skips matching occurrences during
-- expansion. Null/empty for non-recurring or never-modified events.
--
-- Could be normalized into its own table, but: typical recurring events
-- have very few exceptions in practice (<10), JSONB read is single-row,
-- and we already store other per-event metadata in events.extra as JSON.
-- Single-column write keeps the edit handler simple.

ALTER TABLE events ADD COLUMN IF NOT EXISTS exdates JSONB;
