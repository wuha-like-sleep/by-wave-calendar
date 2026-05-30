CREATE TABLE IF NOT EXISTS "signup_invites" (
	"token" text PRIMARY KEY NOT NULL,
	"email" text,
	"note" text,
	"created_by" uuid,
	"max_uses" integer DEFAULT 1 NOT NULL,
	"used_count" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "site_settings" ADD COLUMN "captcha_provider" text DEFAULT 'builtin' NOT NULL;--> statement-breakpoint
ALTER TABLE "site_settings" ADD COLUMN "captcha_site_key" text;--> statement-breakpoint
ALTER TABLE "site_settings" ADD COLUMN "captcha_secret" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "signup_invites" ADD CONSTRAINT "signup_invites_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
