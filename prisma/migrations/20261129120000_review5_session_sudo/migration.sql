-- Review 5 M4: recent-authentication ("sudo") timestamp on the session. Changing the call handling mode or the forwarding number
-- needs the holder to have proved who they are within the last 5 minutes. Nullable, no backfill: existing sessions simply read as
-- "not recent" and ask once for the password.
ALTER TABLE "user_sessions" ADD COLUMN "sudo_at" TIMESTAMPTZ(6);
