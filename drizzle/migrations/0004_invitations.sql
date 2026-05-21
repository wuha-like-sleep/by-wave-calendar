CREATE TABLE IF NOT EXISTS "calendar_invitations" (
	"token" text PRIMARY KEY NOT NULL,
	"calendar_id" uuid NOT NULL,
	"email" text NOT NULL,
	"role" text DEFAULT 'viewer' NOT NULL,
	"invited_by" uuid NOT NULL,
	"message" text,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "calendar_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"calendar_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text DEFAULT 'viewer' NOT NULL,
	"invited_by" uuid,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "calendar_invitations" ADD CONSTRAINT "calendar_invitations_calendar_id_calendars_id_fk" FOREIGN KEY ("calendar_id") REFERENCES "public"."calendars"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "calendar_invitations" ADD CONSTRAINT "calendar_invitations_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "calendar_members" ADD CONSTRAINT "calendar_members_calendar_id_calendars_id_fk" FOREIGN KEY ("calendar_id") REFERENCES "public"."calendars"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "calendar_members" ADD CONSTRAINT "calendar_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "calendar_members" ADD CONSTRAINT "calendar_members_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "calendar_invitations_cal_idx" ON "calendar_invitations" USING btree ("calendar_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "calendar_invitations_email_idx" ON "calendar_invitations" USING btree ("email");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "calendar_members_cal_idx" ON "calendar_members" USING btree ("calendar_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "calendar_members_user_idx" ON "calendar_members" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "calendar_members_cal_user_unique" ON "calendar_members" USING btree ("calendar_id","user_id");