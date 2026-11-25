# Build Contracts — Recepcionista

Read this before writing code. Do not edit files you do not own.

## Environment

Node/bun are NOT on PATH by default. Every shell command must start with:

```sh
export PATH="/opt/homebrew/bin:$HOME/.bun/bin:$PATH"
```

Run dev server: `bun dev` (port 3000). Typecheck: `bunx tsc --noEmit`. Do NOT
run `bun install` (deps are installed).

## Already built — use, do not rewrite

| Path | What it gives you |
| --- | --- |
| `src/lib/types.ts` | ALL domain types. `Business`, `KnowledgeBase`, `Call`, `Booking`, `Briefing`, `SmsLog`, `ExtractionResult`, `TimeSlot`, `PaymentLink`, `ApiResult<T>` |
| `src/lib/db/index.ts` | `listBusinesses, getBusiness, getBusinessByPhone, createBusiness, updateBusiness, getKnowledgeBase, upsertKnowledgeBase, createCall, updateCall, getCall, listCalls, createBooking, listBookings, getBooking, updateBooking, getBookedSlots, createBriefing, listBriefings, getLatestBriefing, logSms, listSms, newId, nowIso` |
| `src/lib/providers/llm.ts` | `generateText(messages)`, `generateJson({messages, fallback})` → `{value, mocked}`, `generateTextSafe(messages, fallback)`, `hasLlm()` |
| `src/lib/providers/twilio.ts` | `sendSms(to, body)` → `{id, status}`, `provisionNumber(areaCode)`, `normalizePhone` |
| `src/lib/providers/stripe.ts` | `createPaymentLink(amountCents, description, businessName)` → `{url, amount_cents, id, mock}`, `hasStripe()`, `appUrl()` |
| `src/lib/scheduler.ts` | `slotsForDate(business, dateStr, duration)`, `nextAvailable(business, count, duration)` → `TimeSlot[]`, `isWithinHours` |
| `src/lib/http.ts` | `ok(data)`, `fail(err, status)`, `readJson<T>(req)` — every route returns `ApiResult<T>` |
| Postgres (Docker, `localhost:5433`) | Seeded demo via `bun scripts/seed.ts`: business id `biz_miami_cool_air`, 4 calls, 3 bookings, 1 briefing |
| `scripts/seed.ts` | Re-seed: `bun scripts/seed.ts` |

**Rule:** never call `fetch` to OpenAI/Twilio/Stripe/ElevenLabs directly. Always
go through `src/lib/providers/*`. That is what keeps the demo alive when a key
is missing.

## API surface (frozen — other workstreams call these)

All routes return `ApiResult<T>` = `{ok:true, data}` or `{ok:false, error}`.

### WS1 owns

| Method + path | Body → Response |
| --- | --- |
| `GET /api/businesses` | → `Business[]` |
| `POST /api/businesses` | `{name, url?, owner_phone?, owner_name?}` → `Business` |
| `GET /api/businesses/[id]` | → `{business, knowledge_base, stats}` |
| `PATCH /api/businesses/[id]` | partial `Business` → `Business`; after a trade (`vertical`) change the response also carries `vertical_sync: {prompt_rebuilt, call_script_rebuilt, agent: 'synced'\|'skipped'\|'failed', retry_queued}` (`retry_queued`: the live agent could not be updated yet, the `reconcile` job retries with backoff) |
| `POST /api/extract` | `{url}` → `ExtractionResult` |
| `POST /api/businesses/[id]/provision` | `{}` → `{business, knowledge_base, phone, mock, agent_id?, line?: {phone_number_id, adopted}}` — runs extraction if no KB, builds KB + system prompt, provisions number, creates the agent, imports the number into ElevenLabs and binds it to the tenant's agent, sets status `live`. Refusals (business stays `onboarding`): 503 `voice_provider_not_configured` BEFORE any purchase (no `ELEVENLABS_API_KEY` in production / with real Twilio), 502 `agent_registration_failed` (incl. a mock agent), 502 `voice_line_failed` (import/bind), each with `partial.phone` when a number is kept |
| `PUT /api/businesses/[id]/knowledge` | `{services?, faqs?, pricing_notes?, call_script?}` → `KnowledgeBase` (regenerates system_prompt) |

### WS3 owns

