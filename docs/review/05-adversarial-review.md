# 05 — Adversarial review of the remediation branch

Branch `claude/serene-clarke-fowr2c` against `origin/main` (74 files). Reviewed by reading the code and running it:
`npx tsc --noEmit` (exit 0), `bun test` (37 pass), `bunx eslint src` (0 errors, 1 warning). I also ran `next dev` with
`ADMIN_TOKEN` set and an unreachable DB so I could probe the proxy, ran `next build`, and ran small node/bun scripts against
`safe-fetch`, `time`, `availability` and `money`. I changed no source files.

Severity: **Blocker** means it cannot ship. **High** means exploitable or breaks a core flow. **Medium** and **Low** follow.
Anything I could not reproduce is marked *unverified*.

---

## Blocker

### B1. `next build` fails, so the Docker image and `deploy.sh` cannot build
- **Where:** `src/app/onboarding/page.tsx:1,12` (`'use client'`, `import { normalizeUrl } from '@/lib/extraction'`), which imports `src/lib/extraction/index.ts:11`, which imports `src/lib/net/safe-fetch.ts:14-18` (`node:dns`, `node:http`, `node:https`, `node:net`, `node:zlib`).
- **Repro:**
  ```
  $ DATABASE_URL=postgresql://build:build@127.0.0.1:5432/build npx next build
  > Build error occurred
  Error [TurbopackInternalError]: Failed to write app endpoint /onboarding/page
  - the chunking context (unknown) does not support external modules (request: node:dns)
  ```
  In `next dev`, `GET /onboarding` returns 500 with a Turbopack panic. The Dockerfile `builder` stage runs `bun run build`, so `./deploy.sh` stops at `compose build`. CI does not run `next build` (`.github/workflows/ci.yml`), so it stays green.
- **Fix:** Move `normalizeUrl` into a client-safe module such as `src/lib/url.ts` with no Node imports. Do the structural checks there with `URL` plus a small pure IP-literal check, or keep only scheme and port checks on the client and leave the SSRF enforcement on the server. Add `import 'server-only'` to `safe-fetch.ts` and `extraction/index.ts`. Add a `bunx next build` step to CI.

---

## High

### H1. `/api/voice/agent-prompt` is public and dumps a tenant's whole system prompt, including the owner's phone
- **Where:** `src/lib/auth.ts:22` puts it in `PUBLIC_API_EXACT`. The route `src/app/api/voice/agent-prompt/route.ts:19-58` has no auth.
- **Exploit:** `curl https://<host>/api/voice/agent-prompt` returns the first business's `business_id`, `agent_id`, full `system_prompt`, `call_script`, services, prices and FAQs. `?business_id=<id>` works for any tenant. The prompt contains `Owner: <name> (<owner_phone>)` (`src/lib/kb/index.ts:112`), so this undoes the `publicBusiness()` stripping in `/api/businesses`. Review 01 (line 34) listed this exact dump as an exploit. The remediation made it public on purpose. In dev, with `ADMIN_TOKEN` set, the probe reached the handler (500 from the missing DB, not 401).
- **Fix:** Remove it from the public list (nothing in the app calls it, and CONTRACTS.md documents it only as a dev contract). If ElevenLabs needs it, protect it with the tool secret (`verifyToolSecret`) and return only what the agent needs.

