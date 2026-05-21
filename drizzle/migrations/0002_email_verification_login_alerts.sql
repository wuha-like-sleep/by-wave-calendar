CREATE TABLE IF NOT EXISTS "email_verifications" (
	"email" text PRIMARY KEY NOT NULL,
	"code_hash" text NOT NULL,
	"payload" jsonb NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "login_alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"ip_hash" text NOT NULL,
	"ua_hash" text NOT NULL,
	"last_sent_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "email_verified" boolean DEFAULT false NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "login_alerts" ADD CONSTRAINT "login_alerts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "login_alerts_user_idx" ON "login_alerts" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "login_alerts_user_ip_ua_unique" ON "login_alerts" USING btree ("user_id","ip_hash","ua_hash");--> statement-breakpoint
-- Backfill: 现有用户视为已验证（迁移前注册的）
UPDATE "users" SET "email_verified" = true WHERE "email_verified" = false;
