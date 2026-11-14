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

Two networks are load-bearing: the app is on `private`, an **internal** network with no
route off the host, so Postgres is unreachable from outside the project; and on `egress`,
which is what lets it call out to the providers. If provider calls start timing out, the
first thing to check is that `egress` is still attached.

## Prerequisites

On the server:

- Docker Engine + Compose. Verified locally against Compose v5.7. The `DATABASE_URL`
  expression uses nested interpolation (`${A:-${B}}`), matching
  `nextjs-mvp-super-template`; if an old Compose rejects it, set `DATABASE_URL_OVERRIDE`
  explicitly in `.env`.
- A running Traefik publishing `80`/`443`, with:
  - an external Docker network named **`traefik`** (`docker network create traefik`);
  - entrypoint **`websecure`**;
  - ACME certificate resolver named **`webcert`**.

  The stack uses those exact names. The host reference config is
  `~/code/docker-compose-services/traefik/docker-compose.yml` — note it sets
  `providers.docker.exposedbydefault=false`, which is why every label below is explicit.
- DNS: an A/AAAA record for `DOMAIN` pointing at the host. Traefik issues the certificate
  on first request, so this must resolve *before* the first `deploy.sh` or the app sits
  behind a TLS error.
- The repository checked out on the host. Images are built there (there is no registry in
  this setup), so it needs the source, not just the compose file.

## First deploy

```sh
cp .env.example .env
$EDITOR .env          # DOMAIN, APP_URL, POSTGRES_PASSWORD at minimum

./deploy.sh           # build → migrate → start → wait for healthy
./deploy.sh --seed    # optional: load the Miami Cool Air demo dataset
```

`deploy.sh` refuses to start when `DOMAIN`, `APP_URL` or `POSTGRES_PASSWORD` are blank, or
when `APP_URL` is not exactly `https://${DOMAIN}`. That last check exists because the two
drifting apart produces the worst failure mode: Traefik serves one hostname while the app
tells Stripe and Twilio to call back on another, and webhooks silently never arrive.

`--seed` is not implied. `scripts/seed.ts` truncates every table before inserting, so it is
safe to re-run but destructive on purpose.

## Pointing the providers at it

Every one of these must use the public origin from `APP_URL`:

| Provider | Endpoint |
| --- | --- |
| Twilio (voice webhook on the number) | `POST /api/voice/incoming` |
| ElevenLabs (post-call webhook) | `POST /api/voice/webhook` |
| ElevenLabs (agent tools) | `POST /api/voice/tools/<tool>` |
| Stripe (webhook) | `POST /api/payments/webhook` |
| Twilio (inbound SMS, gratitude replies) | `POST /api/sms/gratitude-reply` |

**Set `STRIPE_WEBHOOK_SECRET` in production.** Without it, `/api/payments/webhook` logs a
warning and accepts *unsigned* payloads — anyone who finds the URL can mark a deposit as
paid. The code comment says this is a demo affordance; on a public host it is a hole.
`deploy.sh` warns, but does not fail, when it is unset.

## Operating it

```sh
docker compose -f compose.production.yaml ps
docker compose -f compose.production.yaml logs -f app
docker compose -f compose.production.yaml restart app
docker compose -f compose.production.yaml run --rm migrate    # apply new migrations only
```

Redeploying after a `git pull` is just `./deploy.sh` again; Compose rebuilds, and
`migrate` runs before the new app container is allowed to start.

### Backups

The database is a named volume, so it survives `up`/`down` but not `down -v`. A nightly
dump is the difference between a bad afternoon and a lost demo:

```sh
docker compose -f compose.production.yaml exec -T db \
  pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB" | gzip > backup-$(date +%F).sql.gz
```

Restore with `gunzip -c backup.sql.gz | docker compose … exec -T db psql -U … -d …`.
If you want this automated, `prodrigestivill/postgres-backup-local` is the service
`~/code/tradr/deployment/compose.yml` uses; it drops in as a fourth service here.

### Rollback

There is no registry, so rollback means rebuilding a previous commit:

```sh
git checkout <previous-sha> && ./deploy.sh
```

Migrations are the caveat: `prisma migrate deploy` is forward-only, so rolling back the code
across a migration that dropped a column needs the matching database restore.

## Volumes

| Volume | Mount | Contents |
| --- | --- | --- |
| `recepcionista_pgdata` | `db:/var/lib/postgresql/data` | the database |
| `recepcionista_audio` | `app:/app/public/audio` | generated briefing audio |

The audio volume matters because `src/lib/briefing/tts.ts` writes `.mp3`/`.m4a` files into
`public/audio` at runtime and the app serves them as `/audio/<file>`. The image pre-creates
that directory owned by `node` so a fresh named volume inherits writable ownership; the
container's rootfs is otherwise read-only.

### Briefing audio needs ElevenLabs on Linux

The fallback TTS path shells out to macOS `say` + `afconvert`. On a Linux server that
binary does not exist, so with `ELEVENLABS_API_KEY` unset a briefing is stored with
`audio_url: null` — the transcript and stats still work, there is just nothing to play.
Set the key for the demo.

## Hardening, and what is still open

Applied: non-root (`node`), `read_only` rootfs with tmpfs for `/tmp` and the Next cache,
`cap_drop: ALL`, `no-new-privileges`, no published ports, fail-closed env interpolation,
and Postgres isolated on an internal network.

Not applied, worth knowing:

- **No `HEALTHCHECK` on `db`** beyond `pg_isready` — it does not detect a database that
  accepts connections but is stuck.
- **No log rotation** — the default `json-file` driver grows without bound. Set
  `logging: options: max-size` on `app` for a long-lived host.
- **No Watchtower** — nothing is watching for base-image or dependency CVEs. The `tradr` /
  `nextjs-mvp-super-template` stacks layer a `docker-compose.watchtower.yml` for this; it
  needs a registry image, which this build-on-host setup does not produce.
- **Single app replica** — `depends_on` health conditions make a second replica awkward.
  Fine for the demo; a real deployment would move the one-shot `migrate` out of the graph.
