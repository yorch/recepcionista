# Compliance notes

This is an engineering description of the legal-risk mitigations built into the app. It is **not legal
advice**. The first target market is Florida, an all-party recording-consent state (Fla. Stat. 934.03);
other states differ. Have counsel review the wording and the flows below before taking real calls.

## What the app does

### Recording / AI disclosure
- Every call opens with a disclosure (default, English + Spanish: "This call is handled by an AI
  assistant and may be recorded and transcribed."). It is the first thing in the agent's first message
  (`firstMessageFor`, `src/lib/voice/elevenlabs.ts`).
- Each business can **extend** the text (`businesses.recording_disclosure_text`, max 300 characters, edited
  at Dashboard > Settings), never replace the notice: if the custom text does not already state the AI and
  recording notice in both English and Spanish, the standard notice is appended (`disclosureFor`). Saving the
  setting re-syncs the ElevenLabs agent immediately (best effort).
- `calls.recording_disclosed = true` / `consent_status = 'disclosed'` are set only on SERVER-SIDE evidence:
  `/api/voice/incoming` just pushed the first message (which always contains the notice) to a real agent (or runs
  the scripted demo), or the post-call payload shows the AGENT's own first message/turn contained the
  disclosure. What the caller says never counts. If the agent refresh failed, the call stays `unknown`.
- The system prompt tells the agent: if the caller objects to recording/AI or says to stop, take a message
  for a human callback and call `handoff_to_human` with `consent_declined=true`. That sets
  `consent_status = 'declined'`, which is **sticky**: the write layer refuses to move a call out of `declined`.
  A caller's objection in the transcript ("I don't want to be recorded", "no quiero que me graben") is also
  treated as declined (a privacy-safe heuristic: it can only withhold data).
- Call correlation: every call is ONE row. `/api/voice/incoming` keys it by the Twilio CallSid; the first tool
  call of a native ElevenLabs call creates it, keyed by `system__call_sid` / `system__conversation_id`
  (`calls.call_sid`, `calls.conversation_id`); the post-call webhook matches on the conversation id, the SID
  (`metadata.phone_call.call_sid`, `system__call_sid`) or the legacy `call_id`. There is no "single live call" guess.
- Transcript, summary, recording URL and language are stored **only when the call's consent is `disclosed`**.
  A declined call, a call whose consent cannot be established (no disclosure evidence), and a post-call that
  cannot be tied to a conversation (or arrives while an unkeyed declined call exists) keep metadata only (ids,
  times, duration, status). For declined calls the provider conversation is also deleted (best effort).
  Limitation: the platform may already hold audio until deletion succeeds; configure ElevenLabs
  data-retention/zero-retention settings for a hard guarantee.

### SMS consent and opt-out
- **Point the Twilio number's inbound-SMS webhook at `POST /api/sms/inbound`** (and only there; a number has one
  inbound URL). It verifies the signature (fails closed), resolves the business from the `To` number, applies
  opt-out/opt-in/HELP keywords and routes a bare `1`-`5` reply to the gratitude logic. The older
  `/api/sms/gratitude-reply` URL also honours the keywords first.
- Keyword matching (`src/lib/messaging/keywords.ts`): the message is normalised (NFKC, case/accents folded,
  punctuation/emoji dropped). Opt-out = `STOP, STOPALL, STOP ALL, UNSUBSCRIBE, CANCEL, END, QUIT, REVOKE, OPTOUT,
  OPT OUT` (+ Spanish `PARAR, ALTO, BAJA, DETENER`) either alone or followed by at most three ordinary
  revocation words ("stop texting me", "please stop messaging me now"). "stop by tomorrow at 5" and "nonstop" are
  not opt-outs. Other messages that merely contain such a word are logged (`possible_revocation`), not acted on.
  `START` / `UNSTOP` re-subscribe; a bare `YES` does not. `HELP`/`INFO`/`AYUDA` reply with the business name.
