# Google Calendar (two-way sync)

Owners connect ONE Google calendar per business (Settings > Google Calendar).

- **Google -> us**: the times of the owner's events become read-only busy blocks. The receptionist never offers or books those times (`check_availability`, `nextAvailable`, `createBooking`, `rescheduleBooking`).
- **us -> Google**: every booking (created, updated, rescheduled, cancelled, completed) is written to that calendar as an event.

## Setup (operator)

1. Google Cloud console > APIs & Services > enable **Google Calendar API**.
2. OAuth consent screen: user type External, app name, support email, the privacy policy URL, authorized domain. Add the scopes below.
3. Credentials > Create OAuth client ID > **Web application**. Authorized redirect URI: `https://<APP_URL host>/api/integrations/google/callback` (exactly `GOOGLE_OAUTH_REDIRECT_URI`).
4. Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `APP_URL=https://...` (push notifications need https), optionally `GOOGLE_WEBHOOK_SECRET` (docs/env-vars.md). `deploy.sh` checks them. Public ingress must reach `POST /api/integrations/google/webhook`.
5. Local development without Google: `GOOGLE_OAUTH_MOCK=true` (never honoured in production).

### Verification and scopes

| Scope | Why | Class |
|---|---|---|
| `https://www.googleapis.com/auth/calendar.events` | read events (sync, push channel), create/update/delete the booking events | **sensitive** |
| `https://www.googleapis.com/auth/calendar.calendarlist.readonly` | list calendars to pick one; the primary calendar id is the account email | sensitive |

Sensitive scopes require Google's OAuth app verification before the consent screen stops showing "unverified app" and the 100-user cap applies (in Testing mode: add owners as test users; refresh tokens then expire after 7 days). Verification needs: a verified domain, a public privacy policy that states the Limited Use disclosure below, a demo video of the consent flow and of each scope in use, and a scope justification. No restricted scope is requested.

### Limited Use compliance

Use of data received from Google APIs adheres to the Google API Services User Data Policy, including the Limited Use requirements: data is used only to provide the user-facing scheduling feature (blocking busy time, adding bookings), is not transferred to others except as needed to provide it or to comply with law, is not used for advertising, and no human reads it unless the user asks for support or it is required for security or law. Put this sentence in your privacy policy.

## What is stored (data handling)

| Data | Where | Notes |
|---|---|---|
| Access + refresh token | `calendar_connections`, AES-256-GCM envelopes (`APP_SECRET_KEY`, bound to the row id) | never returned by any API, never logged, never in audit meta or errors |
| Busy blocks | `calendar_busy_blocks` | start, end, all-day flag, free/busy only. **No title, description, location or attendee is stored** (and the API request uses `fields=` so they are not even downloaded) |
| Event links | `calendar_event_links` | booking id, Google event id, etag, hash of what we pushed |
| "Block on busy" switch | `calendar_connections.block_on_busy` (boolean, default true; migration `20261202120000_integration_gaps` moved it from the latest `calendar.settings_changed` audit event and back-filled it). Every change is still audited as `calendar.settings_changed`. It survives a disconnect/reconnect of the same business | default ON |

Events we push live in the **owner's own calendar** and contain the customer's first name in the title and the customer's full name, phone, address and the call summary in the description (`<service> — <first name>`). Google's default reminders apply. Anyone the owner shares that calendar with can read them: tell owners.

## Behaviour

