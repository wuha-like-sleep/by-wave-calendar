CREATE TABLE IF NOT EXISTS "api_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"label" text NOT NULL,
	"prefix" text NOT NULL,
	"token_hash" text NOT NULL,
	"scope" text DEFAULT 'write' NOT NULL,
	"last_used_at" timestamp with time zone,
	"last_used_ip" text,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "site_settings" ADD COLUMN "api_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "api_tokens_user_idx" ON "api_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "api_tokens_prefix_idx" ON "api_tokens" USING btree ("prefix");