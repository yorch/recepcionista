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
| `PATCH /api/businesses/[id]` | partial `Business` → `Business` |
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
