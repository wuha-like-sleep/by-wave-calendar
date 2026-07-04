DROP INDEX IF EXISTS "events_rrule_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "events_deleted_at_idx";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "events_rrule_idx" ON "events" USING btree ("rrule") WHERE "events"."rrule" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "events_deleted_at_idx" ON "events" USING btree ("deleted_at") WHERE "events"."deleted_at" IS NOT NULL;