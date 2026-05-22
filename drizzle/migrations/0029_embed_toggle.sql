-- Global on/off for the /embed/<token> iframe widget. Default TRUE so
-- existing share tokens keep working; admin can flip OFF if they don't
-- want third-party sites embedding the calendar.
ALTER TABLE site_settings ADD COLUMN IF NOT EXISTS embed_enabled BOOLEAN NOT NULL DEFAULT TRUE;