| Method + path | Body → Response |
| --- | --- |
| `POST /api/voice/incoming` | signed Twilio form → ALWAYS TwiML (register-call connect, voicemail, forward, or a `<Say>` + hangup for out-of-service / owner line / unknown number); unsigned JSON `{To, From, CallSid}` (demo, `ALLOW_INSECURE_DEV` only) → `{agent_id, business_id, call_id, ws_url?}` |
| `GET/PATCH /api/businesses/[id]/line` | GET (staff+): `{assistant_name, assistant_name_effective, default_assistant_name, native_transfer_enabled, transfer_capability, line_kind, own_line, has_number, forward_number_verified}`. PATCH (owner only, same-origin, 20/min): `{assistant_name?: string\|null (1-40 chars), native_transfer_enabled?: boolean}` → the same view + `agent_sync`; turning transfer ON: 409 while `NATIVE_TRANSFER` is off, 403 `reauth_required` without a recent login proof; audited `business.assistant_name_changed` / `business.native_transfer_changed` (the name is not copied) |
| `POST /api/voice/webhook` | ElevenLabs post-call `{business_id?, call_id?, transcript, duration_sec, language, ...}` → `{call}` |
| `POST /api/voice/tools/[tool]` | ElevenLabs tool call payload → tool result |
| `GET /api/voice/agent-prompt?business_id=` | → `{system_prompt, first_message, tools[]}` |

**Tool names (exact):** `check_availability`, `create_booking`, `send_sms`,
`create_payment_link`, `flag_emergency`, `get_pricing`, `handoff_to_human`
Each accepts a flat JSON object and returns `{ok, message, data?}` — `message`
is what the voice agent should say.

### WS4 owns

| Method + path | Body → Response |
| --- | --- |
| `POST /api/sms/send` | `{business_id, to, body, kind}` → `SmsLog` |
| `POST /api/sms/confirmation` | `{booking_id}` → `{sms, body}` |
| `POST /api/sms/payment-link` | owner+; `{business_id, booking_id, amount_cents?}` → `{sms, link, body}`; recipient is the booking's own number; the amount is policy-bound (below) |
| `POST /api/sms/gratitude` | `{booking_id}` → `{sms, body}` |
| `POST /api/sms/gratitude-reply` | `{booking_id, rating}` → `{routed: 'review' \| 'owner'}` |
| `POST /api/payments/create-link` | owner+; `{business_id, amount_cents?, description?, booking_id?}` → `PaymentLink`; without `amount_cents` the booking's stored / the policy's computed amount; an explicit amount must lie inside the deposit policy's min/max (platform limits 100..100000 cents without a policy); 409 for a cancelled booking or a paid deposit |
| `GET /pay/[id]` | public. PRODUCTION never renders a card form: a booking with a live Payment Link redirects to Stripe (`buy.stripe.com`, looked up on Stripe, cached 60 s, per-process budget), a paid booking shows the receipt (no card digits, no claim of a text), anything else (cancelled, replaced / used link, no link, Stripe unreachable) shows "this link is not available, contact the business"; an unknown id is a 404. The demo card form exists only with `DEMO_MODE=true` outside production |

### WS5 owns

| Method + path | Body → Response |
| --- | --- |
| `POST /api/briefings/generate` | `{business_id, date?}` → `Briefing & { audio: {status:'ready',bytes} \| {status:'unavailable',reason} }` (owner; text + stored audio when the voice provider is configured; `stats.narration` is `ai` or `automatic`) |
| `GET /api/briefings?business_id=` | → `Briefing[]` |
| `GET /api/briefings/[id]/audio` | staff+, tenant scoped (another business or no clip = 404); streams the stored clip from `briefing_audio` with its content type, Range (206/416), `ETag` (304), `private` cache; the 304 and the 206 are answered from the metadata / a `substring()` cut inside Postgres, the whole clip is read only for a full 200 |
| `POST /api/briefings/[id]/audio` | OWNER, rate limited per user and hour, 10 real syntheses per business per day (429 `audio_daily_limit`), audited; regenerates the audio from the stored text with the business voice → `{briefing_id, audio_url, audio}`; a clip that already exists for this text and voice is kept (`audio.reused`), a failed regeneration keeps a clip of the SAME text (`audio.kept_previous`) and deletes only a clip of an OLDER text (`unavailable` + `reason` `not_configured`/`provider_failed`/`bad_audio`/`store_failed`: never stale audio) |
| `POST /api/gratitude/run` | `{}` → `{sent: number}` — sweep bookings completed 24h+ ago, send gratitude SMS |

