-- Review 4 F8: the background jobs read "live businesses" every tick. Index the status they filter on.
CREATE INDEX "businesses_status_idx" ON "businesses"("status");