### H2. A single env agent id leads to cross-tenant tool binding: one tenant's callers book into another tenant's calendar
- **Where:** `src/lib/voice/elevenlabs.ts:99-101` (`agentIdFor` falls back to `ELEVENLABS_AGENT_ID`), `:371-394` (PATCHes that agent and calls `rememberAgent`), `src/lib/db/index.ts:205-210` (`getBusinessByAgentId` returns `findFirst ... orderBy createdAt asc`), and `src/app/api/voice/tools/[tool]/route.ts:62-80` (overrides `business_id` with that result).
- **Scenario:** `.env.example:68` ships `ELEVENLABS_AGENT_ID`. The seed business (`biz_miami_cool_air`) has no agent id, so provisioning PATCHes the env agent and stores it on A. Onboarding business B also gets `agentIdFor(B) === env agent`. That agent is PATCHed with B's prompt and `dynamic_variables.business_id = B`, and the same id is stored on B. Every tool call then resolves `agent_id → oldest business = A`. B's callers hear B's receptionist but book into A's calendar, quote A's prices, and A's owner gets B's emergency and handoff texts (tenant.override is only logged). Post-call correlation (`postcall.ts:309-311`) has the same flaw.
- **Fix:** Never share an agent across businesses. Use the env agent only when exactly one business exists, or drop the fallback. Add a unique constraint on `businesses.agent_id` (partial, `WHERE agent_id IS NOT NULL`). In `bindTenant`, refuse the call (rather than pick the oldest) when several rows match, or when the platform-filled `business_id` disagrees with the agent mapping.

### H3. The voice-tool SMS recipient restriction is bypassed through `create_booking` and `create_payment_link`, with no country restriction
- **Where:** `src/lib/voice/tools.ts:327-371` (`customer_phone` is LLM-supplied and stored as the booking phone), `:385` `sendConfirmation(booking.id)` texts `booking.customer_phone`, and `:521-523` (`create_payment_link` sends to `booking.customer_phone || args.to || caller`). `SMS_ALLOWED_COUNTRY_CODES` is enforced only in `/api/sms/send/route.ts:16-21`. `sendSms` (`providers/twilio.ts:72`) has no filter.
- **Exploit:** The caller says "book me for AC repair, my number is +44 7xxx / +882…". The agent calls `create_booking` with that number, and a confirmation goes out from the business's Twilio number. The body includes the LLM-written `service` and `address` (`messaging/templates.ts:83-104`), for example "Your account is locked, visit evil.example", behind a trusted business-name prefix. One call can book every free slot (no per-call cap), and each booking sends one SMS: SMS pumping and phishing, the same as the original `send_sms` finding (#7) by another route. `create_booking` also overrides the trusted platform `caller_phone` with the LLM's phone for call matching (`tools.ts:350`: `{ ...args, caller_phone: phone }`).
- **Fix:** Default the booking/SMS phone to the platform `caller_phone` (`system__caller_id`). Accept a different `customer_phone` only after a same-country check, and send the confirmation only to the caller's number unless the owner approves. Put the country allowlist inside `sendSms`/`sendAndLog`. Cap bookings and SMS per conversation (for example 2 bookings and 3 texts per `conversation_id`). Drop `args.to` from `createPaymentLink`.

