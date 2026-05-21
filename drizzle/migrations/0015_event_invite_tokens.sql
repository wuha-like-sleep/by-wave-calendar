CREATE TABLE IF NOT EXISTS "event_invite_tokens" (
	"token" text PRIMARY KEY NOT NULL,
	"source_event_id" uuid NOT NULL,
	"recipient_email" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "event_invite_tokens" ADD CONSTRAINT "event_invite_tokens_source_event_id_events_id_fk" FOREIGN KEY ("source_event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "event_invite_tokens_event_idx" ON "event_invite_tokens" USING btree ("source_event_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "event_invite_tokens_email_idx" ON "event_invite_tokens" USING btree ("recipient_email");