Briefing audio is stored in the database (`briefing_audio`, ElevenLabs TTS with the business `voice_id`, else `ELEVENLABS_VOICE_ID`, else the
default voice id) and `briefings.audio_url` is `/api/briefings/<id>/audio`. Nothing is written to `public/audio/` any more and there is no local
voice fallback; a legacy `/audio/<file>` URL is only read by the old authenticated route and deleted on erasure. Without `ELEVENLABS_API_KEY`
the briefing simply has no audio (the dashboard shows "audio unavailable"). `BRIEFING_AUDIO_KEEP_DAYS` (default 30) prunes old clips in the hourly cleanup.

### WS6 owns

| Method + path | Body → Response |
| --- | --- |
| `POST /api/demo/simulate-call` | `{business_id, caller_name, caller_phone, script: 'routine'\|'emergency'\|'spanish'}` → full end-to-end artifact `{call, booking?, payment_link?, sms[]}` |
| `POST /api/demo/reset` | reseeds db + clears generated audio |

## File ownership (hard boundaries)

| WS | Owns |
| --- | --- |
| WS1 | `src/app/api/businesses/**`, `src/app/api/extract/**`, `src/lib/extraction/**`, `src/lib/kb/**` |
| WS2 | `src/app/page.tsx`, `src/app/layout.tsx`, `src/app/globals.css`, `src/app/onboarding/**`, `src/app/dashboard/**`, `src/components/**` |
| WS3 | `src/app/api/voice/**`, `src/lib/voice/**` |
| WS4 | `src/app/api/sms/**`, `src/app/api/payments/**`, `src/app/pay/**`, `src/lib/messaging/**` |
| WS5 | `src/app/api/briefings/**`, `src/app/api/gratitude/**`, `src/lib/briefing/**`, `src/lib/gratitude/**`, `scripts/gen-audio.ts` |
| WS6 | `src/app/api/demo/**`, `scripts/seed.ts`, `scripts/smoke.ts`, `README.md` |

Never touch `src/lib/types.ts`, `src/lib/db/**`, `src/lib/providers/**`,
`src/lib/scheduler.ts`, `src/lib/http.ts`, `package.json`. If you need a change
there, put a `// REQUEST:` note in your final report instead.

## Demo business

`biz_miami_cool_air` — Miami Cool Air Conditioning, live, phone `+13055550142`,
owner Jorge `+13055550199`.

## Addendum (lead)

- `next.config.ts` had `cacheComponents` removed; `dynamic = 'force-dynamic'` is
  required and legal now. Do not re-add it.
- Dev server is running on :3000 (job 2). Do not start another one. Typecheck
  with `bunx tsc --noEmit`.
- UI primitives available: `@/components/ui/{card,badge,button,audio,cn}`.
  `Card`, `CardHead`, `Badge` (tone:
  neutral|emergency|routine|unsure|brand|sky), `Button`
  (primary|ghost|outline|danger), `VoicePlayer`.
- Formatters in `@/lib/format`:
  `timeET, dayET, whenET, money, seconds, relative, initials, firstName`.

## Added: calendar and call handling routes

