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

# Account lifecycle (docs/env-vars.md). Without these the deploy "works" and then every signup, password reset and 2FA enrolment
# fails closed in production, so refuse here instead.
if [[ -z "${APP_SECRET_KEY:-}" ]]; then
  die "APP_SECRET_KEY is unset in .env. Required in production (encrypts 2FA secrets): openssl rand -base64 32"
fi
[[ "$(printf '%s' "$APP_SECRET_KEY" | base64 -d 2>/dev/null | wc -c | tr -d ' ')" == "32" ]] \
  || die "APP_SECRET_KEY must be 32 random bytes, base64 encoded (openssl rand -base64 32)"
case "${EMAIL_PROVIDER:-}" in
  resend)
    [[ -n "${RESEND_API_KEY:-}" ]] || die "EMAIL_PROVIDER=resend but RESEND_API_KEY is unset in .env" ;;
  smtp)
    [[ -n "${SMTP_URL:-}" || -n "${SMTP_HOST:-}" ]] || die "EMAIL_PROVIDER=smtp but neither SMTP_URL nor SMTP_HOST is set in .env" ;;
  *)
    die "EMAIL_PROVIDER must be 'resend' or 'smtp' in production (got '${EMAIL_PROVIDER:-}'); 'log' is refused. Verification and reset emails depend on it." ;;
esac
[[ -n "${EMAIL_FROM:-}" ]] || die "EMAIL_FROM is unset in .env (e.g. 'Recepcionista <no-reply@${DOMAIN}>')"
# Signup abuse control: the Turnstile site key (public, build time) and secret (server) only work as a pair.
if [[ -n "${NEXT_PUBLIC_TURNSTILE_SITE_KEY:-}" && -z "${TURNSTILE_SECRET_KEY:-}" ]]; then
  die "NEXT_PUBLIC_TURNSTILE_SITE_KEY is set but TURNSTILE_SECRET_KEY is not: the widget would render but nothing would verify it."
fi
if [[ -n "${TURNSTILE_SECRET_KEY:-}" && -z "${NEXT_PUBLIC_TURNSTILE_SITE_KEY:-}" ]]; then
  die "TURNSTILE_SECRET_KEY is set but NEXT_PUBLIC_TURNSTILE_SITE_KEY is not: every signup would fail closed (no token). Set the site key before building."
fi
# Open signup REQUIRES a captcha in production (owner decision): the full Turnstile pair, or the explicit, loud opt-out
# SIGNUP_ALLOW_WITHOUT_CAPTCHA=true. Without either the app refuses public signup (503 signup_disabled; invites still work),
# so a deploy that would silently ship a dead /signup is refused here instead.
if [[ -z "${TURNSTILE_SECRET_KEY:-}" || -z "${NEXT_PUBLIC_TURNSTILE_SITE_KEY:-}" ]]; then
  case "${SIGNUP_ALLOW_WITHOUT_CAPTCHA:-}" in
    true) ;;
    *) die "Open signup needs Turnstile in production: set TURNSTILE_SECRET_KEY and NEXT_PUBLIC_TURNSTILE_SITE_KEY, or (not recommended) SIGNUP_ALLOW_WITHOUT_CAPTCHA=true. Without either, /api/auth/signup answers 503 signup_disabled and /signup is invite-only (docs/auth.md)." ;;
  esac
fi
# Dev/demo switches must never reach production.
for v in DEMO_MODE ALLOW_INSECURE_DEV STRIPE_ALLOW_UNSIGNED; do
  [[ "${!v:-}" != "true" ]] || die "${v}=true in .env: never enable it on a production host (docs/runbook.md)."
done

# Subscription billing (docs/billing.md). FAIL CLOSED: in production billing is enforced unless BILLING_ENFORCED=false is
# set explicitly, because signup is public and anything else would hand every stranger a free number, agent and texts.
# So the operator must DECIDE: the variable must be present (true or false); an unset/typo value is refused here.
case "${BILLING_ENFORCED:-}" in
  true)
    for v in STRIPE_SECRET_KEY STRIPE_PRICE_ID STRIPE_BILLING_WEBHOOK_SECRET; do
      [[ -n "${!v:-}" ]] || die "${v} is unset in .env but BILLING_ENFORCED=true. See docs/billing.md."
    done
    echo "NOTE: BILLING_ENFORCED=true. Existing tenants must be comped first (bun scripts/grandfather-existing.ts --before <deploy time>, docs/billing.md step 5)."
    ;;
  false)
    echo "################################################################################" >&2
    echo "# WARNING: BILLING_ENFORCED=false. Texts and calls are NOT capped and tenants    #" >&2
    echo "# need no plan for them. Non-admin provisioning (number + agent) still requires  #" >&2
    echo "# an active plan. Do not run like this with open signup (docs/billing.md).       #" >&2
    echo "################################################################################" >&2
    ;;
  *)
    die "BILLING_ENFORCED is '${BILLING_ENFORCED:-}' (unset or invalid) in .env. Production fails closed: set BILLING_ENFORCED=true (with the Stripe keys; docs/billing.md) or, deliberately, BILLING_ENFORCED=false." ;;
esac
# Owner-phone grandfathering bypasses opt-outs and the country allow-list for unverified numbers: it needs an explicit acknowledgement.
if [[ "${OWNER_PHONE_GRANDFATHER:-}" == "true" ]]; then
  [[ "${OWNER_PHONE_GRANDFATHER_ACK:-}" == "i-understand" ]] \
    || die "OWNER_PHONE_GRANDFATHER=true needs OWNER_PHONE_GRANDFATHER_ACK=i-understand (and, strongly, OWNER_PHONE_GRANDFATHER_UNTIL / _BEFORE). Without the ack the app ignores it. See docs/runbook.md section 6."
  echo "WARNING: OWNER_PHONE_GRANDFATHER=true: unverified owner phones receive alerts that bypass opt-outs and the country allow-list. Turn it off once owners verified." >&2
fi
# Signup abuse control: the captcha waiver is allowed but loud.
if [[ "${SIGNUP_ALLOW_WITHOUT_CAPTCHA:-}" == "true" && ( -z "${TURNSTILE_SECRET_KEY:-}" || -z "${NEXT_PUBLIC_TURNSTILE_SITE_KEY:-}" ) ]]; then
  echo "################################################################################" >&2
  echo "# WARNING: SIGNUP_ALLOW_WITHOUT_CAPTCHA=true. Open signup has NO captcha: only   #" >&2
  echo "# rate limits and the platform cap stand between it and a bot farm. Configure    #" >&2
  echo "# Turnstile (TURNSTILE_SECRET_KEY + NEXT_PUBLIC_TURNSTILE_SITE_KEY) instead.     #" >&2
  echo "################################################################################" >&2
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
