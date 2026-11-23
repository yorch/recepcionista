# PRD: AI Front-Desk Employee for Miami Home-Service SMBs

> **Implementation status vs PRD (as of 2026-11-23).** This is the original
> hackathon plan (v1.0), kept for history. It is not the current spec. The
> items below are **not implemented**, or only partly implemented, in the build:
>
> - **Supabase** schema and client (Sec. 5, WS1): the app uses Postgres 17 with
>   Prisma. The `SUPABASE_*` env vars are not read by the code.
> - **Next.js 14** (Sec. 7): the app uses Next.js 16.
> - **6 PM auto-briefing** (FR-3.1): briefings are generated on demand only.
>   Nothing schedules them.
> - **Owner voice reply to the briefing** (FR-3 step 4, stretch): not implemented.
> - **24h gratitude SMS** (FR-4.1, stretch): the sweep exists, but nothing
>   schedules it.
> - **Settings panel** for voice and hours (Sec. 5): no route or UI.
> - **Calendar grid** (Sec. 5): the bookings page is a list.
> - **Call recording player** (Sec. 5): `recording_url` is stored, but no player.
> - **Live human transfer** (FR-2.6): `handoff_to_human` flags a callback. It
>   does not transfer the call.
> - **Phone provisioning via Twilio** (FR-1.3): mock fallback. Live inbound
>   routing uses ElevenLabs phone binding.
> - **Spanglish detection** (FR-2.1): prompt-driven. No detection in code.
> - **Gas-leak and carbon-monoxide guidance** (guardrails, Sec. 6): only in the
>   demo prompt. Not in production prompts.
> - **Recording consent and AI disclosure**: not in any prompt or greeting.
> - **SMS opt-out (STOP/HELP) and 10DLC/A2P registration**: not implemented.
> - **Live KB correction by voice and live transcript** (stretch): not implemented.
> - **Stripe test mode enforcement** (Sec. 2): test keys by convention only.
> - **Unsourced claims**: the "30-50% of calls lost" figure, the market
>   underservice claim, and the demo phone number (`+1-305-555-0199`, which
>   differs from the seeded number in CONTRACTS.md) have no source here.
>
> Shipped as described: URL-to-KB extraction, the seven voice tools, booking
> with availability checks, bilingual SMS confirmations, emergency deposit links
> (with the $500 cap), the briefing content, and the 4-5 star review routing.

## Buildersgiving: Miami AI Hackathon — November 14, 2026

**One-liner:** Paste your website, and in 2 minutes you have a bilingual
employee who answers, books, gets paid, and tells you about your day.

---

## 1. Problem, Target User, Why Now

| | |
| --- | --- |
| **Problem** | Miami home-service SMBs (HVAC, plumbing, electrical) lose 30–50% of inbound calls to voicemail or language barriers. Owners answer phones themselves while on jobs, or hire bilingual dispatchers they can't afford. |
| **Target user** | Owner-operator of a 1–5 person HVAC/plumbing company in Miami-Dade. Speaks English or Spanish (or both). Has a website or Google Business page. Wants to stop losing calls but can't afford a full-time dispatcher. |
| **Why now** | ElevenLabs Agents + phone integrations make human-quality voice AI cheap and fast. Mel's multi-agent execution lets one engineer build what used to need a team. Miami's bilingual market is underserved by generic AI phone products. |

---

## 2. Scope: MVP vs Stretch vs Out of Scope

### MVP (must demo)

- [ ] Owner pastes a URL → agents extract business info → generate knowledge
      base + system prompt → return a phone number
- [ ] Inbound call answered by ElevenLabs voice agent in Spanglish
- [ ] Triage: urgency detection (emergency vs routine), language switching
- [ ] Booking: check availability, create appointment in internal calendar
- [ ] SMS confirmation + quote sent via Twilio
- [ ] Emergency deposit: Stripe payment link generated and shared over SMS
- [ ] End-of-day voice briefing (ElevenLabs TTS) summarizing calls, bookings,
      revenue
- [ ] Owner dashboard (Next.js) showing calls, bookings, settings

### Stretch (if time permits)

- [ ] Next-day gratitude SMS/call with review request
- [ ] Owner can correct knowledge base by talking to the agent (voice feedback
      loop)
- [ ] Real Google Calendar integration (replace internal calendar)
- [ ] Live call transcript in dashboard

### Out of Scope

