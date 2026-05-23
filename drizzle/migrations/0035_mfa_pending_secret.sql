-- Pending TOTP secret used during the 2-step MFA enrollment flow:
--   1. Server mints a fresh secret, stashes it here
--   2. User enters a 6-digit code from their authenticator app
--   3. On successful verify, server promotes pending → mfa_totp_secret
--      and enables MFA. Pending is cleared on disable / re-setup too.
--
-- Nullable: only set during the brief window between setup-init and
-- verify. Cleared otherwise.

ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_pending_secret text;
