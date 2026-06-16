ALTER TABLE "site_settings" ADD COLUMN "idp_api_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "site_settings" ADD COLUMN "idp_api_service_clients" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "site_settings" ADD COLUMN "idp_api_auto_provision" boolean DEFAULT false NOT NULL;