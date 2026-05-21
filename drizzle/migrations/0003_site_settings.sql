CREATE TABLE IF NOT EXISTS "site_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"site_name" text DEFAULT 'ByWave-Calendar' NOT NULL,
	"logo_url" text,
	"registration_mode" text DEFAULT 'public' NOT NULL,
	"icp_number" text,
	"icp_url" text DEFAULT 'https://beian.miit.gov.cn/',
	"sso_keycloak_enabled" boolean DEFAULT false NOT NULL,
	"sso_keycloak_issuer_url" text,
	"sso_keycloak_client_id" text,
	"sso_keycloak_client_secret" text,
	"sso_keycloak_label" text DEFAULT '使用 SSO 登录',
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- Seed the singleton row.
INSERT INTO "site_settings" ("id", "site_name", "registration_mode") VALUES (1, 'ByWave-Calendar', 'public') ON CONFLICT ("id") DO NOTHING;
