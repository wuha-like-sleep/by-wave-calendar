-- Adds a stable per-install identifier so re-login from the same physical
-- device reuses the existing devices row instead of creating a new one.
--
-- The APP generates this UUID once and persists it in iCloud Keychain;
-- it survives uninstall + reinstall on the same Apple ID. The server
-- treats (user_id, client_device_id) as the dedup key on pair-claim and
-- password-login. Old devices rows have NULL here and behave as before
-- (every login = new row), which is the safest backfill.

ALTER TABLE devices ADD COLUMN IF NOT EXISTS client_device_id text;

-- Partial unique index — only enforces uniqueness for live (non-revoked)
-- devices, so a previously revoked row doesn't block a new sign-in from
-- the same physical phone.
CREATE UNIQUE INDEX IF NOT EXISTS devices_user_client_idx
  ON devices (user_id, client_device_id)
  WHERE client_device_id IS NOT NULL AND revoked_at IS NULL;
