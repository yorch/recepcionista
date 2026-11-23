# Deploying Recepcionista

A self-contained Docker Compose stack for a host that already runs Traefik.

```text
                     ┌──────────────────────────────────────────┐
   internet ──443──▶ │ Traefik (host-level, owns TLS + ACME)     │
                     │   router: recepcionista                   │
                     └──────────────────┬───────────────────────┘
                                        │ traefik network
                     ┌──────────────────▼───────────────────────┐
                     │ app   Next.js standalone, non-root,       │
                     │       read-only rootfs                    │
                     └───┬───────────────────────┬───────────────┘
              private    │                       │ egress
             (internal)  │                       ▼
       ┌─────────────────▼─────┐        ElevenLabs · Twilio ·
       │ db    postgres:17     │        Stripe · OpenAI/Anthropic
       │       volume: pgdata  │
       └───────────────────────┘
             ▲
       ┌─────┴─────────────────┐
       │ migrate (one-shot)    │  prisma migrate deploy
       └───────────────────────┘
```

Two networks are load-bearing: the app is on `private`, an **internal** network
with no
route off the host, so Postgres is unreachable from outside the project; and on
`egress`,
which is what lets it call out to the providers. If provider calls start timing
out, the
first thing to check is that `egress` is still attached.

## Prerequisites

On the server:

- Docker Engine + Compose. Verified locally against Compose v5.7. The
  `DATABASE_URL`
  expression uses nested interpolation (`${A:-${B}}`), matching
  `nextjs-mvp-super-template`; if an old Compose rejects it, set
`DATABASE_URL_OVERRIDE`
  explicitly in `.env`.
- A running Traefik publishing `80`/`443`, with:
  - an external Docker network named **`traefik`**
    (`docker network create traefik`);
  - entrypoint **`websecure`**;
  - ACME certificate resolver named **`webcert`**.

  The stack uses those exact names. The host reference config is
  `~/code/docker-compose-services/traefik/docker-compose.yml` — note it sets
  `providers.docker.exposedbydefault=false`, which is why every label below is
explicit.
- DNS: an A/AAAA record for `DOMAIN` pointing at the host. Traefik issues the
  certificate
  on first request, so this must resolve *before* the first `deploy.sh` or the
app sits
  behind a TLS error.
- The repository checked out on the host. Images are built there (there is no
  registry in
  this setup), so it needs the source, not just the compose file.

## First deploy

```sh
cp .env.example .env
$EDITOR .env          # DOMAIN, APP_URL, POSTGRES_PASSWORD, ADMIN_TOKEN,
                      # STRIPE_WEBHOOK_SECRET at minimum

./deploy.sh           # build → back up DB → migrate → start → wait for healthy
./deploy.sh --seed --i-know-this-wipes-data   # optional: demo dataset (wipes data)
```

`deploy.sh` refuses to start when any of these are blank:

- `DOMAIN`, `APP_URL`, `POSTGRES_PASSWORD`
- `ADMIN_TOKEN`: generate with `openssl rand -hex 32`
- `STRIPE_WEBHOOK_SECRET`: without it the Stripe webhook must not be trusted

It also refuses when `APP_URL` is not exactly `https://${DOMAIN}`. That last
check exists because the two drifting apart produces the worst failure mode:
Traefik serves one hostname while the app tells Stripe and Twilio to call back
on another, and webhooks silently never arrive.

If the app does not report healthy within 60 seconds, `deploy.sh` prints the
last log lines and exits non-zero.

**Backups happen automatically.** Before `up -d` runs `migrate`, `deploy.sh`
writes a gzipped `pg_dump` to `./backups/` (override with `BACKUP_DIR`) when the
database container is running. A first deploy has no database yet, so it has
nothing to back up. Keep `backups/` out of git.

`--seed` is not implied, and it needs `--i-know-this-wipes-data` as well.
`scripts/seed.ts` truncates every table before inserting, so the flag makes the
destructive step deliberate.

## Pointing the providers at it

Every one of these must use the public origin from `APP_URL`:

| Provider | Endpoint |
| --- | --- |
| Twilio (voice webhook on the number) | `POST /api/voice/incoming` |
| ElevenLabs (post-call webhook) | `POST /api/voice/webhook` |
| ElevenLabs (agent tools) | `POST /api/voice/tools/<tool>` |
| Stripe (deposit webhook, `STRIPE_WEBHOOK_SECRET`) | `POST /api/payments/webhook` |
| Stripe (subscription webhook, `STRIPE_BILLING_WEBHOOK_SECRET`; needed when `BILLING_ENFORCED=true`) | `POST /api/billing/webhook` |
| ElevenLabs (conversation-initiation webhook, header `x-recepcionista-tool-secret`) | `POST /api/voice/initiation` |
| Twilio (inbound SMS: STOP/START/HELP and 1-5 gratitude replies) | `POST /api/sms/inbound` (the number has ONE inbound URL; `/api/sms/gratitude-reply` still honours STOP but is legacy) |

**Required `.env` values.** Besides the database, `DOMAIN`/`APP_URL` and the provider secrets above, `deploy.sh` refuses to run without
`APP_SECRET_KEY` (32 random bytes, base64), `EMAIL_PROVIDER` = `resend`|`smtp` with `EMAIL_FROM` and its key (signup verification,
password reset and invitations send mail; `log` is refused in production), the Turnstile site/secret pair when either is set, and
with `BILLING_ENFORCED=true` also `STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID` and `STRIPE_BILLING_WEBHOOK_SECRET`. It also refuses
`DEMO_MODE`, `ALLOW_INSECURE_DEV` or `STRIPE_ALLOW_UNSIGNED` set to `true`. The full table is `docs/env-vars.md`.
`NEXT_PUBLIC_*` values are build arguments (compose passes them), so changing them needs a re-run of `./deploy.sh`.

**Existing customers and `BILLING_ENFORCED`.** Before turning plans on, comp every existing tenant:
`docker compose -f compose.production.yaml --profile seed run --rm seed bun scripts/grandfather-existing.ts --force-i-know`
(a dry run that lists what would change; add `--apply` to write; the `seed` service is only a one-shot tools container, nothing is seeded). Details and the `OWNER_PHONE_GRANDFATHER` alternative: `docs/billing.md`.

**Retention is off until you turn it on.** `RETENTION_JOB` defaults to off: nothing is auto-deleted after an
upgrade (existing businesses have a 365-day window, which would otherwise purge older data on first boot). Boot
logs the counts that *would* be purged. Review each business's window (Dashboard > Settings), check with
`POST /api/admin/retention {"dry_run":true}` (admin token), then set `RETENTION_JOB=on` in `.env`. See `docs/compliance.md`.

**Set `STRIPE_WEBHOOK_SECRET` in production.** Without it,
`/api/payments/webhook` would accept *unsigned* payloads, and anyone who finds
the URL could mark a deposit as paid. `deploy.sh` refuses to deploy when it is
unset, and `compose.production.yaml` fails `compose up` for the same reason.
`STRIPE_ALLOW_UNSIGNED` is a dev-only override and must not be set here.

## Operating it

```sh
docker compose -f compose.production.yaml ps
docker compose -f compose.production.yaml logs -f app
docker compose -f compose.production.yaml restart app
docker compose -f compose.production.yaml run --rm migrate    # apply new migrations only
```

Redeploying after a `git pull` is just `./deploy.sh` again; Compose rebuilds,
and
`migrate` runs before the new app container is allowed to start.

### Backups

The database is a named volume, so it survives `up`/`down` but not `down -v`. A
nightly
dump is the difference between a bad afternoon and a lost demo:

```sh
# The variables must expand inside the db container, where they are set. The
# single quotes keep the host shell from expanding them (they are unset here).
docker compose -f compose.production.yaml exec -T db \
  sh -c 'pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"' | gzip > backup-$(date +%F).sql.gz
```

