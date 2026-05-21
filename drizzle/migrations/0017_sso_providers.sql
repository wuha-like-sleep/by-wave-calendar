CREATE TABLE IF NOT EXISTS "sso_providers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"provider_kind" text DEFAULT 'oidc' NOT NULL,
	"slug" text NOT NULL,
	"issuer_url" text NOT NULL,
	"client_id" text NOT NULL,
	"client_secret" text NOT NULL,
	"label" text DEFAULT 'SSO 登录' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "sso_provider_slug" text;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sso_providers_slug_unique" ON "sso_providers" USING btree ("slug");--> statement-breakpoint
-- Backfill the legacy single-Keycloak config (if previously enabled) into a row
-- so existing deployments keep working after upgrade without re-entering creds.
INSERT INTO "sso_providers" ("slug", "enabled", "issuer_url", "client_id", "client_secret", "label", "sort_order")
SELECT
  'keycloak',
  "sso_keycloak_enabled",
  "sso_keycloak_issuer_url",
  "sso_keycloak_client_id",
  COALESCE("sso_keycloak_client_secret", ''),
  COALESCE("sso_keycloak_label", '使用 SSO 登录'),
  0
FROM "site_settings"
WHERE "id" = 1
  AND "sso_keycloak_issuer_url" IS NOT NULL
  AND "sso_keycloak_client_id" IS NOT NULL
ON CONFLICT ("slug") DO NOTHING;