| Route | Contract |
| --- | --- |
| `GET /api/bookings?view=week|day|month&date=YYYY-MM-DD[&ws=0|1]` | staff+; `{view,date,days,from,to,timezone,week_start,items,truncated}` for the visible range in the business zone |
| `GET /api/bookings?agenda=upcoming|past&cursor&limit` | staff+; `{items,next_cursor}` |
| `GET /api/bookings/[id]` | staff+; `{booking, call}` (call summary = notes) |
| `POST /api/bookings` | owner+, same-origin, 30/min; `{business_id?, customer_name, customer_phone? (blank = walk-in), service, scheduled_at (instant or local wall clock), duration_minutes?, address?, price_estimate? (cents), crew?, notify?}` -> 201 `{booking, notice}`; the SAME engine as the AI (hours, closed dates, lead / horizon, per-crew overlap under the advisory lock, Google busy); `created_via='dashboard'`, audit `booking.created_dashboard`, Google push hook; the customer is texted only with `notify:true` (quiet hours defer it); 409 `slot_taken` / `calendar_busy`, 422 for hours / closed / past |
| `GET /api/bookings/slots?date=YYYY-MM-DD[&duration=60][&business_id]` | owner+; `{date,timezone,duration_minutes,slots}` the times an OWNER's new booking can take (same hours, closures, bookings and calendar blocks as the AI, but no minimum notice and no booking window, like `createBooking` for the owner) |
| `PATCH /api/bookings/[id]` (edit) | owner+; WITHOUT `status`: `{customer_name?, customer_phone?, service?, address?, price_estimate? (cents), scheduled_at?, duration_minutes?, notify?}` -> `{booking,changed,moved,notice}`; a new time / length runs the reschedule engine; a new number clears the follow-up consent; closed bookings are 409; audit `booking.edited` |
| `PATCH /api/bookings/[id]` (no-show) | `{status:'cancelled', reason:'no_show', notify:false}`; 409 before the start time |
| `POST /api/bookings/[id]/deposit` | owner+, 10/min; `{amount_cents?, send?}` -> `{booking,amount_cents,source:'policy'\|'stored'\|'owner',resent,link:{id,url,mock},sms}`; request or RESEND a deposit link (the old link is deactivated); `send:false` only returns the link; 409 cancelled / already paid, 422 no phone (send) or an amount outside the policy, 503 `payments_not_configured` in production without Stripe; audit `booking.deposit_requested` |
| `POST /api/bookings/[id]/deposit/mark-paid` | owner+, STEP-UP; `{amount_cents?}` -> `{booking,changed,amount_cents}`; `deposit_source='manual'`, who and when stored, audit `booking.deposit_marked_manual`, the open Stripe link is deactivated through the DURABLE queue (stored id, or a lookup by `booking_id`; retried by the reconcile job); 409 over a Stripe payment. A card payment that still arrives later REPLACES the manual mark (`deposit_source='stripe'`, refundable through Stripe, manual refund bookkeeping reset), is audited `payment.paid_over_manual_deposit` and the owner is always texted that the customer paid twice |
| `POST /api/bookings/[id]/deposit/unmark` | owner+, STEP-UP; undo a MANUAL mark that has no refund; audit `booking.deposit_unmarked_manual`; 409 when a card payment is on file |
| `POST /api/bookings/[id]/refund/manual` | owner+, STEP-UP; `{amount_cents?}`; records a refund of a MANUAL deposit made off-platform (no provider call, no customer text); audit `booking.refund_recorded_manual`; the Stripe refund route answers 409 `manual_deposit` for such a booking |
| `GET/PUT /api/businesses/[id]/deposit-policy` | GET staff+, PUT owner+; the whole policy `{enabled, mode:'fixed'\|'percent', fixed_cents, percent, min_cents, max_cents}` + `limits`; audit `business.deposit_policy_changed` |
| `PATCH /api/bookings/[id]` | owner+; `{status:'cancelled'|'completed', notify?, reason?}` -> `{booking,changed,deposit_refund_needed,refund,notice}`; cancelling texts the customer (policy-aware) and returns the refund-policy verdict, never refunds; audited |
| `GET /api/bookings/[id]/slots?date=YYYY-MM-DD` | owner+; `{date,timezone,duration_minutes,slots:[{start,end,available,current}]}` the times the booking can move to |
| `POST /api/bookings/[id]/reschedule` | owner+, same-origin; `{scheduled_at (instant or local wall clock), duration_minutes?, notify?}` -> `{booking,changed,previous,notice}`; 409 `slot_taken`/not movable, 422 hours/past/invalid; audited `booking.rescheduled` |
| `POST /api/bookings/[id]/notify` | owner+; text the customer about the latest cancel/move (when the automatic text was held back); 409 when already told |
| `POST /api/bookings/[id]/refund` | owner+, step-up (403 `reauth_required`); `{amount_cents?, override?}` -> `{booking,amount_cents,status,replayed,override,partial,policy,notice}`; 422 `policy_ineligible` (needs `override:true`), 409 `already_refunded`/`no_payment_reference`/`in_progress`, 502 `provider_refused`/`outcome_unknown`; Stripe Idempotency-Key per booking+amount; audited |
| `POST /api/bookings/[id]/refund/check` | owner+, step-up (403 `reauth_required`); "Check with Stripe" for a refund stuck `pending`: lists Stripe's refunds for the payment and -> `{result:'adopted_refunded'|'adopted_pending'|'marked_failed'|'unchanged', booking, refund_id}`; 409 `not_pending`/`too_early`(attempt under 30 min old)/`in_progress`/`no_payment_reference`, 502 `unavailable`; read only towards Stripe (never creates a refund); audited |
| `GET/PUT /api/businesses/[id]/refund-policy` | GET staff+, PUT owner+; `{refund_policy:'none'|'full_24h'|'full_48h'|'full_always', refund_policy_text<=2000}`; audited |
| `GET/PUT /api/businesses/[id]/voice`, `GET .../voice/preview?voice_id=` | owner+; GET `{available,voice_id,voice_name,voices[]}` (the allowlist); PUT `{voice_id|null}` (422 outside the allowlist, 503 without ElevenLabs) saves, audits and re-syncs the agent -> `{voice_id,voice_name,synced}`; preview streams the provider sample of an allowed voice |
| `GET /api/calls/[id]/audio` | staff+, tenant scoped, rate limited; streams the call recording (Range, `no-store`) only when `consent_status='disclosed'`; 404 otherwise; 503 + `Retry-After` when the process already runs 4 provider downloads; audit `call.recording_played` once per person, call and 10 minutes for ANY successful range; never exposes the provider URL or key |
| `POST /api/businesses/[id]/provision` (extended) | non-admin: 422 `{code:'kb_incomplete', blockers[], warnings[], score}` before anything is bought when the KB lacks 3 priced services, opening hours or 1 FAQ; admins override |
| `POST /api/billing/checkout` (extended) | body `interval?: 'month'|'year'` (`year` only when `STRIPE_PRICE_ID_ANNUAL` is set); `GET /api/billing/status` also `billing_interval`, `annual_available`, `usage_warnings` |
| `POST /api/voice/tools/reschedule_booking`, `.../cancel_booking` | tool-secret; act ONLY on a booking whose phone equals the verified caller (platform caller id + call row agree, STIR not failed); otherwise the agent is told to take a message. Args: `new_scheduled_at`, `current_time?` / `confirmed`, `reason?` |
| `POST /api/bookings/[id]/resend-confirmation` | owner+; goes through `sendAndLog` (opt-out, caps) -> `{sms,deduped,status}` |
| `GET /api/calls?cursor&limit[&voicemail=1]`, `GET /api/briefings?cursor&limit` | staff+; `{items,next_cursor}`; calls carry `has_voicemail`, never `recording_url` |
| `GET/PATCH /api/businesses/[id]/call-mode` | GET staff+ (view now also `forward_supported`, `forward_blocked`), PATCH owner+ `{mode?, forward_during_hours?}` (at least one; 403 `reauth_required` when switching into paused/forward without recent authentication; 422 on a line that cannot forward) |
| `POST /api/auth/reauth` | session; `{password}` or `{code}` -> stamps the session `sudo_at` (valid 5 min) |
| `PUT/DELETE /api/businesses/[id]/forward-number` | owner+; `{use_owner_phone:true}` (needs recent authentication and an allowed number) / clear |
| `POST /api/businesses/[id]/forward-number/verify/{start,confirm}` | owner+, verified email; SMS-code verification |
| `POST /api/voice/voicemail` | Twilio signature; forwarded-call result (meters minutes) and voicemail recording |
| `POST /api/voice/dial-status` | Twilio signature; per-leg status callback of a forwarded call (meters bridged seconds once per call) |
| `GET /api/calls/[id]/voicemail` | staff+, tenant scoped; streams the voicemail audio (audio/mpeg, no-store); 404 for other tenants |
| `GET /api/calls/[id]/live` | staff+, tenant scoped (404 otherwise); Server-Sent Events: `retry`, `event: status` `{state: live\|ended\|declined, live, consent}`, `event: transcript` (`id` = seq; resume with `Last-Event-ID` or `?after=`) with `{call_id, seq, role: agent\|caller\|system, text, at, is_final}`, `: hb` heartbeats, `event: auth` / `ended` / `reconnect` then close; 429 beyond `LIVE_MAX_PER_USER` / `LIVE_MAX_PER_BUSINESS`; session re-checked every minute (the credential must still resolve to a principal with staff access to THIS call's business: a member removed from it who is still in another business loses the stream); nothing for a call whose consent is not `disclosed` |
| `GET /api/calls/[id]/transcript?after=<seq>` | staff+, tenant scoped; polling fallback `{events, next_after, live, consent, status}` (same shared upstream poll); rate limited to 40 requests a minute per person (429 + `Retry-After`) |
| `POST /api/voice/transcript-event` | tool-secret header; `{call_id\|call_sid\|conversation_id, events:[{seq, role, text, at?, is_final?}]}` (1-200) -> `{stored, skipped}`; idempotent by seq; ignored unless the call is live and `disclosed`; an objecting caller line declines the call and purges |
| `POST /api/voice/screen` | Twilio signature; call-screening whisper on the owner's forward leg (`<Number url>`): prompt (Gather), `Digits=1` bridges, else hang up that leg |
| `POST /api/voice/tools/transfer_to_human` | tool-secret; (native line, `NATIVE_TRANSFER=on` AND the business's `native_transfer_enabled`) re-checks verified number / hours / caps and answers `approved` (call -> `transfer_status=attempted`) or takes a callback (handoff) |
| `POST /api/voice/initiation` (extended) | dynamic variables now include `transfer_mode` (`off\|available\|forward`) and `transfer_destination` (E.164 or ''), per call |
| `POST /api/admin/resync-agents` | admin; `{dry_run?: true (default), business_ids?: string[<=25], limit?: 1..25 (10), cursor?}` -> `{dry_run, configured, tools[], items:[{business_id, agent_id, outcome: would_sync\|synced\|created\|mock\|failed\|skipped, detail?}], next_cursor}`; dry run makes no provider call; 6 req/min; audited `admin.resync_agents`; 503 for a real run without `ELEVENLABS_API_KEY` |
| `POST /api/admin/repair-numbers` | admin; `{dry_run?: true (default), business_ids?: string[<=25], limit?: 1..25 (10), cursor?, refresh_credentials?: boolean}` -> `{dry_run, webhooks, items:[{business_id, phone, outcome: ok\|would_update\|updated\|not_found\|skipped\|failed, changed?, detail?, line?: {outcome: ok\|would_import\|would_bind\|imported\|adopted\|bound\|would_refresh\|refreshed\|skipped\|failed, detail?}}], next_cursor}`; a business that already imported its number never has its Voice URL written (whatever the deployment kind), and a forward-mode tenant is `skipped` with `would_change_behaviour`; `refresh_credentials` re-sends the current Twilio credentials to the provider for imported numbers (after a token rotation); repairs the Twilio SMS URL (Voice URL only on a webhook line) and imports/binds each business's own number into ElevenLabs (native line); 6 req/min; audited `admin.repair_numbers` |
| `POST /api/integrations/google/mock-event` | owner; local/e2e only (404 unless `GOOGLE_OAUTH_MOCK=true` outside production); `{start, end, summary?, transparency?}` -> `{id, sync}` or `{delete_id}` -> `{deleted, sync}` |
| `POST /api/sms/inbound` (extended, inbox) | any other text (not STOP/START/HELP/YES, an owner code, a bare C or a gratitude 1-5) is stored in `inbound_messages` (deduped on `MessageSid`; the owner's own number, the business line and unparseable senders are dropped), texted to the VERIFIED owner phone through `alertOwner` (not in quiet hours; `INBOX_FORWARD_HOURLY_LIMIT` per hour; once per message; links in the text are replaced by `[link]`), and acknowledged once per sender per 24 h (sms_log kind `inbox_autoreply`, through `sendAndLog`: opt-out list, plan cap and STOP footer apply; language from the text, assistant name from `businesses.assistant_name`, default Maria). The forward and the acknowledgement go out from the TENANT's own number; the forward's sms_log row keeps NO copy of the customer's words (privacy export / erasure). Links, bare domains and IPs in the forward are replaced by `[link]`; at most 2 forwards per sender per hour; no acknowledgement to a text that looks like an opt-out request (flagged `handled_by=auto:possible_revocation`, the owner is told) or to a Caribbean / territory / premium NANP sender. Per-sender 10/h (checked first) and per-business 300/h flood limits. A text sent TO the shared platform sender (`TWILIO_PHONE_NUMBER`) is routed by the last outbound text to that customer (STOP applies to every business that texted them). Always answers empty TwiML |
| `POST /api/businesses/:id/messages/:messageId/opt-out` | owner or staff; opts the stored sender of that message out of this business's texts (source `manual`), marks it handled; audited `inbox.sender_opted_out` (last 4 only) |
| `GET /api/businesses/:id/messages` | owner or staff of that business; `?status=new\|handled\|ignored\|all&cursor=&limit=` -> `{items:[{id, from_last4, body, received_at, status, handled_at, booking_id, forwarded, auto_replied}], next_cursor, counts:{new,handled,ignored}}` |
| `GET /api/businesses/:id/messages/:messageId` | owner or staff; adds `from_e164`, `opted_out`, `booking`, `thread[]` (their texts and our auto-reply / manual / reply texts) |
| `PATCH /api/businesses/:id/messages/:messageId` | owner or staff; `{status:'new'\|'handled'\|'ignored'}`; audited `inbox.status_changed` |
| `POST /api/businesses/:id/messages/:messageId/reply` | owner or staff; `{body}` (<= 320 chars); the recipient is the stored sender, never a client number; `sendAndLog` kind `owner_inbox_reply` (opt-out, plan cap, quiet hours, STOP footer); a delivered reply marks the message handled; audited `inbox.reply_sent` (no body) |
| `POST /api/businesses/:id/messages/send` | owner or staff; `{to, body}`; the number must already be a booking, call or inbox sender of the business; kind `manual`; 40/h per business and 6/h per recipient; audited `sms.manual_sent` (last 4 and length only). Refusals carry `code`: `empty, too_long, invalid_recipient, unknown_recipient, not_allowed, rate_limited (429), quiet_hours (409), opted_out (409), cap_reached (402), send_failed (502)` |
| `GET /api/businesses/:id/messages/log` | owner or staff; `?direction=out\|in&cursor=` -> the text log with status (`sent, failed, mock, blocked_*`), numbers as last 4 |
| `GET/PUT /api/businesses/:id/review-url` | GET owner or staff, PUT owner; `{review_url: https link <= 120 chars \| null}` (the DB CHECK still allows 300 for links saved earlier; the review text never cuts a link, it shortens the words around it or drops the link); audited `business.review_url_changed`. Unset = review requests are a thank-you without a link; there is no platform default |
| `POST /api/businesses/:id/privacy/lookup` | owner only; `{phone}` -> counts only (no content); 60/h |
| `POST /api/businesses/:id/privacy/export` | owner only, step-up (`reauth_required` after 5 min); `{phone}` -> the same JSON as `GET /api/privacy/export`; 20/h; audited `privacy.export` (`customer:...last4` + counts) |
| `POST /api/businesses/:id/privacy/erase` | owner only, step-up; `{phone, confirm:'ERASE'}`; 20/h; audited `privacy.erase` / `privacy.erase_failed` |
| `POST /api/sms/inbound` (extended) | a bare `C` (case/punctuation folded) from the booking's own number cancels that sender's ONLY upcoming booking for the business that owns the texted number and answers TwiML with the refund-policy verdict (en/es); several upcoming -> asks them to call; none -> says so; `CANCEL/STOP/END/QUIT...` stay opt-outs; per-sender 5/10 min, per-business 120/h, MessageSid dedupe; an opted-out sender is cancelled silently (no reply) |
| `GET /api/billing/status` (field naming) | the 80% / 100% cap warnings are `usage_warnings: [{kind, level, percent, ...}]` (never `warnings`); also `billing_interval`, `annual_available` |
| `POST /api/billing/checkout` (mock mode) | with `STRIPE_PRICE_ID_ANNUAL` set, `interval:'year'` is accepted in the non-production mock checkout too; the mock activation records `billing_interval` |
| `POST /api/payments/webhook` (extended) | also `charge.dispute.updated / closed / funds_withdrawn / funds_reinstated`; sets `bookings.dispute_status` (`none\|open\|won\|lost`, monotonic) |
| `GET /api/integrations/google/status` | `block_on_busy` now comes from `calendar_connections.block_on_busy`; `orphaned_events: {total, items[{id,service,starts_at,account_email,reason,created_at}]}` = pushed events that could not be removed from a previous account / calendar (no customer data) |
| `DELETE /api/integrations/google/orphans` | owner; `{ids?: string[]}` (omitted = all) -> `{dismissed}`; deletes only this business's reminder rows, sends nothing to Google; audited `calendar.orphans_dismissed` |
| `POST /api/voice/tools/propose_kb_change` (extended) | `change_type` adds `set_hours` (`days`, `open_time`, `close_time` or `closed`), `add_closed_dates` / `remove_closed_dates` (`dates` YYYY-MM-DD), `set_service_area` (`areas`); they change the REAL fields (`businesses.hours / closed_dates / service_area`) |

## Owner voice reply (owner-line tools, SMS commands)

No new HTTP route. Four more owner-line voice tools on `POST /api/voice/tools/[tool]` (all refused unless the call row is `kind = 'owner'`, see docs/owner-call-in.md; registered only while `OWNER_REPLY_ENABLED` is not `false`):

| Tool | Arguments | Result |
| --- | --- | --- |
| `list_recent_leads` | none | `{ok, message, data:{stage:'leads', count}}`; `message` is up to five numbered structured lines (kind, first name, last 4 digits, time) and snapshots the numbers for this owner call; the distinct leads a caller-identity class may hear per day are capped (10 unverified / 30 verified), a spent budget answers `ok:false` |
| `draft_reply` | `lead_ref` (the number from the list, "1".."5"), `message` (<= 120 chars, plain words), `confirmed` | `confirmed=false`: read-back (`data.stage = 'read_back'`); `confirmed=true` after the identical read-back: `data.stage = 'proposed'` and a code is texted to the owner; the customer is texted only by `YES <code>` |
| `mark_lead_handled` | `lead_ref`, `confirmed` | `confirmed=false`: read-back (`data.stage = 'read_back'`); `confirmed=true` after it: hides that customer from later lists of the same identity class (3 per call, 5 / 30 per day unverified / verified) |
| `get_callback_number` | `lead_ref` | texts the owner (only) the customer's number |

There is no recipient argument: the recipient comes from the call / booking row of the business. SMS commands at `POST /api/sms/inbound` (verified owner phone only, after STOP/START/HELP): `YES <code>` sends, `NO <code>` cancels, `UNDO <code>` answers that a sent text cannot be undone. A bare `NO` from the verified owner phone cancels every waiting draft; a bare `YES` asks for the code. Table `owner_replies` (`status`: proposed, sending, sent, uncertain, cancelled, expired, refused, failed; `uncertain` = may or may not have been delivered, never retried). Audit actions `owner_reply.*`. Customer text: `<Business>: <words>. Reply STOP to opt out` (sms_log kind `manual`, consent basis `owner_voice_reply`).

## Platform: scheduling, time zone, content confirmation, tenant jobs (agent D)

| Method + path | Body → Response |
| --- | --- |
| `GET /api/businesses/[id]/scheduling` | staff+; `{slot_minutes, min_lead_minutes, horizon_days, buffer_minutes, crews}` |
| `PUT /api/businesses/[id]/scheduling` | OWNER, same-origin, 30/min, audited `business.scheduling_changed`; any subset of the five fields; 422 invalid / unknown (nothing written); 409 `crew_in_use` when lowering `crews` below a crew with an upcoming booking |
| `GET /api/businesses/[id]/timezone` | staff+; `{timezone, suggested, now, chosen}`; `suggested` comes from the owner phone area code and is NEVER applied by the server; `chosen` = the zone is not the untouched default (the onboarding suggestion only pre-selects while it is false) |
| `PUT /api/businesses/[id]/timezone` | OWNER, same-origin, 20/min, audited `business.timezone_changed`; `{timezone}` IANA only (`EST`, `+01:00` are 422) → view + `changed`, `hours_recheck`, `agent_sync` |
| `GET /api/businesses/[id]/content-confirmation` | staff+; `{state: unconfirmed\|confirmed\|stale, confirmed_at, content_hash}` |
| `POST /api/businesses/[id]/content-confirmation` | OWNER; confirms the services (names, prices, durations, descriptions), FAQs, pricing notes and service area as they are now (fingerprint); `{expected_hash?}` = the `content_hash` the page showed: 409 `content_changed` when the stored content is no longer that; 422 without services or without a service area; audited `business.content_confirmed` |
| `POST /api/admin/jobs/run` | admin; adds `tenant_release` (optional `business_id`) and `grandfather` (`before` ISO cutoff); `dry_run` defaults to true; a real run needs `TENANT_RELEASE_JOB=on`, otherwise the report holds `refused_not_enabled` |

Function contracts (signatures unchanged, options added): `slotsForDate(business, date, minutes, nowMs?)`, `nextAvailable(business, count, minutes, nowMs?)` read
`schedulingOf(business)` (grid, notice, horizon, buffer, crews; Google blocks stop every crew); `validateSlot(..., closedDates, { horizonDays })` returns
`too_soon` (inside the notice) and `too_far` (beyond the horizon) next to the old reasons; `createBooking(input, { enforce, max_per_call, ownerInitiated })` and
`rescheduleBooking(input, { enforce, ownerInitiated })`: `ownerInitiated` skips the notice and the horizon only (dashboard bookings; customer moves by the voice agent do not), the
buffer is kept clear in code (and around Google blocks), crews are assigned per `bookings_no_overlap (business, crew, range)`. `slotsForMove(..., nowMs, { customer })` applies notice + horizon to customer moves.
