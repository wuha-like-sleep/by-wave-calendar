ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "notify_event_changes" boolean NOT NULL DEFAULT true;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "notify_inbox_push" boolean NOT NULL DEFAULT true;
