# Compliance notes

This is an engineering description of the legal-risk mitigations built into the app. It is **not legal
advice**. The first target market is Florida, an all-party recording-consent state (Fla. Stat. 934.03);
other states differ. Have counsel review the wording and the flows below before taking real calls.

## What the app does

### Recording / AI disclosure
- Every call opens with a disclosure (default, English + Spanish: "This call is handled by an AI
  assistant and may be recorded and transcribed."). It is the first thing in the agent's first message
  (`firstMessageFor`, `src/lib/voice/elevenlabs.ts`).
- Each business can override the text (`businesses.recording_disclosure_text`, max 300 characters, edited
  at Dashboard > Privacy and consent). Empty = default.
- `calls.recording_disclosed = true` and `consent_status = 'disclosed'` are set when `/api/voice/incoming`
  creates the call. Calls created elsewhere (tool/post-call) are upgraded to `disclosed` only when the
  transcript shows the notice was spoken; otherwise they stay `unknown`.
- The system prompt tells the agent: if the caller objects to recording/AI or says to stop, take a message
  for a human callback and call `handoff_to_human` with `consent_declined=true`. That sets
  `consent_status = 'declined'`.
- Declined calls: post-call processing stores **no transcript, summary text, recording URL or language**
  (only ids, times, duration, status) and asks ElevenLabs to delete the conversation (best effort).
  Limitation: the platform may already hold audio until deletion succeeds; configure ElevenLabs
  data-retention/zero-retention settings for a hard guarantee.

### SMS consent and opt-out
- `POST /api/sms/inbound` (Twilio webhook, signature verified, fails closed; business resolved from the
  `To` number): STOP/STOPALL/UNSUBSCRIBE/CANCEL/END/QUIT record an opt-out, START/YES/UNSTOP remove it,
  HELP replies with the business name. Whole-message keyword matching only.
- All sends go through `sendAndLog` (`src/lib/messaging`), which enforces:
  - owner alerts to the business's own owner phone: exempt from opt-out lists, no footer;
  - transactional customer texts (confirmation, payment link, reply to caller): blocked if opted out;
    "Reply STOP to opt out" is appended to every one (the body is trimmed, never the footer; 300-char cap);
  - gratitude / review-request texts: blocked if opted out, blocked unless a recorded consent basis is
    one of `express_opt_in`, `booking_followup`, `customer_reply`, and held 9pm-8am in the business time
    zone;
  - every outcome is written to `sms_log` with `consent_basis`; skips have status `blocked_opt_out`,
    `blocked_quiet_hours` or `blocked_no_consent`. Quiet-hours skips are retried by the next gratitude
    sweep; opt-out skips are not.
- Opt-outs are never purged by retention or erasure (forgetting a STOP would re-enable texting).

### Emergencies (911)
The prompt requires that for gas, carbon monoxide, fire, smoke, electrical sparking, flooding with an
electrical hazard or any life-safety sign the agent FIRST tells the caller to hang up and call 911 (and the
gas utility), and only then uses `flag_emergency`. `flag_emergency` speaks the 911 advice in its success,
failure and exception results, and still reports honestly whether the owner was actually notified.

### Retention and erasure
- `purgeExpiredData` runs daily from `instrumentation.ts` (`src/lib/retention-job.ts`) under the DB lease
  `job:retention-purge`, so multiple instances are safe. Disable with `RETENTION_JOB=off`. Per business
  `retention_days` (1-3650, default 365): calls/transcripts/SMS log/briefings deleted, bookings
  anonymised (financial fields kept).
- `POST /api/privacy/erase { business_id, phone }` erases one customer (admin).
- `GET /api/privacy/export?business_id=&phone=` returns the customer's calls, bookings and SMS log as
  JSON for access requests (admin).
- The owner's phone number is no longer written into the system prompt synced to ElevenLabs.

## What the operator must still do
- **10DLC registration** (brand + campaign) with Twilio before sending US application-to-person texts;
  the campaign description must match the messages above, including the STOP/HELP language.
- Have **counsel review the disclosure wording** and the consent bases for each state served; decide whether
  gratitude/review texts need express written consent for your use (this app only records the basis you
  assert; it cannot verify it).
- Sign **DPAs** with Twilio, ElevenLabs and the LLM provider (OpenAI-compatible); check their retention,
  training and sub-processor terms; set provider-side retention to match `retention_days`.
- Publish a **privacy policy** and terms; set up a process for access/erasure requests (the endpoints above
  are the tooling, not the process) and for the Twilio-side STOP handling (Twilio may also auto-reply).
- Provider-side recordings/transcripts are not purged by the app (except declined calls, best effort);
  delete or expire them in the provider consoles.
- Keep `retention_days` consistent with any legal-hold, tax or insurance requirements.

## Out of scope
Legal advice; jurisdiction-specific disclosure variants; verifying that a caller actually heard the
disclosure; call-recording by the app itself (recording is the voice provider's); TCPA written-consent
capture UI; do-not-call list scrubbing; consent line in onboarding; privacy text on the public `/pay` page;
HIPAA/PCI scope; data residency.