- Multi-location / franchise support
- Outbound marketing calls
- AI dispatch to subcontractors
- Mobile app (responsive web only)
- Real-time calendar sync with external systems
- Actual payment processing (Stripe test mode only)

---

## 3. User Flows

### Flow A: Owner Setup from URL

1. Owner visits dashboard, clicks "Add Your Business"
2. Pastes website URL or Google Business link
3. Mel agent scrapes/extracts: business name, services, hours, service area,
   pricing, FAQs
4. LLM generates: knowledge base JSON, system prompt, call script
5. Owner reviews and edits in dashboard (or skips for demo)
6. System provisions Twilio phone number (or uses pre-provisioned pool)
7. Dashboard shows: "Your AI employee is live at +1-305-XXX-XXXX"

### Flow B: Inbound Spanglish Call → Triage → Booking → SMS/Payment

1. Customer calls the business number
2. ElevenLabs voice agent answers: "Gracias por llamar a [Business]. ¿En qué
   puedo ayudarle? / Thanks for calling. How can I help?"
3. Customer speaks in English, Spanish, or Spanglish
4. Agent detects language, responds in same language
5. **Triage**: "Is this an emergency? Is water leaking? Is anyone elderly or
   vulnerable?"
6. **Routine**: Check availability → create booking → SMS confirmation with
   quote
7. **Emergency**: Generate Stripe payment link → SMS link for deposit → flag for
   owner
8. **Uncertain**: Offer to transfer to owner (human handoff)

### Flow C: End-of-Day Voice Briefing

1. At 6 PM (or on demand), system generates briefing
2. ElevenLabs TTS reads: "Hola Jorge. Today you had 4 calls. 2 bookings for
   tomorrow: AC repair at 10 AM, duct cleaning at 2 PM. $150 deposit collected.
   1 emergency flagged — check your dashboard."
3. Briefing saved as audio file, playable in dashboard
4. Owner can tap "Reply" and record a voice message (stretch)

### Flow D: Next-Day Gratitude Follow-Up

1. 24 hours after completed job, agent sends SMS: "Hi Maria, how did the AC
   repair go? Reply 1-5."
2. If 4–5: "So glad! Would you leave us a review? [Google Review link]"
3. If 1–3: "I'm sorry to hear that. Let me connect you with the owner." → Flag
   in dashboard

---

## 4. Functional Requirements & Acceptance Criteria

### FR-1: Business Onboarding

| ID | Requirement | Acceptance Criteria |
| --- | --- | --- |
| FR-1.1 | URL input | Owner can paste any URL; system attempts extraction within 30s |
| FR-1.2 | Knowledge base generation | Extracts ≥5 services, hours, service area, ≥3 FAQs |
| FR-1.3 | Phone provisioning | Returns a working US phone number (pre-provisioned pool acceptable) |
| FR-1.4 | Dashboard review | Owner can edit business info before going live |

### FR-2: Voice Call Handling

| ID | Requirement | Acceptance Criteria |
| --- | --- | --- |
| FR-2.1 | Language detection | Agent responds in caller's detected language; handles mid-sentence switches |
| FR-2.2 | Triage | Asks 2–3 urgency questions; routes emergency vs routine |
| FR-2.3 | Booking creation | Checks mock calendar, creates appointment with customer name, phone, address, service |
| FR-2.4 | SMS confirmation | Sends text within 10s of booking with date, time, service, estimated price |
| FR-2.5 | Emergency payment | Generates Stripe test payment link; SMS includes link and amount |
| FR-2.6 | Human handoff | Offers to "connect you with the owner" for unanswerable requests |

### FR-3: End-of-Day Briefing

| ID | Requirement | Acceptance Criteria |
| --- | --- | --- |
| FR-3.1 | Auto-generation | Briefing generated at 6 PM or on-demand button |
| FR-3.2 | Content | Includes: call count, booking count, revenue, flagged items |
| FR-3.3 | Audio playback | 30–60s audio playable in dashboard |

### FR-4: Gratitude Loop

| ID | Requirement | Acceptance Criteria |
| --- | --- | --- |
| FR-4.1 | Timing | SMS sent 24h after job completion |
| FR-4.2 | Review routing | Happy customers (4–5) get review link; unhappy (1–3) get owner flag |

---

## 5. System Architecture

