-- Booking link: opt-out for owner email notifications on new bookings.
-- The auto-generated diff included a lot of other table/column changes
-- (drizzle's meta journal was missing snapshots 0024-0035 locally, so
-- it re-emitted everything since 0023). Production already has all of
-- those — running the full diff would fail on existing columns. Trimmed
-- to the actual schema change for this release.
ALTER TABLE "booking_links" ADD COLUMN IF NOT EXISTS "notify_email" boolean DEFAULT true NOT NULL;
