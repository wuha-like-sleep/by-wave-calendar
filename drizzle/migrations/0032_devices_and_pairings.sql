-- Native app / desktop client device registrations + one-time pairing codes.
--
-- devices:   one row per installed app instance. Holds the bcrypt-hashed
--            refresh token. Access tokens are JWTs derived on demand.
-- device_pairings: short-lived (5 min) one-time codes for the QR-scan
--            "bind new device" flow. Deleted by housekeeping after expiry.

CREATE TABLE IF NOT EXISTS devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label text NOT NULL,
  kind text NOT NULL DEFAULT 'other',
  refresh_token_hash text NOT NULL,
  refresh_token_prefix text NOT NULL,
  app_version text,
  push_token text,
  last_seen_at timestamptz,
  last_seen_ip text,
  first_seen_ip text,
  first_user_agent text,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS devices_user_idx ON devices (user_id);
CREATE INDEX IF NOT EXISTS devices_prefix_idx ON devices (refresh_token_prefix);

CREATE TABLE IF NOT EXISTS device_pairings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  claimed_device_id uuid,
  claimed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS device_pairings_code_idx ON device_pairings (code);
CREATE INDEX IF NOT EXISTS device_pairings_expires_idx ON device_pairings (expires_at);