```text
┌─────────────────────────────────────────────────────────────────────┐
│                         OWNER DASHBOARD                              │
│                    (Next.js 14 App Router + shadcn)                  │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐ │
│  │  Onboarding │  │  Call Log   │  │  Calendar   │  │  Settings   │ │
│  │   (URL →    │  │  (transcript│  │  (bookings) │  │  (voice,    │ │
│  │   KB gen)   │  │   audio)    │  │             │  │   hours)    │ │
│  └─────────────┘  └─────────────┘  └─────────────┘  └─────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│                         SUPABASE (Postgres)                          │
│  businesses │ knowledge_bases │ calls │ bookings │ briefings │ sms_log │
└─────────────────────────────────────────────────────────────────────┘
                                    │
        ┌───────────────────────────┼───────────────────────────┐
        ▼                           ▼                           ▼
┌───────────────┐         ┌─────────────────┐         ┌───────────────┐
│  ELEVENLABS   │         │     TWILIO      │         │    STRIPE     │
│  Voice Agent  │◄───────►│  Phone / SMS    │         │ Payment Links │
│  (conversational│        │  (inbound call  │         │  (test mode)  │
│   voice + TTS) │        │   + outbound SMS)│        │               │
└───────────────┘         └─────────────────┘         └───────────────┘
        │
        ▼
┌─────────────────────────────────────────────────────────────────────┐
│                         LLM SERVICES                                 │
│  OpenAI GPT-4o / Claude 3.5: website extraction, call summaries,     │
│  knowledge base generation, briefing text generation                 │
└─────────────────────────────────────────────────────────────────────┘
```

### Data Model

#### businesses

| field | type | notes |
| --- | --- | --- |
| id | uuid PK | |
| name | text | |
| url | text | source URL |
| phone | text | Twilio number |
| owner_phone | text | for SMS alerts |
| hours | jsonb | {monday: {open, close}, ...} |
| service_area | text[] | zip codes or cities |
| status | enum | onboarding \| live \| paused |
| created_at | timestamptz | |

#### knowledge_bases

| field | type | notes |
| --- | --- | --- |
| id | uuid PK | |
| business_id | uuid FK | |
| services | jsonb[] | {name, description, base_price, duration} |
| faqs | jsonb[] | {question, answer} |
| system_prompt | text | full ElevenLabs system prompt |
| call_script | text | suggested opening + flow |
| updated_at | timestamptz | |

#### calls

| field | type | notes |
| --- | --- | --- |
| id | uuid PK | |
| business_id | uuid FK | |
| caller_phone | text | |
| started_at | timestamptz | |
| ended_at | timestamptz | |
| duration_sec | int | |
| language | text | en / es / mixed |
| transcript | text | |
| summary | text | LLM-generated |
| urgency | enum | emergency \| routine \| unsure |
| status | enum | in_progress \| completed \| failed \| handed_off |
| recording_url | text | ElevenLabs recording |

#### bookings

| field | type | notes |
| --- | --- | --- |
| id | uuid PK | |
| call_id | uuid FK | |
| business_id | uuid FK | |
| customer_name | text | |
| customer_phone | text | |
| service | text | |
| scheduled_at | timestamptz | |
| address | text | |
| price_estimate | decimal | |
| deposit_amount | decimal | nullable |
| deposit_paid | boolean | default false |
| status | enum | pending \| confirmed \| completed \| cancelled |

#### briefings

| field | type | notes |
| --- | --- | --- |
| id | uuid PK | |
| business_id | uuid FK | |
| date | date | |
| audio_url | text | ElevenLabs TTS output |
| transcript | text | |
| stats | jsonb | {calls, bookings, revenue, flags} |
| created_at | timestamptz | |

### External APIs & Webhooks

| Service | Endpoint | Purpose |
| --- | --- | --- |
| ElevenLabs | `/v1/convai/agents` | Create/configure voice agent |
| ElevenLabs | `/v1/convai/conversation` | Webhook: call started/ended |
| ElevenLabs | `/v1/text-to-speech` | Generate briefing audio |
| Twilio | Incoming call webhook | Route to ElevenLabs |
| Twilio | `/Messages` | Send SMS confirmations |
| Stripe | `/v1/payment_links` | Create emergency deposit links |
| OpenAI | `/v1/chat/completions` | Extraction, summarization, KB generation |

### Environment Variables

```bash
# Supabase
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=

# ElevenLabs
ELEVENLABS_API_KEY=
ELEVENLABS_AGENT_ID=
ELEVENLABS_VOICE_ID=

# Twilio
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_PHONE_NUMBER=

# Stripe
STRIPE_SECRET_KEY=
STRIPE_PUBLISHABLE_KEY=

# OpenAI
OPENAI_API_KEY=

# App
NEXT_PUBLIC_APP_URL=http://localhost:3000
```

