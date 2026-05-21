ALTER TABLE "site_settings" ADD COLUMN "risk_login_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "site_settings" ADD COLUMN "lockout_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "site_settings" ADD COLUMN "lockout_threshold" integer DEFAULT 5 NOT NULL;--> statement-breakpoint
ALTER TABLE "site_settings" ADD COLUMN "lockout_minutes" integer DEFAULT 15 NOT NULL;