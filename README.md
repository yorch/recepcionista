# Recepcionista

**Paste your website. In two minutes you have a bilingual employee who answers, books, gets paid, and tells you about your day.**

Built at **Buildersgiving · Miami AI Hackathon**, with Mel driving six parallel agent workstreams.

An AI front-desk employee for Miami home-service small businesses. She answers the phone in English, Spanish, or both in the same sentence; triages emergencies; books the job; texts the customer a confirmation; collects an emergency deposit by payment link; and calls the owner at the end of the day with a 45-second voice note.

---

## Quick start

```sh
export PATH="/opt/homebrew/bin:$HOME/.bun/bin:$PATH"
bun install
cp .env.example .env.local     # optional: add keys to go live
bun scripts/seed.ts            # demo business: Miami Cool Air Conditioning
bun dev                        # http://localhost:3000
```

Verify it:

```sh
bun scripts/smoke.ts     # 39 assertions, drives the whole product over HTTP
bun scripts/ws1-test.ts  # 14 — extraction, KB, provisioning
bun scripts/ws3-test.ts  # 40 — the seven voice tools
bun scripts/ws4-test.ts  # 19 — bilingual SMS + payments
bun scripts/ws5-test.ts  # 17 — briefings, TTS, gratitude
```

No keys are required to demo. Every external service runs through an adapter with a local fallback:

| Service | With a key | Without a key |
|---|---|---|
| LLM (OpenAI / Anthropic) | real extraction + summaries | deterministic templates, still coherent |
| ElevenLabs | real voice agent + TTS briefings | macOS `say` + `afconvert` for briefings; scripted call replay |
| Twilio | real SMS + number provisioning | SMS logged and shown in the dashboard |
| Stripe | real test-mode payment links | `/pay/[id]` mock checkout page |

---

## Demo path (3 minutes)

1. `/onboarding` → paste `miamicoolair.com` → watch extraction → review → **Go live** → get a number
2. `/dashboard/demo` → **Call her** (Español · Rutina) → booking + confirmation SMS appear
3. `/dashboard/demo` → **Emergency · English** → deposit link appears
4. `/dashboard/briefings` → **Generate now** → play the voice note
5. `/dashboard` → the day, summarized

---

## Architecture

```
Next.js 16 (App Router) ── local JSON store (data/db.json) or Supabase
        │
        ├── /api/businesses/[id]/provision   ← URL → KB → system prompt → phone
        ├── /api/voice/tools/[tool]          ← what ElevenLabs calls mid-conversation
        ├── /api/sms/*  /api/payments/*      ← Twilio + Stripe
        └── /api/briefings/*                 ← summary → ElevenLabs TTS → audio
```

**Key design choice:** the voice agent never touches the database. It calls seven HTTP tools
(`check_availability`, `create_booking`, `send_sms`, `create_payment_link`, `flag_emergency`,
`get_pricing`, `handoff_to_human`), each returning a `message` the agent speaks aloud. The demo
console drives those exact same endpoints, so what judges see is the real pipeline.

## The seven tools

| Tool | Does | Guardrail |
|---|---|---|
| `check_availability` | next open slots from business hours + existing bookings | never offers a taken slot |
| `create_booking` | writes the appointment, fires the confirmation SMS | validates hours + conflicts first |
| `send_sms` | arbitrary text to the caller | logged |
| `create_payment_link` | Stripe link for an emergency deposit | hard cap $500 |
| `flag_emergency` | marks the call, alerts the owner | urgent calls never get buried |
| `get_pricing` | looks up a starting price | returns `matched:false` rather than inventing one |
| `handoff_to_human` | flags for owner callback | the agent admits what she doesn't know |

## Layout

```
src/lib/types.ts          every domain type (frozen contract)
src/lib/db/               local JSON store behind a single import point
src/lib/providers/        llm · twilio · stripe — real-or-mock adapters
src/lib/voice/            the seven tools + ElevenLabs agent client
src/lib/briefing/         Spanglish script generation + TTS
src/lib/messaging/        bilingual SMS templates
src/app/api/              all route handlers
src/app/dashboard/        owner UI
scripts/seed.ts           demo data
CONTRACTS.md              the interface contract six agents built against
```

## How Mel was used

Six workstreams ran in parallel against a frozen interface contract (`CONTRACTS.md`), each owning
disjoint files: schema/API, extraction/KB, dashboard, voice tools, SMS/payments, briefings/gratitude.
See `MEL_USAGE.md`.

## What is real vs mocked

| Piece | Status |
|---|---|
| Booking, call records, knowledge base, briefing scripts | **Real** — written to the store, read by every page |
| Briefing audio | **Real audio** — ElevenLabs with a key, macOS `say` (Paulina, es_MX) without one |
| SMS copy and delivery | Real bilingual copy; delivered through Twilio with a key, logged to the dashboard without one |
| Deposit links | Real Stripe test-mode links with a key; local `/pay/[id]` checkout without one |
| Voice agent | Real ElevenLabs Conversational AI agent with a key; scripted replay without one |
| Calendar | Intentionally internal — no OAuth, no external sync |

## Notes

- Calendar is internal by design — no OAuth, no external sync.
- Stripe stays in test mode. No card data touches this app.
- `data/db.json` is the source of truth for the demo. `POST /api/demo/reset` restores it.