---

## 6. Voice Agent Design

### System Prompt Outline

```text
You are Maria, the friendly bilingual front-desk employee for {business_name}.
You answer calls in English, Spanish, or Spanglish — whatever the caller prefers.
If the caller switches languages, you switch seamlessly.

SERVICES:
{services_list}

HOURS: {hours}
SERVICE AREA: {service_area}
PRICING: {pricing_notes}

YOUR GOALS:
1. Greet warmly and identify the customer's need
2. Triage urgency: "Is this an emergency? Is water leaking? Is anyone elderly or vulnerable?"
3. For emergencies: collect deposit, flag for owner
4. For routine: check availability, book appointment, send SMS confirmation
5. Never make up prices — use the pricing guide or say "I'll need to check with the owner"
6. If unsure, offer to connect to the owner

TONE: Warm, professional, Miami-local. Use "¿Cómo estás?" and "No problem at all" naturally.
```

### Agent Tools/Functions

| Tool | Description | Parameters |
| --- | --- | --- |
| `check_availability` | Check open slots in calendar | date (YYYY-MM-DD), duration_minutes |
| `create_booking` | Create appointment | customer_name, phone, service, date, time, address |
| `send_sms` | Send text to customer | phone, message |
| `create_payment_link` | Generate Stripe deposit link | amount_cents, description |
| `flag_emergency` | Alert owner of urgent issue | reason, customer_phone |
| `get_pricing` | Look up service price | service_name |
| `handoff_to_human` | Offer to transfer | reason |

### Language Switching Behavior

- Detect language on every user utterance (ElevenLabs handles this)
- Respond in the language of the last utterance
- If mixed ("I need un technician para el AC"), respond in the dominant language
  or ask: "¿Prefiere hablar en español o English?"
- Greeting is always bilingual: "Gracias por llamar a [Business]. Thanks for
  calling. ¿En qué puedo ayudarle? / How can I help?"

### Guardrails

- **No made-up prices**: If price unknown, say "Let me check with the owner and
  call you back"
- **No medical advice**: For health emergencies, say "Please call 911"
- **Human handoff**: Any request outside services/hours → offer transfer
- **Deposit cap**: Max $500 deposit via Stripe link
- **Confirmation required**: Always confirm booking details before creating

---

## 7. Parallel Mel Work Plan

### Workstream 1: Supabase Schema + API Routes

**Owner:** Agent A
**Files:** `supabase/migrations/`, `src/app/api/businesses/`,
`src/app/api/calls/`, `src/app/api/bookings/`, `src/lib/supabase.ts`
**Interfaces:**

- Exports: `createBusiness(data)`, `getBusiness(id)`, `createCall(data)`,
  `createBooking(data)`, `getBookings(businessId)`
- Expects: None (foundational)
**Task Prompt:**

```text
Set up Supabase project with tables: businesses, knowledge_bases, calls, bookings, briefings, sms_log.
Create Next.js API routes: POST /api/businesses, GET/PUT /api/businesses/[id], POST /api/calls, POST /api/bookings, GET /api/bookings?business_id=.
Write src/lib/supabase.ts with typed client.
Seed with one demo business: "Miami Cool Air Conditioning" with 3 services, hours, FAQs.
```

### Workstream 2: Next.js Dashboard + UI

**Owner:** Agent B
**Files:** `src/app/`, `src/components/`, `src/app/globals.css`,
`tailwind.config.ts`
**Interfaces:**

- Imports: API routes from WS1, Supabase types
- Exports: Dashboard pages, onboarding flow, call log, calendar view
**Task Prompt:**

```text
Build Next.js 14 App Router dashboard with:
- /onboarding: URL input form, business info review/edit form, "Go Live" button
- /dashboard: sidebar nav, call log table (with audio player), calendar view (bookings), settings panel
- /dashboard/briefings: list of daily briefings with audio player
Use shadcn/ui components: Button, Card, Table, Dialog, Form, Calendar.
Style with Tailwind. Responsive layout.
Mock data for demo: 3 past calls, 2 bookings, 1 briefing.
```

### Workstream 3: Website Extraction + Knowledge Base Generation

**Owner:** Agent C
**Files:** `src/app/api/extract/`, `src/lib/extraction.ts`,
`src/lib/kb-generator.ts`
**Interfaces:**

