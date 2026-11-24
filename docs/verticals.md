# Verticals (trade templates)

The product is not HVAC-only. Each business has a **vertical** (`businesses.vertical`, default `hvac`), and everything that differs
between trades is read from one **pack** per vertical in `src/lib/verticals/`. A business with no vertical, or one the code does not
know, behaves as `hvac` (`packOf` never throws).

| Vertical | Emergency handling | Deposit by default | 911 copy |
| --- | --- | --- | --- |
| `hvac` | yes (leaks, no cooling with a vulnerable occupant, burning smell, total failure in heat) | on | gas, carbon monoxide, smoke, fire |
| `plumbing` | yes (burst pipe / flooding, sewage, no water with a vulnerable occupant, heater leak or gas smell) | on | gas smell, flooding near electrical outlets |
| `electrical` | yes (sparking panel, burning smell, downed line, outage with a vulnerable occupant) | on | fire, smoke, burning panel, downed line, shock |
| `dental` | yes (severe pain, dental trauma, uncontrolled bleeding, swelling or abscess) | off | breathing or swallowing trouble, bleeding, facial swelling or injury |
| `cleaning` | none (no triage, no urgent keywords) | off | generic |
| `landscaping` | none | on | generic |
| `general` | none | off | generic |

"Off" means the prompt tells the agent not to offer a deposit unless the owner's pricing notes require one; the $500 cap, the
secure-link-only rule and the "never take a card number" rule hold in every vertical. The `create_payment_link` tool exists in all of them.

## What a pack holds (`VerticalPack`, `src/lib/verticals/types.ts`)

Every human-readable text is an `L10n` (`{ en, es }`) so the later i18n pass can reuse the structure. A test asserts both languages are
present everywhere.

