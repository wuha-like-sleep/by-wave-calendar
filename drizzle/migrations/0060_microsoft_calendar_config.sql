-- NULL preserves deployments already configured through the environment.
-- Empty string explicitly stops new connections; existing accounts retain
-- their original client ID and credentials.
ALTER TABLE site_settings ADD COLUMN IF NOT EXISTS microsoft_calendar_client_id text;
