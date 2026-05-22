-- Web Push notifications:
--
-- site_settings: store the VAPID key pair (generated once per deploy).
-- Persisting them is important — if we regenerated on each restart, all
-- existing subscriptions would silently fail.
--
-- push_subscriptions: one row per (user, browser/device) endpoint that
-- has granted push permission. Deleted automatically when the browser
-- revokes (HTTP 410 from the push service).

ALTER TABLE site_settings ADD COLUMN IF NOT EXISTS vapid_public_key TEXT;
ALTER TABLE site_settings ADD COLUMN IF NOT EXISTS vapid_private_key TEXT;
ALTER TABLE site_settings ADD COLUMN IF NOT EXISTS vapid_subject TEXT;

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS push_subscriptions_user_idx ON push_subscriptions (user_id);
CREATE UNIQUE INDEX IF NOT EXISTS push_subscriptions_endpoint_unique ON push_subscriptions (endpoint);
