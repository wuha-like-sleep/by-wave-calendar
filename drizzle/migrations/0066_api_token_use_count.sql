ALTER TABLE "api_tokens" ADD COLUMN IF NOT EXISTS "use_count" integer NOT NULL DEFAULT 0;
