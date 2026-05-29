ALTER TABLE "users" ADD COLUMN "apple_sub" text;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "users_apple_sub_unique" ON "users" USING btree ("apple_sub");