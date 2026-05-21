-- Outbound webhooks. Two tables:
--
-- webhooks: the admin-configured destinations (label + URL + events
-- subscribed + optional HMAC secret + enabled flag).
--
-- webhook_deliveries: append-only log of every delivery attempt
-- (success or failure). Used by the admin UI to debug "did Zapier
-- get my event?" without scrolling pm2 logs.

CREATE TABLE IF NOT EXISTS webhooks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  label TEXT NOT NULL,
  url TEXT NOT NULL,
  events JSONB NOT NULL DEFAULT '["event.created","event.updated","event.deleted"]',
  secret TEXT,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  webhook_id UUID NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  event_name TEXT NOT NULL,
  payload JSONB,
  status_code INTEGER,
  response_body TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 1,
  ok BOOLEAN NOT NULL DEFAULT FALSE,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS webhook_deliveries_webhook_idx ON webhook_deliveries (webhook_id);
CREATE INDEX IF NOT EXISTS webhook_deliveries_created_idx ON webhook_deliveries (created_at);