`deploy.sh` also writes a dump to `./backups/` before each migration. The manual
command above is for a nightly job or an extra copy off the host.

Restore with
`gunzip -c backup.sql.gz | docker compose -f compose.production.yaml exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"'`.
If you want this automated, `prodrigestivill/postgres-backup-local` is the
service
`~/code/tradr/deployment/compose.yml` uses; it drops in as a fourth service
here.

### Rollback

There is no registry, so rollback means rebuilding a previous commit:

```sh
git checkout <previous-sha> && ./deploy.sh
```

Migrations are the caveat: `prisma migrate deploy` is forward-only, so rolling
back the code
across a migration that dropped a column needs the matching database restore.
The compliance migrations (`20261123210000_*`, `20261124120000_*`) only ADD columns, tables and CHECK constraints,
so the previous code keeps working against the migrated schema; to undo them for real restore the pre-deploy
`pg_dump` (the only supported path back). The `ADD CONSTRAINT` statements in `20261123210000` are validated
immediately (a full scan under an exclusive lock): fine now, but on a very large `calls` table apply such
constraints as `NOT VALID` + `VALIDATE CONSTRAINT` in a later migration.

## Volumes

| Volume | Mount | Contents |
| --- | --- | --- |
| `recepcionista_pgdata` | `db:/var/lib/postgresql/data` | the database |
| `recepcionista_audio` | `app:/app/public/audio` | generated briefing audio |

The audio volume matters because `src/lib/briefing/tts.ts` writes `.mp3`/`.m4a`
files into
`public/audio` at runtime. Next does not serve `public/` files created after the build, so `/audio/<file>` is
rewritten (next.config.ts) to the authenticated route `/api/briefings/audio/<file>`, which streams them to staff of the
business that owns the briefing. The image
pre-creates
that directory owned by `node` so a fresh named volume inherits writable
ownership; the
container's rootfs is otherwise read-only.

### Briefing audio needs ElevenLabs on Linux

The fallback TTS path shells out to macOS `say` + `afconvert`. On a Linux server
that
binary does not exist, so with `ELEVENLABS_API_KEY` unset a briefing is stored
with
`audio_url: null` — the transcript and stats still work, there is just nothing
to play.
Set the key for the demo.

## Hardening, and what is still open

Applied: non-root (the app runs as `node`, uid 1000, and the migrate image runs
as uid 1000 too), `read_only` rootfs with tmpfs for `/tmp` and the
Next cache,
`cap_drop: ALL`, `no-new-privileges`, no published ports, fail-closed env
interpolation (including `ADMIN_TOKEN` and `STRIPE_WEBHOOK_SECRET`), and
Postgres isolated on an internal network.

## Access control

The owner dashboard and the JSON API are protected by `ADMIN_TOKEN`: sign in at
`/login`, or send `Authorization: Bearer <token>`. Provider webhooks are checked
with their own signatures. See the Authentication section of the README.

Before you point a provider at the host, confirm on the deployed build that
these return 401 without a credential: `/dashboard`, `/api/businesses`,
`/api/sms/send`, and `/api/extract` (owners may call `/api/extract` and `/api/businesses/<id>/provision` for their own business only, with a verified email and, when enforced, a paid plan). Also confirm that `/api/demo/*` is not
reachable (`DEMO_MODE` unset). The full pre-launch list is in the README
security checklist.

Not applied, worth knowing:

- **No `HEALTHCHECK` on `db`** beyond `pg_isready` — it does not detect a
  database that
  accepts connections but is stuck.
- **No log rotation** — the default `json-file` driver grows without bound. Set
  `logging: options: max-size` on `app` for a long-lived host.
- **No Watchtower** — nothing is watching for base-image or dependency CVEs. The
  `tradr` /
  `nextjs-mvp-super-template` stacks layer a `docker-compose.watchtower.yml` for
this; it
  needs a registry image, which this build-on-host setup does not produce.
- **Single app replica** — `depends_on` health conditions make a second replica
  awkward.
  Fine for the demo; a real deployment would move the one-shot `migrate` out of
the graph.
