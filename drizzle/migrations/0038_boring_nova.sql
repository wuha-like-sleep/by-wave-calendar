ALTER TABLE "site_settings" ADD COLUMN "default_locale" text DEFAULT 'zh-CN' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "locale" text;