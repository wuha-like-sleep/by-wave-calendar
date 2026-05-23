-- Master switch for the native iOS / Android / desktop APP feature.
-- Default true so existing installations keep working after upgrade;
-- admins can flip off from /admin/api or via install.sh prompt.
--
-- When false:
--   - All /api/v1/devices/* and /api/v1/auth/refresh return 403
--   - JWT bearer auth (device sessions) is refused → paired apps stop working
--   - The "Pair new device" button in /app/settings#devices is hidden

ALTER TABLE site_settings ADD COLUMN IF NOT EXISTS apps_enabled boolean NOT NULL DEFAULT true;
