-- OAuth 2.0 authorization server: admin registers third-party apps
-- (clients), users grant consent at /oauth/authorize, we issue access
-- tokens scoped to specific permissions.
--
-- Three tables:
--   oauth_clients               — admin-registered third-party apps
--   oauth_authorization_codes   — short-lived (10 min) single-use codes
--   oauth_access_tokens         — user-granted, 30-day, revokable

CREATE TABLE IF NOT EXISTS oauth_clients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id TEXT NOT NULL,
  client_secret_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  logo_url TEXT,
  redirect_uris TEXT NOT NULL,
  allowed_scopes JSONB NOT NULL DEFAULT '["read:events"]',
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS oauth_clients_client_id_unique ON oauth_clients (client_id);

CREATE TABLE IF NOT EXISTS oauth_authorization_codes (
  code TEXT PRIMARY KEY,
  client_id UUID NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_challenge TEXT,
  redirect_uri TEXT NOT NULL,
  scopes JSONB NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS oauth_access_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash TEXT NOT NULL,
  prefix TEXT NOT NULL,
  client_id UUID NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scopes JSONB NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS oauth_access_tokens_prefix_idx ON oauth_access_tokens (prefix);
CREATE INDEX IF NOT EXISTS oauth_access_tokens_user_idx ON oauth_access_tokens (user_id);
