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
| `POST /api/businesses/[id]/provision` | `{}` → `{business, knowledge_base, phone, mock}` — runs extraction if no KB, builds KB + system prompt, provisions number, sets status `live` |
| `PUT /api/businesses/[id]/knowledge` | `{services?, faqs?, pricing_notes?, call_script?}` → `KnowledgeBase` (regenerates system_prompt) |

### WS3 owns

| Method + path | Body → Response |
| --- | --- |
| `POST /api/voice/incoming` | Twilio-style form or JSON `{To, From, CallSid}` → `{agent_id, business_id, call_id, ws_url?}` |
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
| `POST /api/sms/payment-link` | `{business_id, booking_id?, to, amount_cents, description}` → `{sms, link}` |
| `POST /api/sms/gratitude` | `{booking_id}` → `{sms, body}` |
| `POST /api/sms/gratitude-reply` | `{booking_id, rating}` → `{routed: 'review' \| 'owner'}` |
| `POST /api/payments/create-link` | `{business_id, amount_cents, description, booking_id?}` → `PaymentLink` |
| `GET /pay/[id]` | mock checkout page (only reached in mock Stripe mode) |

### WS5 owns

| Method + path | Body → Response |
| --- | --- |
| `POST /api/briefings/generate` | `{business_id, date?}` → `Briefing` (text + audio_url) |
| `GET /api/briefings?business_id=` | → `Briefing[]` |
| `POST /api/gratitude/run` | `{}` → `{sent: number}` — sweep bookings completed 24h+ ago, send gratitude SMS |

Audio files must be written to `public/audio/` and referenced as
`/audio/<file>.mp3|.wav|.m4a`.

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
| `PATCH /api/bookings/[id]` | owner+; `{status:'cancelled'|'completed', notify?, reason?}` -> `{booking,changed,deposit_refund_needed,refund,notice}`; cancelling texts the customer (policy-aware) and returns the refund-policy verdict, never refunds; audited |
| `GET /api/bookings/[id]/slots?date=YYYY-MM-DD` | owner+; `{date,timezone,duration_minutes,slots:[{start,end,available,current}]}` the times the booking can move to |
| `POST /api/bookings/[id]/reschedule` | owner+, same-origin; `{scheduled_at (instant or local wall clock), duration_minutes?, notify?}` -> `{booking,changed,previous,notice}`; 409 `slot_taken`/not movable, 422 hours/past/invalid; audited `booking.rescheduled` |
| `POST /api/bookings/[id]/notify` | owner+; text the customer about the latest cancel/move (when the automatic text was held back); 409 when already told |
| `POST /api/bookings/[id]/refund` | owner+, step-up (403 `reauth_required`); `{amount_cents?, override?}` -> `{booking,amount_cents,status,replayed,override,partial,policy,notice}`; 422 `policy_ineligible` (needs `override:true`), 409 `already_refunded`/`no_payment_reference`/`in_progress`, 502 `provider_refused`/`outcome_unknown`; Stripe Idempotency-Key per booking+amount; audited |
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
| `POST /api/voice/tools/transfer_to_human` | tool-secret; (native line, `NATIVE_TRANSFER=on`) re-checks verified number / hours / caps and answers `approved` (call -> `transfer_status=attempted`) or takes a callback (handoff) |
| `POST /api/voice/initiation` (extended) | dynamic variables now include `transfer_mode` (`off\|available\|forward`) and `transfer_destination` (E.164 or ''), per call |
| `POST /api/admin/resync-agents` | admin; `{dry_run?: true (default), business_ids?: string[<=25], limit?: 1..25 (10), cursor?}` -> `{dry_run, configured, tools[], items:[{business_id, agent_id, outcome: would_sync\|synced\|created\|mock\|failed\|skipped, detail?}], next_cursor}`; dry run makes no provider call; 6 req/min; audited `admin.resync_agents`; 503 for a real run without `ELEVENLABS_API_KEY` |
| `POST /api/integrations/google/mock-event` | owner; local/e2e only (404 unless `GOOGLE_OAUTH_MOCK=true` outside production); `{start, end, summary?, transparency?}` -> `{id, sync}` or `{delete_id}` -> `{deleted, sync}` |
| `POST /api/sms/inbound` (extended) | a bare `C` (case/punctuation folded) from the booking's own number cancels that sender's ONLY upcoming booking for the business that owns the texted number and answers TwiML with the refund-policy verdict (en/es); several upcoming -> asks them to call; none -> says so; `CANCEL/STOP/END/QUIT...` stay opt-outs; per-sender 5/10 min, per-business 120/h, MessageSid dedupe; an opted-out sender is cancelled silently (no reply) |
| `GET /api/billing/status` (field naming) | the 80% / 100% cap warnings are `usage_warnings: [{kind, level, percent, ...}]` (never `warnings`); also `billing_interval`, `annual_available` |
| `POST /api/billing/checkout` (mock mode) | with `STRIPE_PRICE_ID_ANNUAL` set, `interval:'year'` is accepted in the non-production mock checkout too; the mock activation records `billing_interval` |
| `POST /api/payments/webhook` (extended) | also `charge.dispute.updated / closed / funds_withdrawn / funds_reinstated`; sets `bookings.dispute_status` (`none\|open\|won\|lost`, monotonic) |
| `GET /api/integrations/google/status` | `block_on_busy` now comes from `calendar_connections.block_on_busy` |
| `POST /api/voice/tools/propose_kb_change` (extended) | `change_type` adds `set_hours` (`days`, `open_time`, `close_time` or `closed`), `add_closed_dates` / `remove_closed_dates` (`dates` YYYY-MM-DD), `set_service_area` (`areas`); they change the REAL fields (`businesses.hours / closed_dates / service_area`) |