- Imports: None (standalone service)
- Exports: `extractFromURL(url)`, `generateKnowledgeBase(extractedData)`,
  `generateSystemPrompt(kb, business)`
**Task Prompt:**

```text
Build URL extraction pipeline:
- POST /api/extract: takes URL, uses cheerio/puppeteer to scrape text, then OpenAI GPT-4o to extract: business name, services (name, description, price), hours, service area, FAQs.
- generateKnowledgeBase(): converts extraction to JSON matching knowledge_bases schema.
- generateSystemPrompt(): creates full ElevenLabs system prompt from KB.
- Include fallback: if scraping fails, return template KB for "AC repair company".
- Add POST /api/kb/generate: accepts extracted data, returns KB + system prompt.
```

### Workstream 4: ElevenLabs Voice Agent + Twilio Integration

**Owner:** Agent D
**Files:** `src/app/api/voice/`, `src/lib/elevenlabs.ts`, `src/lib/twilio.ts`,
`src/app/api/webhooks/elevenlabs/`, `src/app/api/webhooks/twilio/`
**Interfaces:**

- Imports: WS1 API routes (createCall, createBooking)
- Exports: `handleIncomingCall()`, `handleCallEnded()`,
  `sendSMS(phone, message)`
**Task Prompt:**

```text
Build voice pipeline:
- Twilio webhook: incoming call → route to ElevenLabs Conversational AI agent
- ElevenLabs webhook: call started → create call record; call ended → update transcript, summary
- ElevenLabs agent tools: implement check_availability, create_booking, send_sms, create_payment_link, flag_emergency as HTTP endpoints at /api/voice/tools/[tool]
- These tool endpoints call Supabase (via WS1 API routes) and Twilio/Stripe APIs
- Test with ElevenLabs agent configured for "Miami Cool Air Conditioning"
- Spanglish handling: system prompt instructs bilingual responses; language detection is ElevenLabs-native
```

### Workstream 5: SMS + Stripe Payment Links

**Owner:** Agent E
**Files:** `src/app/api/sms/`, `src/app/api/payments/`, `src/lib/twilio.ts`,
`src/lib/stripe.ts`
**Interfaces:**

- Imports: WS1 (getBusiness, createBooking), WS4 (triggered from voice agent)
- Exports: `sendConfirmationSMS(booking)`,
  `sendPaymentLinkSMS(booking, amount)`,
  `createPaymentLink(amount, description)`
**Task Prompt:**

```text
Build SMS and payment infrastructure:
- POST /api/sms/send: generic SMS sender using Twilio
- POST /api/sms/confirmation: triggered after booking, sends confirmation with date/time/service/price
- POST /api/sms/payment-link: triggered for emergencies, sends Stripe payment link
- POST /api/payments/create-link: creates Stripe test payment link, returns URL
- POST /api/sms/gratitude: next-day follow-up SMS (stretch — build the endpoint, wire later)
- Mock/demo: pre-create 2 Stripe payment links for demo amounts ($150, $300)
```

### Workstream 6: End-of-Day Briefing + Gratitude Loop

**Owner:** Agent F
**Files:** `src/app/api/briefings/`, `src/lib/briefing.ts`,
`src/app/api/gratitude/`, `src/lib/gratitude.ts`
**Interfaces:**

- Imports: WS1 (getCalls, getBookings for date range)
- Exports: `generateBriefing(businessId, date)`, `generateBriefingAudio(text)`,
  `sendGratitudeSMS(bookingId)`
**Task Prompt:**

```text
Build briefing and gratitude system:
- POST /api/briefings/generate: fetches today's calls/bookings for business, generates summary text with OpenAI, creates briefing record
- POST /api/briefings/audio: takes briefing text, calls ElevenLabs TTS, saves audio URL
- GET /api/briefings?business_id=: list briefings
- POST /api/gratitude/send: sends SMS 24h after job; if reply is 4-5, send review link; if 1-3, flag owner
- Dashboard component: briefing player + "Generate Now" button
- Demo: pre-generate one briefing for "Miami Cool Air Conditioning"
```

### Integration Step (3:30–5:15)

1. **Merge all branches** into main
2. **Environment setup**: verify all API keys, test credentials
3. **End-to-end test**: call the number → speak Spanglish → book → check SMS →
   check dashboard
4. **Demo data**: ensure 3 calls, 2 bookings, 1 briefing pre-loaded
5. **Phone number**: confirm Twilio number is live and routed

