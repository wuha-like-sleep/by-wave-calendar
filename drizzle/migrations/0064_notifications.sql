CREATE TABLE IF NOT EXISTS "notifications" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
  "type" text NOT NULL,
  "title" text NOT NULL,
  "body" text,
  "url" text,
  "read_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notifications_user_created_idx" ON "notifications" ("user_id", "created_at" DESC);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "notify_reminder_email" boolean NOT NULL DEFAULT true;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "notify_reminder_push" boolean NOT NULL DEFAULT true;