- **Connect**: OAuth 2.0 authorization code + PKCE (S256), `access_type=offline`, `prompt=consent`. `state` is HMAC-signed (APP_SECRET_KEY), expires in 10 minutes, is bound to user + business + session and is single use; the PKCE verifier travels only in an encrypted HttpOnly cookie. A redirect, so the CSP needs no change.
- **Sync**: `events.list` with `singleEvents=true` (recurring series arrive as instances; DST is Google's), window [now - 1 day, now + 180 days]; incremental by `syncToken`; HTTP 410 clears the token and does a full resync; a full resync also runs daily so the window rolls. All-day events are whole LOCAL days of the business zone (23 or 25 hours on DST days). Free ("transparent"), declined, working-location and birthday events do not block. Our own booking events never block (link row, plus a private marker on the event as a second guard).
- **Push notifications**: `events.watch` channel (about 7 days, renewed 24 h before expiry), token = HMAC(channel). `POST /api/integrations/google/webhook` verifies channel id, resource id and token in constant time, always answers 200 immediately and syncs in the background; concurrent syncs are coalesced by a lease. The 15-minute poll is the fallback and the source of truth.
- **Failures**: invalid_grant / revoked / calendar gone -> `needs_reauth`: the owner is emailed once, blocks are IGNORED (fail open), Settings shows Reconnect. Transient errors -> status `error`, exponential backoff (15 min x 2^n, max 6 h), `needs_reauth` after 10 consecutive failures. Audit: `calendar.connected`, `calendar.disconnected`, `calendar.sync_failed`, `calendar.needs_reauth`, `calendar.calendar_changed`.
- **Stale-sync tolerance**: while a connection is `active` or `error` the last known blocks are enforced, however old (a Google outage must not reopen the owner's busy time). With push working the lag is seconds; with polling only, up to 15 minutes, so a time the owner added in Google within that window can still be booked. The booking transaction re-checks the stored blocks, not Google live.
- **Owner edits to booking events**: moving/editing/deleting a pushed event NEVER changes or cancels the booking and never texts the customer. It records `calendar.event_changed_externally` and a notice appears in Settings > Google Calendar. If the booking itself changes later, the push uses `If-Match`; on a conflict the booking's change is applied and the conflict is audited.
- **Booking enforcement**: `createBooking` / `rescheduleBooking` re-check busy blocks inside the transaction (same advisory lock) -> `BookingRejectedError('calendar_busy')`; the voice agent says "We are not available at that time" and offers alternatives. `enforce: false` (seed/admin) skips it.
- **Idempotency**: the event id is derived from the booking id; a retry after a lost response gets 409 and adopts the existing event. Unchanged bookings are not pushed again (hash).

## Privacy

- **Erasure / retention purge**: the Google events of anonymised bookings are deleted (immediately after the erasure commits; any that fail stay linked and the `google_calendar` job retries them).
- **Disconnect** (`DELETE /api/integrations/google/disconnect`): channel stopped, token revoked at Google, tokens, sync token and busy blocks wiped. Events already in the owner's calendar stay (they are the owner's appointments) unless `?delete_events=true` (the Settings dialog offers it). After a disconnect without deleting, erasure can no longer remove those events from Google: ask the owner to delete them, or disconnect with deletion first.

- **Events that could not be removed from a previous account** (switching to a DIFFERENT Google account whose old tokens are dead, a calendar switch that Google refuses, or "disconnect + remove events" that fails): the pushed event ids are kept in `calendar_orphaned_events` (event id, old calendar id and account email, service and start time of the booking; no customer name / phone / address, no token) and the Google card says "N events from the previous account could not be removed. Remove them in Google Calendar." until the owner dismisses it (`DELETE /api/integrations/google/orphans`). We cannot delete them ourselves (no old token is kept); the events still contain what was pushed in the owner's old calendar. Customer erasure blanks the listed row's booking id and service (the reminder stays). Not recorded: events left on purpose by a plain disconnect.

## Routes

| Route | Who | Notes |
|---|---|---|
| `GET /api/integrations/google/connect` | owner (admin with `?business_id=`) | 302 to Google |
| `GET /api/integrations/google/callback` | owner session that started it | validates state + PKCE |
| `DELETE /api/integrations/google/disconnect` | owner | CSRF checked for cookies |
| `GET /api/integrations/google/status` | staff+ | health, last sync, external-change notices, events that could not be removed from a previous account |
| `DELETE /api/integrations/google/orphans` | owner | dismiss the "could not be removed" reminder (all, or `{ids}`); audited |
| `GET /api/integrations/google/calendars` | owner | writable calendars |
| `PATCH /api/integrations/google/calendar` | owner | `{ calendar_id?, block_on_busy? }` |
| `GET /api/integrations/google/busy?from&to` | staff+ | times only, for the calendar overlay |
| `POST /api/integrations/google/webhook` | public path, channel-authenticated | always 200 |

## Troubleshooting

- *redirect_uri_mismatch*: the console URI differs from `GOOGLE_OAUTH_REDIRECT_URI` / `${APP_URL}/api/integrations/google/callback`.
- *Connect returns "no_refresh_token"*: the owner must remove the app at myaccount.google.com/permissions and connect again (we always send `prompt=consent`).
- *No instant updates*: `APP_URL` is not https or the webhook is not reachable; the 15-minute poll still works. Settings shows "checked every 15 minutes".
- *Refresh token expires after 7 days*: the consent screen is in Testing mode; publish/verify the app.
- *Status needs reconnect*: password change / revoked access / deleted calendar. Owner clicks Reconnect; links and history are kept, and **the calendar the owner picked is kept** when the same Google account reconnects. Connecting a DIFFERENT account first deletes the pushed events of the previous account through the old tokens (the ones that cannot be deleted because the old tokens are dead stay in that account's calendar; the count is in the `calendar.connected` audit meta `old_events_not_deleted`), drops the links and blocks and starts on that account's `primary`.
- *Switching the calendar / disconnecting while a sync runs*: the switch waits (up to 20 s, else 409 `try again`) for the connection's sync lease; sync and watch writes are conditional on the calendar they read, so the OLD calendar's blocks, sync token or push channel can never land on the new one. Disconnect is terminal for in-flight work: a refresh, sync or failure that finishes afterwards cannot reactivate it or write tokens/blocks. A 403/404 on a connection that was already in `error` ends in `needs_reauth` (stale blocks stop gating bookings).
- *Two businesses sharing one calendar*: an event is "ours" only when it is linked to this connection or its `rc_booking` marker names a booking of THIS business; the other business's booking events are normal busy time.
- Admin: `POST /api/admin/jobs/run {"job":"google_calendar"}` runs one pass now (connections that are due).
