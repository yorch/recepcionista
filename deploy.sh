#!/usr/bin/env bash
#
# Deploy recepcionista to a host running Traefik.
#
#   ./deploy.sh            build the image, run migrations, (re)start the app
#   ./deploy.sh --seed     …and then load the demo dataset
#   ./deploy.sh --logs     follow the app logs after starting
#
# Safe to re-run: migrations are idempotent and `up -d` recreates only what
# changed. --seed is deliberately not part of the default path because
# scripts/seed.ts truncates every table before inserting.
set -Eeuo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

COMPOSE=(docker compose -f compose.production.yaml)
SEED=0
FOLLOW_LOGS=0

for arg in "$@"; do
  case "$arg" in
    --seed) SEED=1 ;;
    --logs) FOLLOW_LOGS=1 ;;
    -h|--help) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $arg (try --help)" >&2; exit 2 ;;
  esac
done

die() { echo "ERROR: $*" >&2; exit 1; }

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

if [[ -z "${STRIPE_WEBHOOK_SECRET:-}" ]]; then
  echo "WARNING: STRIPE_WEBHOOK_SECRET is unset — /api/payments/webhook will" >&2
  echo "         accept unsigned payloads. Fine for a private demo, not for a" >&2
  echo "         public host." >&2
fi

# The proxy's network is host-level infrastructure, not something this stack
# owns. Create it once rather than failing on a fresh host.
if ! docker network inspect traefik >/dev/null 2>&1; then
  echo "Creating external docker network 'traefik' (missing on this host)"
  docker network create traefik >/dev/null
fi

# Validates interpolation and mounts before anything is built.
"${COMPOSE[@]}" config >/dev/null || die "compose file is invalid"

# ---- build + start -------------------------------------------------------
"${COMPOSE[@]}" build

# `up -d` waits for db (healthy) and migrate (completed) before starting app,
# because of the depends_on conditions in the compose file.
"${COMPOSE[@]}" up -d --remove-orphans

if [[ "$SEED" == "1" ]]; then
  echo "Seeding the demo dataset (this truncates every table)…"
  # --rm so the one-shot container does not linger in `compose ps`.
  "${COMPOSE[@]}" --profile seed run --rm seed
fi

# ---- report --------------------------------------------------------------
APP_ID="$("${COMPOSE[@]}" ps -q app)"
[[ -n "$APP_ID" ]] || die "app container did not start"

echo
echo "Waiting for /api/health…"
for _ in $(seq 1 40); do
  STATUS="$(docker inspect -f '{{.State.Health.Status}}' "$APP_ID" 2>/dev/null || echo starting)"
  if [[ "$STATUS" == "healthy" ]]; then
    echo "app is healthy — https://${DOMAIN}"
    break
  fi
  if [[ "$STATUS" == "unhealthy" ]]; then
    "${COMPOSE[@]}" logs --tail=40 app >&2
    die "app is unhealthy (see logs above)"
  fi
  sleep 1.5
done

"${COMPOSE[@]}" ps

if [[ "$FOLLOW_LOGS" == "1" ]]; then
  "${COMPOSE[@]}" logs -f app
fi
