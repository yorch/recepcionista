# Testing

```bash
bun test                  # everything; DB-backed suites are skipped without TEST_DATABASE_URL
bun run test:integration  # only tests/integration (needs TEST_DATABASE_URL)
bunx tsc --noEmit && bunx eslint src tests
```

## What runs where

| Path | Needs Postgres | Covers |
| --- | --- | --- |
| `tests/*.test.ts` | no | pure logic: time zones, availability maths, money, auth paths, proxy decisions, vertical packs (`verticals-pure.test.ts`) |
| `tests/db/` | yes | rate limit, processed events, leases, retention/erasure, users and sessions |
| `tests/integration/` | yes | route handlers called directly with real `Request`s: booking integrity (overlap, hours, DST, 20-way race), Stripe webhook, voice tools, Twilio and ElevenLabs signatures |

Integration tests import the route modules (for example `POST` from `@/app/api/payments/webhook/route`) and call
them in-process, so there is no dev server. Signatures are generated in the test with the same secrets the code
reads (`tests/helpers/env.ts`). Every provider is in its mock mode (Twilio/Stripe/ElevenLabs/LLM keys are unset)
and `fetch` is replaced by a guard that refuses and records any outbound request, so nothing can leave the machine.

## Scratch database

The suites create and delete rows, so point them at a disposable database. The name **must contain `test` or
`scratch`**; the helpers throw otherwise. Each test creates its own businesses and removes them at the end, so
nothing is wiped globally and runs can share one database.

Docker:

```bash
docker run -d --name rc-scratch -e POSTGRES_PASSWORD=postgres -p 54329:5432 postgres:17
docker exec rc-scratch createdb -U postgres scratch
export TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54329/scratch
DATABASE_URL=$TEST_DATABASE_URL bunx prisma migrate deploy
bun test
```

Local Postgres:

```bash
createdb recepcionista_test
export TEST_DATABASE_URL=postgresql://$USER@127.0.0.1:5432/recepcionista_test
DATABASE_URL=$TEST_DATABASE_URL bunx prisma migrate deploy
bun run test:integration
```

Re-run `prisma migrate deploy` whenever new migrations land (the exclusion constraint and the unique agent id
the tests rely on come from migrations). `LOG_LEVEL=debug` shows the application logs, which the tests silence.

The job runner, provisioning failure paths and SMS metering have their own files: `tests/jobs-schedule.test.ts` (time zones, DST, switches), `tests/integration/jobs.test.ts`
(two concurrent runners, billing/cap/quiet-hour gating, admin endpoints; the clock is injected with `now`), `tests/integration/provision-numbers.test.ts` (fake Twilio/ElevenLabs `fetch`: purchase failure,
partial failure + retry without a second purchase, production refusal) and `tests/sms-metering.test.ts` / `tests/integration/sms-metering.test.ts` (segments, emoji, footer budget, trial caps).

CI (`.github/workflows/ci.yml`) starts a `postgres:17` service (matching production), runs `prisma migrate deploy` against
`recepcionista_test` and then `bun test` with `TEST_DATABASE_URL` set.

## Destructive scripts

`scripts/seed.ts`, `scripts/smoke.ts` and `scripts/ws{1,3,4,5}-test.ts` print the target database and refuse to
run unless its name contains `dev`, `test`, `scratch` or `local`, or you pass `--force-i-know`
(`bun scripts/seed.ts --force-i-know`; the ws scripts forward the flag to the seed they run). `smoke.ts` also
refuses a non-local `APP_URL` without the flag, because it calls `/api/demo/reset` on that server. Note that the
default dev database from `.env.example` is `recepcionista_dev`, which passes. A local volume created before
the rename still holds a database called `recepcionista`; see "Renaming the dev database" in the README.

New suites: `tests/calendar.test.ts`, `tests/call-mode.test.ts`, `tests/hardening-pure.test.ts` (pure); `tests/integration/calendar.test.ts`, `tests/integration/call-mode.test.ts` (database); the migration test covers `20261127120000_call_mode_forwarding`.

Language suites: `tests/i18n-parity.test.ts`, `tests/i18n-core.test.ts`, `tests/i18n-emails.test.ts`, `tests/i18n-scan.test.ts` (pure); `tests/db/locale.test.ts` (database). See docs/i18n.md.
