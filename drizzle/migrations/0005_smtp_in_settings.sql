ALTER TABLE "site_settings" ADD COLUMN "smtp_host" text;--> statement-breakpoint
ALTER TABLE "site_settings" ADD COLUMN "smtp_port" integer DEFAULT 465;--> statement-breakpoint
ALTER TABLE "site_settings" ADD COLUMN "smtp_secure" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "site_settings" ADD COLUMN "smtp_user" text;--> statement-breakpoint
ALTER TABLE "site_settings" ADD COLUMN "smtp_pass" text;--> statement-breakpoint
ALTER TABLE "site_settings" ADD COLUMN "mail_from_address" text;--> statement-breakpoint
ALTER TABLE "site_settings" ADD COLUMN "mail_from_name" text DEFAULT 'ByWave-Calendar';