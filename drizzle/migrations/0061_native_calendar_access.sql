ALTER TABLE "app_passwords" ADD COLUMN IF NOT EXISTS "calendar_ids" jsonb;
--> statement-breakpoint
ALTER TABLE "app_passwords" ADD COLUMN IF NOT EXISTS "paused" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE "calendar_sync_pairs" ADD COLUMN IF NOT EXISTS "request_version" integer NOT NULL DEFAULT 0;