- All sends go through `sendAndLog` (`src/lib/messaging`), which enforces:
  - owner alerts to the business's own owner phone: exempt from opt-out lists, no footer. `owner_alert` is
    **server-internal**: no HTTP route accepts `kind`, and `owner_phone` cannot be set to a number that opted out;
  - transactional customer texts (confirmation, payment link, reply to caller): blocked if opted out;
    "Reply STOP to opt out" is appended to every one (the body is trimmed by code point with an ASCII `...`, never
    the footer, within 300 characters and 5 SMS segments, and a GSM-7 message stays GSM-7);
  - owner free text (`POST /api/sms/send`, kind `manual`): customer rules plus quiet hours; the caller cannot
    choose the kind or the consent basis;
  - gratitude / review-request texts: blocked if opted out, blocked unless a recorded consent basis exists, and
    held 9pm-8am in the business time zone. The gratitude basis is **derived**: `bookings.followup_consent_at` is
    recorded only when a confirmation containing the follow-up notice ("We may text you after your visit") was
    actually delivered to the booking's own number. Bookings without it get `blocked_no_consent`. (Bookings made
    before this existed have no recorded consent and will not get gratitude texts.) A review request after the
    customer's own 4-5 reply uses `customer_reply`;
  - every outcome is written to `sms_log` with `consent_basis`; skips have status `blocked_opt_out`,
    `blocked_quiet_hours` or `blocked_no_consent`. Quiet-hours skips are retried by the next gratitude
    sweep; opt-out skips are not.
- Voice tools text only the **verified caller number** (the call row's caller, else the platform's
  `system__caller_id`, which is trusted because the tool route is authenticated by the tool secret and the field is
  bound to a platform variable the model cannot write) or the owner. The number the caller gives for a booking
  (`customer_phone`) is stored as the booking contact but is not texted unless it equals the caller's number
  (or `ALLOW_UNVERIFIED_BOOKING_SMS=true` when no caller id exists at all). A booking without any call key is refused,
  and the 2-bookings-per-call cap is counted on the call row.
- `POST /api/sms/payment-link` texts only the booking's own number, with a server-built message (no free text,
  no caller-chosen number; `booking_id` is mandatory).
- Opt-outs are never purged by retention or erasure (forgetting a STOP would re-enable texting).
- Known limitation: with Twilio Advanced Opt-Out / default long-code STOP handling Twilio itself blocks the number
  (error 21610) and may not forward the STOP to this webhook; the app's suppression list then only reflects STOPs it
  saw. Last-10-digit matching treats numbers from different countries with the same last ten digits as the same
  person (the country allow-list `SMS_ALLOWED_COUNTRY_CODES` defaults to `1`).

### Emergencies (911)
The prompt requires that for gas, carbon monoxide, fire, smoke, electrical sparking, flooding with an
electrical hazard or any life-safety sign the agent FIRST tells the caller to hang up and call 911 (and the
gas utility), and only then uses `flag_emergency`. `flag_emergency` speaks the 911 advice in its success,
failure and exception results, and still reports honestly whether the owner was actually notified.

### Retention and erasure
- **The automatic purge is OFF by default.** Every existing business carries `retention_days = 365`, so enabling
  it on upgrade would silently delete (and anonymise) everything older than a year. Review each business's window
  (Dashboard > Settings), then set `RETENTION_JOB=on`. While it is off, boot logs a warning with the counts a purge
  WOULD remove (`retention disabled_with_expired_data`).
- `POST /api/admin/retention` (admin only) runs the purge by hand: `{"dry_run": true}` (the default) only reports the
  counts; `{"dry_run": false}` purges. Works whether or not the job is on.
- `purgeExpiredData` (when on, daily from `instrumentation.ts`, `src/lib/retention-job.ts`) runs under the DB lease
  `job:retention-purge`, so multiple instances are safe. Per business `retention_days` (1-3650, default 365):
  calls/transcripts/SMS log/briefings deleted **together with the briefing audio files**, bookings anonymised
  (financial fields kept). The audio files live under `public/audio/` (a Docker volume) and are served only through
  the authenticated, tenant-scoped route `/api/briefings/audio/<file>` (`/audio/<file>` is rewritten to it; staff of
  that business or an admin); retention and erasure delete the files.
- `POST /api/privacy/erase { business_id, phone }` erases one customer (owner of that business, or admin): their
  calls, every `sms_log` row about them (texts to them AND owner alerts quoting their number, name or booking), the
  briefings that summarise a day they appear in (narration, stats and audio file), and anonymises their bookings.
- `GET /api/privacy/export?business_id=&phone=` returns the same set (calls, bookings, SMS log including owner alerts
  that mention them, briefings) as JSON for access requests (owner or admin).
- The owner's phone number is no longer written into the system prompt synced to ElevenLabs (and stored prompts
  that still had it were rewritten by migration `20261124120000`).

## What the operator must still do
- **After upgrading, re-provision every business** (`POST /api/businesses/:id/provision`, admin) so each existing
  ElevenLabs agent receives the current first message (disclosure) and compliance prompt. On the native
  ElevenLabs number path nothing else pushes them (only `/api/voice/incoming` and a settings save do), so agents
  created before this version keep their old opening until then.
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