- `label`, `blurb`, `persona`, `provider`: names for the picker and the prompt ("a plumbing company", "plumber").
- `services` (name, description, starting price in dollars, duration), `hours`, `faqs`, `pricing` (default notes, the "who confirms the final
  price" sentence, the wording for an unpriced service, the fallback service): the seeds an owner starts from.
- `deposits.defaultOn`.
- `emergency`: `enabled`, `rules` (prompt bullets), `triage` (the questions asked), `keywords` and `strong` (post-call urgency),
  `vulnerable`, `call911` and `call911For` (what is spoken and the hazards in the tool result), `none` (the prompt text when disabled).
- `prompt`: greeting, qualifying questions, an example of a mixed-language sentence and trade words.
- `script`: the owner-reviewable call script (triage/qualifying and booking lines).
- `sms.fallbackService` (used when a booking has no service name) and `sms.confirmationNote` (a one-line preparation note added to the
  booking confirmation only when the whole text still fits one message, so the cancel and follow-up notices are never cut for it).
- `briefing.providerWord` and `tradeWords` (the daily voice note), `hints` (Spanglish detection words, the first test-call sentence, the
  service-name placeholder).

## Where the pack is read

| Code | Reads from the pack |
| --- | --- |
| `buildSystemPrompt`, `buildCallScript`, `generateKnowledgeBase` (`src/lib/kb/index.ts`) | persona, mixed-language example, pricing sentence, emergencies section or "no emergency dispatch" text, deposits block, qualifying questions, triage step, greeting, fallback service and notes |
| `promptIsDeficient(prompt, vertical)` | the EMERGENCIES section must hold that vertical's first rule, so a prompt written for another trade is rebuilt at provisioning |
| `kbReadiness` / `readinessOf*` (`src/lib/kb/readiness.ts`) | an example service in the "add services" blocker |
| `inferUrgency`, `normalizeLanguage`, call summary prompt (`src/lib/voice/postcall.ts`) | keywords, strong keywords, trade Spanish words, the trade named in the summary prompt |
| `flag_emergency` result and owner fallback (`src/lib/voice/tools.ts`, `emergency.ts`) | the spoken 911 sentence and the hazard list |
| owner call-in prompt (`src/lib/voice/owner/prompt.ts`) | the trade name only (no tenant data) |
| briefing fallback and voice-note prompt (`src/lib/briefing`) | provider word, trade words |
| customer texts (`src/lib/messaging/templates.ts`) | fallback service word, confirmation note |
| `templateResult` / `extractFromUrl` (`src/lib/extraction`) | the template for a business with no website, and the trade named in the extraction prompt |
| `syncAgent` (`src/lib/voice/elevenlabs.ts`) | nothing extra: it syncs the stored prompt, which is built from the business (including its vertical) |
| service-name matching (`src/lib/verticals/aliases.ts`) | one shared Spanish-to-English alias map for every trade |

The `flag_emergency` tool description is workspace-wide (one tool shared by every business), so it is neutral: it says to use the tool
for what the EMERGENCIES section of the prompt lists, and always when anyone is in danger.

## The 911 floor

The compliance block (`complianceRules`, marker `## DISCLOSURE, CONSENT AND LIFE SAFETY`) is appended to every prompt of every vertical:
a caller who mentions gas, carbon monoxide, fire, smoke, electrical sparking or any danger to life is told to call 911 first, even for a
cleaning company. A pack can only add to this. For the same reason post-call urgency has a small universal list
(`LIFE_SAFETY_STRONG`: gas smell / "huele a gas" / gas leak / "fuga de gas", "on fire" / house fire / "incendio", smoke coming / "sale humo", sparks / "chispas", electrocution, carbon monoxide...) that marks a call urgent in any vertical, including those with no keywords of
their own. Urgency is scored on what the CALLER said only (never on the agent's own triage question, which contains the pack's keywords on every call). Bare "fire" or "smoke" is deliberately not in the list (a smoke-detector install is not an emergency). A pack with emergency handling also puts its own 911 sentence (`emergency.call911`, English and Spanish) in the prompt's EMERGENCIES section: the agent says it first, before any tool.

## Choosing and changing the vertical

- **Onboarding** (first step, "Who are we hiring for?"): a "What kind of business is it?" selector (default HVAC). The choice is saved with
  the business (`POST /api/businesses` for an admin, `PATCH /api/businesses/:id` for an owner). With a website, the extraction prompt names
  the trade and an empty FAQ list or empty pricing notes are filled from the pack. Without one, the review step opens pre-filled with the
  pack's services, prices, FAQs, hours and pricing notes (in the business language). Nothing is saved until the owner continues, and every
  line is editable.
- **Settings > Business type** changes it later.
- **API**: `vertical` must be one of `hvac, plumbing, electrical, cleaning, landscaping, dental, general`; anything else is `422`
  (`vertical must be one of: ...`), and the database CHECK `businesses_vertical_check` (migration `20261201120000`) is the last line. No
  new migration was needed.
- **PATCH is owner-only** (staff 403). Changing the value of a business that has a phone number, an agent or is not in onboarding needs a
  recent proof of identity (the same step-up as call mode: `403 reauth_required`, re-enter the password). A business still in onboarding with
  nothing live, and a PATCH that does not change the value, do not.

### What a change does

It resets nothing the owner entered. Services, FAQs and pricing notes are never touched. Only what is derived is rebuilt
(`src/lib/verticals/change.ts`):

1. the stored system prompt is regenerated from the business (new vertical) and the existing services, FAQs and notes;
2. the call script is regenerated only if it is still exactly the one generated for the previous vertical; an owner-edited script is kept;
3. the voice agent is re-synced (`agent: synced | skipped | failed`). The whole step runs under a per-business lease and is built from the CURRENT business row, so two quick changes cannot leave the prompt of another trade. `failed` (a provider 5xx / timeout, or the prompt rebuild failed) is NOT silent: the PATCH response carries `vertical_sync` with `retry_queued: true`, the dashboard shows a warning instead of "saved", and the business is flagged (`processed_events` source `agent-dirty:<n>`) so the `reconcile` job re-syncs it every tick with exponential backoff (2 min doubling, 1 h cap) and gives up loudly after 8 attempts (`agent.resync_gave_up` audit row + error log: use `POST /api/admin/resync-agents`);
4. an audit row `business.vertical_changed` records `from`, `to`, what was rebuilt and `kb_content_kept: true`.

Seeds are used only for a **new** knowledge base (onboarding or provisioning a business with none). After a change the owner is told to
review the Brain page: the services and prices stay as they were, so they may still describe the old trade.

## Adding a vertical

1. Add the id to `Vertical` / `VERTICALS` in `src/lib/types.ts` **and** to the CHECK in a new migration (prove zero drift with
   `prisma migrate diff ... --exit-code`).
2. Add `src/lib/verticals/packs/<id>.ts` and register it in `src/lib/verticals/index.ts`.
3. `tests/verticals-pure.test.ts` checks the pack shape for every vertical automatically: both languages everywhere, bounded seeds, a
   seeded draft that passes the go-live minimum, a consistent emergency block, and (for any non-HVAC pack) no HVAC wording in prompts.

## Tests

- `tests/verticals-pure.test.ts` (no database): registry equals the schema list, pack shape, prompt per vertical (no HVAC wording outside
  HVAC), HVAC wording unchanged, emergency and 911 copy, post-call urgency, seeds, SMS and briefing, readiness, and a source scan that fails
  if prompt, voice, briefing, messaging or extraction code names the trade outside the packs.
- `tests/integration/verticals.test.ts` (needs `TEST_DATABASE_URL`): admin POST and owner PATCH validation, staff 403, other tenant 404,
  step-up, the audit row, the edited knowledge base and script surviving a change, provisioning from a pack, and `syncAgent` carrying the
  new trade (including the re-sync after a change) against the fake ElevenLabs.
