CREATE TABLE IF NOT EXISTS calendar_sync_accounts (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  account_id text NOT NULL, label text NOT NULL, client_id text NOT NULL,
  refresh_token text NOT NULL, lease uuid, lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS calendar_sync_pairs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES calendar_sync_accounts(user_id) ON DELETE CASCADE,
  calendar_id uuid NOT NULL REFERENCES calendars(id) ON DELETE CASCADE,
  remote_id text NOT NULL, remote_name text NOT NULL, enabled boolean NOT NULL DEFAULT true,
  state jsonb NOT NULL, conflicts jsonb NOT NULL DEFAULT '[]', error text,
  last_synced_at timestamptz, next_run_at timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS calendar_sync_calendar_unique ON calendar_sync_pairs(calendar_id);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS calendar_sync_remote_unique ON calendar_sync_pairs(user_id, remote_id);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS calendar_sync_logins (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  session_hash text NOT NULL, client_id text NOT NULL, device_code text NOT NULL,
  user_code text NOT NULL, verification_uri text NOT NULL, interval integer NOT NULL,
  expires_at timestamptz NOT NULL, next_poll_at timestamptz NOT NULL
);
