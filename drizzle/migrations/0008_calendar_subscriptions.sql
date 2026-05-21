CREATE TABLE IF NOT EXISTS "calendar_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"calendar_id" uuid NOT NULL,
	"url" text NOT NULL,
	"label" text,
	"refresh_minutes" integer DEFAULT 360 NOT NULL,
	"last_fetched_at" timestamp with time zone,
	"last_status" text,
	"last_error" text,
	"last_event_count" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "calendar_subscriptions" ADD CONSTRAINT "calendar_subscriptions_calendar_id_calendars_id_fk" FOREIGN KEY ("calendar_id") REFERENCES "public"."calendars"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "calendar_subscriptions_cal_idx" ON "calendar_subscriptions" USING btree ("calendar_id");