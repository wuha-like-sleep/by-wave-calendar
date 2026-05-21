ALTER TABLE "calendars" ALTER COLUMN "timezone" SET DEFAULT 'Asia/Shanghai';
-- Backfill existing calendars stuck on UTC (the prior default) so users in
-- Shanghai aren't seeing event times that match server log UTC.
UPDATE "calendars" SET "timezone" = 'Asia/Shanghai' WHERE "timezone" = 'UTC';
