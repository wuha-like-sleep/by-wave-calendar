CREATE TABLE IF NOT EXISTS "booking_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"calendar_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"duration_minutes" integer DEFAULT 30 NOT NULL,
	"weekly_availability" jsonb NOT NULL,
	"min_notice_hours" integer DEFAULT 2 NOT NULL,
	"max_days_ahead" integer DEFAULT 14 NOT NULL,
	"buffer_before_min" integer DEFAULT 0 NOT NULL,
	"buffer_after_min" integer DEFAULT 0 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "bookings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"link_id" uuid NOT NULL,
	"event_id" uuid,
	"guest_email" text NOT NULL,
	"guest_name" text NOT NULL,
	"guest_message" text,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"cancel_token" text NOT NULL,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "booking_links" ADD CONSTRAINT "booking_links_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "booking_links" ADD CONSTRAINT "booking_links_calendar_id_calendars_id_fk" FOREIGN KEY ("calendar_id") REFERENCES "public"."calendars"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bookings" ADD CONSTRAINT "bookings_link_id_booking_links_id_fk" FOREIGN KEY ("link_id") REFERENCES "public"."booking_links"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bookings" ADD CONSTRAINT "bookings_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "booking_links_user_slug_unique" ON "booking_links" USING btree ("user_id","slug");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "booking_links_user_idx" ON "booking_links" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bookings_link_idx" ON "bookings" USING btree ("link_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "bookings_cancel_token_unique" ON "bookings" USING btree ("cancel_token");