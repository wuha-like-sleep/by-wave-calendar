ALTER TABLE "site_settings" ADD COLUMN IF NOT EXISTS "ios_announcement_enabled" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE "site_settings" ADD COLUMN IF NOT EXISTS "ios_announcement_version" text;
--> statement-breakpoint
ALTER TABLE "site_settings" ADD COLUMN IF NOT EXISTS "ios_announcement_title" text;
--> statement-breakpoint
ALTER TABLE "site_settings" ADD COLUMN IF NOT EXISTS "ios_announcement_body" text;
--> statement-breakpoint
ALTER TABLE "site_settings" ADD COLUMN IF NOT EXISTS "ios_announcement_store_url" text;
--> statement-breakpoint
ALTER TABLE "site_settings" ADD COLUMN IF NOT EXISTS "ios_announcement_published_at" timestamp with time zone;