---

## 8. Hour-by-Hour Timeline

| Time | Activity | Owner |
| --- | --- | --- |
| 12:00–12:15 | Kickoff: assign workstreams, verify API keys, create repo | Lead |
| 12:15–12:30 | Scaffold Next.js + Supabase project, push to GitHub | Lead |
| 12:30–3:00 | **Parallel build**: all 6 workstreams running simultaneously | Agents A–F |
| 3:00–3:30 | Lunch break | All |
| 3:30–4:00 | Merge branches, resolve conflicts, env setup | Lead |
| 4:00–5:00 | End-to-end testing: call flow, SMS, dashboard, briefing | All |
| 5:00–5:15 | Bug fixes, polish, demo data seeding | All |
| 5:15–5:45 | Record demo video (fallback), take Mel screenshots | Lead |
| 5:45–6:00 | Submit: GitHub repo, Mel session exports, problem/solution writeup | Lead |

---

## 9. Demo Script (3 Minutes)

**Setup:** Judge names a business (or we use pre-loaded "Miami Cool Air
Conditioning")

| Second | Action | What Judge Sees |
| --- | --- | --- |
| 0–15 | "Let's onboard a business. I paste this URL..." | Dashboard: URL input, extraction loading spinner |
| 15–30 | "Done. Here's the knowledge base..." | Dashboard: extracted services, hours, FAQs, editable |
| 30–45 | "Going live... here's the phone number." | Dashboard: "Live at +1-305-555-0199" |
| 45–90 | "Now I'm a customer calling..." (judge or we call) | Live call: "Gracias por llamar a Miami Cool Air. ¿En qué puedo ayudarle?" |
| 90–120 | Speak in Spanglish: "Hi, my AC is broken, hace mucho calor" | Agent switches: "No problem, ¿es una emergencia? Is it leaking water?" |
| 120–150 | "It's leaking a little..." | Agent: "I can book you for tomorrow at 2 PM. I'll send you a text." |
| 150–165 | Hang up, show phone | SMS arrives: confirmation with date, time, quote |
| 165–180 | "Now the owner checks their day..." | Dashboard: briefing audio plays — "Hola Jorge. Today you had 1 call..." |
| 180+ | Show bookings in calendar, flagged emergencies | Dashboard: calendar view, call log with transcript |

**Pre-recorded fallback:** If live call fails, play 90-second screen recording
of full flow.

---

## 10. Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| ElevenLabs latency >2s on demo call | Medium | High | Pre-warm agent 5 min before demo; have pre-recorded call audio as fallback |
| Twilio phone provisioning fails | Low | High | Pre-provision 3 numbers before hackathon; use pool approach |
| Website scraping fails for judge's URL | Medium | Medium | Fallback to template KB; demo uses pre-loaded business |
| Demo-day Wi-Fi unstable | Medium | High | Tether to phone hotspot; test on hotspot beforehand |
| Stripe payment link generation slow | Low | Medium | Pre-create 2 payment links for demo amounts |
| Spanglish detection fails | Medium | High | Test 5 Spanglish phrases beforehand; have script ready |
| Mel agent conflicts during parallel work | Medium | Medium | Clear file ownership per workstream; integration buffer built in |

---

## 11. Submission Checklist

- [ ] GitHub repo with README (setup instructions, architecture diagram)
- [ ] Mel session history exported (screenshots of agent work)
- [ ] Problem/solution description (1 page)
- [ ] How Mel was used: parallel workstreams, agent assignments
- [ ] Live demo OR recorded walkthrough (3 min max)
- [ ] API keys rotated / sanitized in repo
- [ ] Stripe in test mode, Twilio numbers are real

---

## 12. Product Name Ideas

| Name | Why It Works |
| --- | --- |
| **Recepcionista** | Spanish for "receptionist"; immediately clear what it does; sounds professional |
| **HolaDesk** | Bilingual greeting + desk; friendly, memorable, domain-friendly |
| **Switchboard AI** | Nods to old-school switchboard + AI; "switch" hints at language switching |
| **Atiende** | Spanish for "attends to" / "answers"; action-oriented, warm |
| **FrontDesk Miami** | Descriptive, local, SEO-friendly; boring but clear |

**Recommendation:** **Recepcionista** — distinctive, bilingual by default,
memorable for judges.

---

> PRD v1.0 — November 14, 2026 — Buildersgiving Miami AI Hackathon