### H4. Auth fails open whenever `NODE_ENV !== 'production'`, and the repo documents running `next dev` exposed through a tunnel
- **Where:** `src/lib/auth.ts:45-54` (`open` mode), `providers/twilio.ts:40-49`, `voice/elevenlabs.ts:38-46,73-81`, `tools/[tool]/route.ts:76-78` (trusts the body's `business_id` when the secret is skipped), `payments/webhook/route.ts:50`. `next.config.ts:8-14` (`allowedDevOrigins` "e.g. a Cloudflare tunnel") and `README.md:253-258` (a systemd unit running `bun dev`) describe the setup.
- **Scenario:** An owner runs the README's `bun dev` unit with a tunnel and forgets `ADMIN_TOKEN` (`.env.example` leaves it empty). The dashboard and every API are open, webhooks are unsigned, and tools accept any `business_id`. That reopens every original Critical. Only a console warning is printed.
- **Fix:** Key the "open" behaviour off an explicit opt-in (`AUTH_DISABLED=true`) instead of `NODE_ENV`. Even then, honour it only for requests whose `Host` is `localhost`/`127.0.0.1`. Use the same flag for the webhook and tool skips.

---

## Medium

### M1. The proxy matcher's extension exemption skips auth for any dynamic API path ending in `.js`, `.txt`, `.css`, `.map` or similar, and no handler re-checks
- **Where:** `src/proxy.ts:27` (`.*\.(?:png|…|css|js|map|txt)$` is excluded). `requireAdmin` exists in `src/lib/auth.ts:116` but **no route calls it** (`grep requireAdmin src` hits only its definition).
- **Repro (dev, `ADMIN_TOKEN=secret123`, no credentials):**
  ```
  GET   /api/businesses           401   (proxy ran)
  GET   /api/businesses/x.js      500   (handler ran: Prisma error; the dev log shows no proxy.ts timing)
  GET   /api/businesses/x.txt     500
  PATCH /api/businesses/x.js      {"ok":false,"error":"business not found"}   (handler ran)
  ```
  Today this cannot reach real data, because ids are UUIDs or fixed seed ids that do not end in an extension. But any future dynamic segment, or a slug id, is exposed, and the "defense in depth" the comment promises does not exist. The 500 also leaks internal paths and Prisma text (`lib/http.ts:8-11` echoes `err.message`).
- **Fix:** Exclude only `/_next/static`, `/_next/image`, `/favicon.ico`, `/audio/` and files that really exist in `public/`. Never exempt by extension under `/api/`, for example by prefixing the negative lookahead with `(?!api/)`. Call `requireAdmin` at the top of every non-public handler. Stop returning raw error messages on 500.

### M2. Open redirect after login
- **Where:** `src/app/login/page.tsx:26-28` accepts any `next` that starts with `/` and not `//`.
- **Repro:** `new URL('/\\evil.com', 'https://app.example.com').href === 'https://evil.com/'`, checked with node. `/login?next=/%5Cevil.com` passes the check (URLSearchParams decodes `%5C` to `\`), and after a successful login `window.location.assign` sends the admin to `evil.com`. `"/\t/evil.com"` also escapes.
- **Fix:** Resolve `new URL(next, location.origin)` and require `u.origin === location.origin`. Then navigate to `u.pathname + u.search`.

### M3. Booking duration mismatch: offered slots get rejected
- **Where:** `check_availability` defaults to 60 min (`tools.ts:222`, `elevenlabs.ts:120-124`). The `create_booking` spec does not expose `duration_minutes` (`elevenlabs.ts:127-137`), yet `createBooking` books the catalog duration (`tools.ts:345-347`). Seed services run 90-480 min (`seed-data.ts:68-73`).
- **Scenario:** The agent offers "5 PM" (a 60-min slot that is free until close at 6 PM). The caller asks for AC repair (120 min), and the booking is rejected as `after_close`, or as `slot_taken` when a booking 60-120 min later exists. The caller hears "That job would run past our closing time…" for a time the agent just offered.
- **Fix:** Have `check_availability` take `service`, and resolve the duration with the same `matchService` logic, or expose `duration_minutes` on both tools and tell the agent to pass the same value.

### M4. Production deploy can pass with ElevenLabs secrets missing, and the live agent then breaks silently
- **Where:** `deploy.sh` and `compose.production.yaml` require only `ADMIN_TOKEN` and `STRIPE_WEBHOOK_SECRET`. In production the code fails closed without `ELEVENLABS_TOOL_SECRET` (every tool call returns 401, `elevenlabs.ts:73-78`) and without `ELEVENLABS_WEBHOOK_SECRET` (post-call returns 401).
- **Related:** `ensurePostCallWebhook` creates the webhook through the API and **discards** the `webhook_secret` it returns (`postcall.ts:108-118`; the provision route ignores it). The log tells the operator to copy it "from the ElevenLabs dashboard (shown once)", but it was never shown there. *Unverified:* whether the ElevenLabs UI can reveal or regenerate it.
- **Fix:** Make `deploy.sh` check `ELEVENLABS_TOOL_SECRET` and `ELEVENLABS_WEBHOOK_SECRET` whenever `ELEVENLABS_API_KEY` is set, and `TWILIO_AUTH_TOKEN` whenever `TWILIO_ACCOUNT_SID` is set. Show the returned webhook secret once in the provision response, admin-only, or tell the operator to create the webhook in the dashboard.

### M5. The login rate limiter is keyed on a spoofable, client-supplied value
- **Where:** `src/lib/auth.ts:137-142` (the first `X-Forwarded-For` entry, or `x-real-ip`, plus `authz.length`).
- **Repro (direct to the app):** 10 bad logins then `429 429`. The same request with `x-forwarded-for: 10.0.0.$i` gets a fresh 401 each time. The attacker can also lock the admin out by sending XFF set to the admin's IP. The `hits` map grows by one entry per spoofed key and is only swept after an hour idle. Behind Traefik with default `forwardedHeaders` (untrusted XFF stripped) this should not be exploitable (*unverified here*). It is exploitable on any path that bypasses Traefik, or behind a CDN or tunnel that forwards client XFF.
- **Fix:** Take the right-most untrusted hop (the entry Traefik appends), or have Traefik set `X-Real-IP` and use only that. Cap the map size.

---

## Low

- **L1. `/` (public) leaks the first tenant's metrics:** call count, Spanish-call count, booking count, deposit revenue and flagged count (`src/app/page.tsx:7-13`, rendered around lines 87-99). Use static marketing numbers, or gate them behind auth.
- **L2. `/pay/<bookingId>` is public, and seed booking ids are predictable** (`bk_demo_1`… in `seed-data.ts:140`). Anyone can view the business name, service and deposit for those ids. With `DEMO_MODE=true`, `POST /api/pay/mock-complete {"booking_id":"bk_demo_1"}` (public, `auth.ts:25`) marks a deposit paid with no auth. Use random seed ids, or use an unguessable pay token rather than the booking id.
- **L3. `.env.example:104` says `STRIPE_ALLOW_UNSIGNED=1`, but the code checks `=== 'true'`** (`payments/webhook/route.ts:50`). It fails safe but confuses. `.env.example:95` also says "Without STRIPE_SECRET_KEY, deposit links use the local /pay mock", but in production `createPaymentLink` throws (`stripe.ts:44`), so the voice tool says "I could not create that payment link".
- **L4. The Stripe webhook dedupe lives in process memory**, and `payment_link.completed` is not a real Stripe event type. When no booking matches, `checkout.session.completed` and `payment_intent.succeeded` (different event ids, same metadata) each send an "unmatched payment" owner SMS, so the owner gets two texts. `markDepositPaid` stays idempotent, so money state is fine.
- **L5. `create_payment_link` has no minimum.** An LLM passing dollars (`189`) makes a $1.89 link. In production Stripe rejects amounts below 50¢, which surfaces as a failure. Enforce `>= 100`, and reject values below 1000 with a re-ask, or take dollars as `price_estimate` does.
- **L6. The SSRF filter misses some IPv6 ranges** (`safe-fetch.ts:118-138`): `::ffff:0:a.b.c.d` (SIIT IPv4-translated) and `64:ff9b:1::/48` (local-use NAT64) return public. Checked: `isPublicIp('::ffff:0:7f00:1') === true` and `isPublicIp('64:ff9b:1::a00:1') === true`. These are only reachable through a NAT64/SIIT gateway. Block them anyway.
- **L7. Sessions never expire server-side.** The cookie is a deterministic HMAC with no timestamp (`auth.ts:89-91`), so a stolen cookie works until `ADMIN_TOKEN` is rotated. Embed `iat` and check `maxAge`.
- **L8. CSRF depends only on `SameSite=Lax`.** `readJson` ignores the content type (`lib/http.ts:13-18`), so a `text/plain` form POST is parsed. That is safe cross-site, but sibling subdomains on the same registrable domain count as same-site. Check `Origin` on non-GET `/api/**` in the proxy.
- **L9. The workspace-wide post-call webhook returns 400 for conversations of unrelated agents** in the same ElevenLabs workspace (`postcall.ts:359-362`). That causes retries and possibly auto-disable (*unverified*). Return 200 `{ignored}` instead.
- **L10. `gratitude-reply` cannot work with real Twilio inbound SMS.** Twilio posts `From`/`Body`, never `booking_id`, so production requests return 422 (`sms/gratitude-reply/route.ts:41-43`). Look up the latest gratitude SMS by `From`.
- **L11. CI runs only on `pull_request`, and does not run `next build`.** That is how B1 got through.

---

## Claims verified OK

- **Proxy path handling:** `..`, `%2e%2e`, `//`, trailing slash, uppercase `/API`, `%2f`, and `/pay/../api/...` all either got 401/307/308 or hit a harmless 404. `/api/voice/webhook-foo` → 401, so the prefix allowlist is only `/api/voice/tools/` and `/pay/`, and neither over-matches anything real. Bearer and cookie auth both pass the proxy.
- **Stripe:** the webhook reads the raw body before `JSON.parse`. It accepts multiple `v1` signatures, has a 300 s tolerance, uses a constant-time compare, and fails closed (503) with no secret. The unsigned escape hatch is ignored in production. The booking/business cross-check holds. `markDepositPaid` is idempotent and never reopens cancelled or completed bookings.
- **ElevenLabs:** HMAC over the raw body, timestamp tolerance, multiple `v0`, constant-time compare. Fails closed in production. The tool secret is compared with `timingSafeEqual`.
- **Twilio:** HMAC-SHA1 over sorted params, using the `PUBLIC_BASE_URL`/`APP_URL` origin plus the request URL as a fallback. Constant-time. Fails closed in production. The Dockerfile `runner` and `tools` stages set `NODE_ENV=production`.
- **SSRF:** validation runs in the socket `lookup`, so it pins the checked address. A mocked DNS returning 127.0.0.1 was blocked ("host resolves to a non-public address") under both node and bun. Decimal, hex, octal and short IPv4 forms, `[::ffff:127.0.0.1]`, `localhost.`, `*.localhost`, `*.internal`, userinfo and non-80/443 ports are all rejected. `agent:false` means `HTTP(S)_PROXY` is not used. Redirects are re-validated, and body cap, timeout and content-type checks are in place. No other server-side `fetch` of a user URL remains: all other `fetch(` calls target fixed provider hosts.
- **Time:** spring-forward gap 02:30 → 03:30 EDT, fall-back 01:30 → the earlier instant, Lord Howe's 30-min DST, the Santiago midnight gap (`dayRange` 23 h), `24:00` close. Offset-less strings are treated as business-zone wall-clock time; `+0530`, `-03` and `Z` are honoured; invalid dates are rejected. A start at 17:00 for 60 min with close at 18:00 is accepted, 17:01 is rejected (`after_close`).
- **Booking integrity:** the advisory lock plus re-validation in one transaction, and the gist exclusion constraint (`WHERE status <> 'cancelled'`) as a backstop. The migration pre-checks overlaps and fails loudly, multiplies money by 100 once inside Prisma's migration transaction, and `btree_gist` works for the compose superuser.
- **Money:** I grepped every `money()`/`formatCents()`/`price_estimate`/`deposit_amount` use and found no double conversion. `dollarsToCents` handles `"$1,200"`, `"189.99"` and NaN.
- **`send_sms` tool:** the recipient is limited to the matched caller or the owner. The `call_id` is validated against the resolved tenant. Owner-alert tools report `notified: false` honestly and give the 911 fallback.
- **Gating:** demo routes return 404 without `DEMO_MODE`. `/api/sms/send` is limited to known contacts, E.164 numbers, allowed country codes and 480 chars.
- **Checks:** `tsc` and `eslint` are clean and `bun test` is green (37 tests).

## Unverified / not attempted

- I did not build the Docker images (no docker), so whether the `tools` stage runs `prisma migrate deploy` as uid 1000 without engine-write errors is unknown.
- I did not check whether Prisma `migrate dev` drift detection tries to drop the hand-written exclusion constraint.
- I did not confirm that ElevenLabs fills `system__agent_id` and `system__caller_id` into webhook-tool bodies via `dynamic_variable`. H2 and the whole `bindTenant` design depend on it.
- Traefik's default XFF handling (M5).
