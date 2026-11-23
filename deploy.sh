#!/usr/bin/env bash
#
# Deploy recepcionista to a host running Traefik.
#
#   ./deploy.sh                                   build, back up the DB, migrate, (re)start
#   ./deploy.sh --seed --i-know-this-wipes-data   …and then load the demo dataset
#   ./deploy.sh --logs                            follow the app logs after starting
#
# Safe to re-run: migrations are idempotent and `up -d` recreates only what
# changed. Before `up -d`, if the database container is running, a gzipped
# pg_dump is written to $BACKUP_DIR (default ./backups). --seed is never implied:
# scripts/seed.ts truncates every table, so it also needs the explicit
# --i-know-this-wipes-data flag.
set -Eeuo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

COMPOSE=(docker compose -f compose.production.yaml)
SEED=0
CONFIRM_WIPE=0
FOLLOW_LOGS=0
BACKUP_DIR="${BACKUP_DIR:-./backups}"

for arg in "$@"; do
  case "$arg" in
    --seed) SEED=1 ;;
    --i-know-this-wipes-data) CONFIRM_WIPE=1 ;;
    --logs) FOLLOW_LOGS=1 ;;
    -h|--help) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $arg (try --help)" >&2; exit 2 ;;
  esac
done

die() { echo "ERROR: $*" >&2; exit 1; }

if [[ "$SEED" == "1" && "$CONFIRM_WIPE" != "1" ]]; then
  die "--seed truncates every table. Re-run with --seed --i-know-this-wipes-data to confirm."
fi

# ---- preconditions -------------------------------------------------------
[[ -f .env ]] || die ".env is missing. Copy .env.example to .env and fill it in."

# Compose interpolates .env before it parses the file, so a missing required
# variable surfaces as a cryptic parse error. Fail early with the reason.
set -a; . ./.env; set +a

[[ -n "${DOMAIN:-}" ]] || die "DOMAIN is unset in .env"
[[ -n "${APP_URL:-}" ]] || die "APP_URL is unset in .env"
[[ -n "${POSTGRES_PASSWORD:-}" ]] || die "POSTGRES_PASSWORD is unset in .env"

# These two drifting apart is the classic cause of webhooks that never arrive:
# Traefik serves one hostname while the app tells Stripe to call another.
[[ "${APP_URL}" == "https://${DOMAIN}" ]] \
  || die "APP_URL (${APP_URL}) must be exactly https://${DOMAIN}"

# This script only deploys to production, so these are hard requirements.
# Without the Stripe secret the webhook can be driven by anyone who finds the URL.
[[ -n "${STRIPE_WEBHOOK_SECRET:-}" ]] \
  || die "STRIPE_WEBHOOK_SECRET is unset in .env. Required in production (Stripe dashboard > Webhooks > signing secret)."
[[ -n "${ADMIN_TOKEN:-}" ]] \
  || die "ADMIN_TOKEN is unset in .env. Required in production: openssl rand -hex 32"

# Voice/SMS providers: in production the app fails closed without these, so a
# missing secret would deploy "successfully" and then reject every live call.
if [[ -n "${ELEVENLABS_API_KEY:-}" ]]; then
  [[ -n "${ELEVENLABS_TOOL_SECRET:-}" ]] \
    || die "ELEVENLABS_TOOL_SECRET is unset in .env but ELEVENLABS_API_KEY is set. Every voice tool call would 401. openssl rand -hex 32"
  [[ -n "${ELEVENLABS_WEBHOOK_SECRET:-}" ]] \
    || die "ELEVENLABS_WEBHOOK_SECRET is unset in .env but ELEVENLABS_API_KEY is set. Post-call webhooks would 401. See README (ElevenLabs webhook secret)."
fi
if [[ -n "${TWILIO_ACCOUNT_SID:-}" && -z "${TWILIO_AUTH_TOKEN:-}" ]]; then
  die "TWILIO_AUTH_TOKEN is unset in .env but TWILIO_ACCOUNT_SID is set."
fi

# The proxy's network is host-level infrastructure, not something this stack
# owns. Create it once rather than failing on a fresh host.
if ! docker network inspect traefik >/dev/null 2>&1; then
  echo "Creating external docker network 'traefik' (missing on this host)"
  docker network create traefik >/dev/null
fi

# Validates interpolation and mounts before anything is built.
"${COMPOSE[@]}" config >/dev/null || die "compose file is invalid"

# ---- build + backup + start ----------------------------------------------
"${COMPOSE[@]}" build

# Back up before `up -d`, because `up -d` runs `migrate`, which is forward-only.
# Skipped on a first deploy, when there is no database container yet.
DB_ID="$("${COMPOSE[@]}" ps -q db 2>/dev/null || true)"
if [[ -n "$DB_ID" && "$(docker inspect -f '{{.State.Running}}' "$DB_ID" 2>/dev/null || true)" == "true" ]]; then
  mkdir -p "$BACKUP_DIR"
  BACKUP_FILE="$BACKUP_DIR/pre-deploy-$(date -u +%Y%m%dT%H%M%SZ).sql.gz"
  echo "Backing up the database to $BACKUP_FILE"
  # $POSTGRES_USER and $POSTGRES_DB must expand inside the db container, not on
  # the host, where they are not set.
  if ! "${COMPOSE[@]}" exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"' | gzip > "$BACKUP_FILE"; then
    rm -f "$BACKUP_FILE"
    die "database backup failed; not deploying"
  fi
else
  echo "No running database container yet; skipping pre-deploy backup."
fi

# `up -d` waits for db (healthy) and migrate (completed) before starting app,
# because of the depends_on conditions in the compose file.
"${COMPOSE[@]}" up -d --remove-orphans

if [[ "$SEED" == "1" ]]; then
  echo "Seeding the demo dataset (this truncates every table)…"
  # --rm so the one-shot container does not linger in `compose ps`.
  # deploy.sh already required --i-know-this-wipes-data, so pass the seed script's own override: the production
  # database name ("recepcionista") does not look disposable to its guard.
  "${COMPOSE[@]}" --profile seed run --rm seed bun scripts/seed.ts --force-i-know
fi

# ---- report --------------------------------------------------------------
APP_ID="$("${COMPOSE[@]}" ps -q app)"
[[ -n "$APP_ID" ]] || die "app container did not start"

echo
echo "Waiting for /api/health…"
HEALTHY=0
for _ in $(seq 1 40); do
  STATUS="$(docker inspect -f '{{.State.Health.Status}}' "$APP_ID" 2>/dev/null || echo starting)"
  if [[ "$STATUS" == "healthy" ]]; then
    HEALTHY=1
    echo "app is healthy — https://${DOMAIN}"
    break
  fi
  if [[ "$STATUS" == "unhealthy" ]]; then
    "${COMPOSE[@]}" logs --tail=40 app >&2
    die "app is unhealthy (see logs above)"
  fi
  sleep 1.5
done

if [[ "$HEALTHY" != "1" ]]; then
  "${COMPOSE[@]}" logs --tail=40 app >&2
  die "app did not become healthy within 60s (see logs above)"
fi

"${COMPOSE[@]}" ps

if [[ "$FOLLOW_LOGS" == "1" ]]; then
  "${COMPOSE[@]}" logs -f app
fi
