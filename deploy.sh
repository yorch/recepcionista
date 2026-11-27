#!/usr/bin/env bash
#
# Deploy recepcionista to a host running Traefik.
#
#   ./deploy.sh                                   build, back up the DB, migrate, (re)start
#   ./deploy.sh --logs                            follow the app logs after starting
#
# Safe to re-run: migrations are idempotent and `up -d` recreates only what
# changed. Before `up -d`, if the database container is running, a gzipped
# pg_dump is written to $BACKUP_DIR (default ./backups). There is no --seed:
# the demo dataset truncates every table and creates a fake live tenant, so
# it is refused here (use the development compose file for demo data).
set -Eeuo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

COMPOSE=(docker compose -f compose.production.yaml)
FOLLOW_LOGS=0
BACKUP_DIR="${BACKUP_DIR:-./backups}"

for arg in "$@"; do
  case "$arg" in
    --seed|--i-know-this-wipes-data) echo "ERROR: $arg is refused: this script only deploys production, and the demo dataset wipes every table and creates a fake live tenant. Use compose.dev.yaml for demo data." >&2; exit 2 ;;
    --logs) FOLLOW_LOGS=1 ;;
    -h|--help) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $arg (try --help)" >&2; exit 2 ;;
  esac
done

die() { echo "ERROR: $*" >&2; exit 1; }

# Settings the admin console can hold in the DATABASE (docs/design/admin-console-contracts.md): an operator who followed the "move to console" wizard deleted those
# lines from .env on purpose. A missing .env line for one of them is therefore a WARNING here, remembered in DEFERRED, and re-checked AFTER the stack is up against what the
# server really holds (GET /api/admin/selftest + /api/admin/settings, from inside the app container): still missing in the console as well -> the deploy fails then.
# Genuinely env-only keys (DOMAIN, APP_URL, POSTGRES_PASSWORD, ADMIN_TOKEN, APP_SECRET_KEY(_PREVIOUS), the dev/demo switches, malformed values) stay hard failures.
# defer "<ENV NAME or description>" "<tokens>": tokens are comma separated (ALL needed); a token is a registry key, `a/b` (ANY of), or @llm / @email / @billing / @captcha.
DEFERRED=()
defer() {
  echo "WARNING: $1 is not set in .env. Fine if the admin console holds it (checked after the stack is up); otherwise the deploy fails at that check." >&2
  DEFERRED+=("$1=$2")
}

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
# Without the Stripe secret the webhook can be driven by anyone who finds the URL (console-held: re-checked after the stack is up).
[[ -n "${STRIPE_WEBHOOK_SECRET:-}" ]] \
  || defer "STRIPE_WEBHOOK_SECRET (Stripe dashboard > Webhooks > signing secret)" "stripe.webhook_secret"
[[ -n "${ADMIN_TOKEN:-}" ]] \
  || die "ADMIN_TOKEN is unset in .env. Required in production: openssl rand -hex 32"

# LLM: REQUIRED in production (owner decision). Website import fails without it, and call summaries / briefing narration would silently fall back to
# templates. The app health check also reports 503 `llm_not_configured`, so a deploy without a key would never become healthy.
[[ -n "${OPENAI_API_KEY:-}" || -n "${ANTHROPIC_API_KEY:-}" ]] \
  || defer "OPENAI_API_KEY or ANTHROPIC_API_KEY (an LLM is required in production: website import, call summaries and briefings)" "@llm"
# Voice/SMS providers: in production the app fails closed without these, so a
# missing secret would deploy "successfully" and then reject every live call.
if [[ -n "${ELEVENLABS_API_KEY:-}" ]]; then
  [[ -n "${ELEVENLABS_TOOL_SECRET:-}" ]] \
    || defer "ELEVENLABS_TOOL_SECRET (ELEVENLABS_API_KEY is set: every voice tool call would 401; openssl rand -hex 32)" "elevenlabs.tool_secret"
  [[ -n "${ELEVENLABS_WEBHOOK_SECRET:-}" ]] \
    || defer "ELEVENLABS_WEBHOOK_SECRET (ELEVENLABS_API_KEY is set: post-call webhooks would 401; see README)" "elevenlabs.webhook_secret"
fi
if [[ -n "${TWILIO_ACCOUNT_SID:-}" && -n "${TWILIO_AUTH_TOKEN:-}" && -n "${TWILIO_PHONE_NUMBER:-}" && -z "${ELEVENLABS_API_KEY:-}" ]]; then
  defer "ELEVENLABS_API_KEY (Twilio is configured: provisioning refuses with 503 voice_provider_not_configured because a purchased number would have no voice agent)" "elevenlabs.api_key"
fi
if [[ -n "${TWILIO_ACCOUNT_SID:-}" && -z "${TWILIO_AUTH_TOKEN:-}" ]]; then
  defer "TWILIO_AUTH_TOKEN (TWILIO_ACCOUNT_SID is set)" "twilio.auth_token"
fi

# Account lifecycle (docs/env-vars.md). Without these the deploy "works" and then every signup, password reset and 2FA enrolment
# fails closed in production, so refuse here instead.
if [[ -z "${APP_SECRET_KEY:-}" ]]; then
  die "APP_SECRET_KEY is unset in .env. Required in production (encrypts 2FA secrets): openssl rand -base64 32"
fi
[[ "$(printf '%s' "$APP_SECRET_KEY" | base64 -d 2>/dev/null | wc -c | tr -d ' ')" == "32" ]] \
  || die "APP_SECRET_KEY must be 32 random bytes, base64 encoded (openssl rand -base64 32)"
# Rotation (docs/runbook.md "Admin console operations"): the decrypt-only previous master key must be a valid key too, and a different one.
if [[ -n "${APP_SECRET_KEY_PREVIOUS:-}" ]]; then
  [[ "$(printf '%s' "$APP_SECRET_KEY_PREVIOUS" | base64 -d 2>/dev/null | wc -c | tr -d ' ')" == "32" ]] \
    || die "APP_SECRET_KEY_PREVIOUS must be 32 random bytes, base64 encoded (the key you are rotating AWAY from)"
  [[ "$APP_SECRET_KEY_PREVIOUS" != "$APP_SECRET_KEY" ]] || die "APP_SECRET_KEY_PREVIOUS equals APP_SECRET_KEY: remove it (no rotation in progress)"
fi
case "${EMAIL_PROVIDER:-}" in
  resend)
    [[ -n "${RESEND_API_KEY:-}" ]] || defer "RESEND_API_KEY (EMAIL_PROVIDER=resend)" "email.resend_api_key" ;;
  smtp)
    [[ -n "${SMTP_URL:-}" || -n "${SMTP_HOST:-}" ]] || defer "SMTP_URL or SMTP_HOST (EMAIL_PROVIDER=smtp)" "email.smtp_url/email.smtp_host" ;;
  "")
    defer "EMAIL_PROVIDER (verification and reset emails depend on a working provider)" "@email" ;;
  *)
    die "EMAIL_PROVIDER must be 'resend' or 'smtp' in production (got '${EMAIL_PROVIDER:-}'); 'log' is refused. Verification and reset emails depend on it." ;;
esac
[[ -n "${EMAIL_FROM:-}" ]] || defer "EMAIL_FROM (e.g. 'Recepcionista <no-reply@${DOMAIN}>')" "email.from"
# Google Calendar (docs/integrations/google-calendar.md): all-or-nothing, only when the OAuth client id is set.
if [[ -n "${GOOGLE_CLIENT_ID:-}" ]]; then
  [[ -n "${GOOGLE_CLIENT_SECRET:-}" ]] || defer "GOOGLE_CLIENT_SECRET (GOOGLE_CLIENT_ID is set)" "google.client_secret"
  [[ "${APP_URL:-}" == https://* ]] || die "Google Calendar needs APP_URL=https://... (OAuth redirect + push notifications are https only)"
fi
[[ "${GOOGLE_OAUTH_MOCK:-}" != "true" ]] || die "GOOGLE_OAUTH_MOCK=true is for local development only; remove it from the production .env"
# Signup abuse control: the Turnstile site key (public) and secret (server) only work as a pair. Both are runtime settings (the .env file or the admin console): no rebuild is needed to change them.
if [[ -n "${NEXT_PUBLIC_TURNSTILE_SITE_KEY:-}" && -z "${TURNSTILE_SECRET_KEY:-}" ]]; then
  defer "TURNSTILE_SECRET_KEY (NEXT_PUBLIC_TURNSTILE_SITE_KEY is set: the widget would render but nothing would verify it)" "signup.turnstile_secret_key"
fi
if [[ -n "${TURNSTILE_SECRET_KEY:-}" && -z "${NEXT_PUBLIC_TURNSTILE_SITE_KEY:-}" ]]; then
  defer "NEXT_PUBLIC_TURNSTILE_SITE_KEY (TURNSTILE_SECRET_KEY is set: every signup would fail closed, no token)" "signup.turnstile_site_key"
fi
# Open signup REQUIRES a captcha in production (owner decision): the full Turnstile pair, or the explicit, loud opt-out
# SIGNUP_ALLOW_WITHOUT_CAPTCHA=true. Without either the app refuses public signup (503 signup_disabled; invites still work),
# so a deploy that would silently ship a dead /signup is refused here instead.
if [[ -z "${TURNSTILE_SECRET_KEY:-}" || -z "${NEXT_PUBLIC_TURNSTILE_SITE_KEY:-}" ]]; then
  case "${SIGNUP_ALLOW_WITHOUT_CAPTCHA:-}" in
    true) ;;
    *) defer "TURNSTILE_SECRET_KEY + NEXT_PUBLIC_TURNSTILE_SITE_KEY (open signup needs Turnstile in production, or the loud opt-out SIGNUP_ALLOW_WITHOUT_CAPTCHA=true; without either /api/auth/signup answers 503 signup_disabled, docs/auth.md)" "@captcha" ;;
  esac
fi
# Dev/demo switches must never reach production.
for v in DEMO_MODE ALLOW_INSECURE_DEV STRIPE_ALLOW_UNSIGNED; do
  [[ "${!v:-}" != "true" ]] || die "${v}=true in .env: never enable it on a production host (docs/runbook.md)."
done

# Optional annual plan: the price id must look like a Stripe price, and needs the Stripe key to be offered at all.
if [[ -n "${STRIPE_PRICE_ID_ANNUAL:-}" ]]; then
  [[ "${STRIPE_PRICE_ID_ANNUAL}" =~ ^price_[A-Za-z0-9]+$ ]] || die "STRIPE_PRICE_ID_ANNUAL is not a Stripe price id (price_...). See docs/billing.md."
  [[ -n "${STRIPE_SECRET_KEY:-}" ]] || defer "STRIPE_SECRET_KEY (STRIPE_PRICE_ID_ANNUAL is set: the annual plan could never be offered)" "stripe.secret_key"
fi

# Subscription billing (docs/billing.md). FAIL CLOSED: in production billing is enforced unless BILLING_ENFORCED=false is
# set explicitly, because signup is public and anything else would hand every stranger a free number, agent and texts.
# So the operator must DECIDE: the variable must be present (true or false); an unset/typo value is refused here.
case "${BILLING_ENFORCED:-}" in
  true)
    for pair in STRIPE_SECRET_KEY:stripe.secret_key STRIPE_PRICE_ID:stripe.price_id STRIPE_BILLING_WEBHOOK_SECRET:stripe.billing_webhook_secret; do
      envname="${pair%%:*}"
      [[ -n "${!envname:-}" ]] || defer "${envname} (BILLING_ENFORCED=true, docs/billing.md)" "${pair#*:}"
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
  "")
    defer "BILLING_ENFORCED (production fails closed; set true with the Stripe keys, docs/billing.md, or deliberately false: decide it in .env or in the console)" "@billing" ;;
  *)
    die "BILLING_ENFORCED is '${BILLING_ENFORCED}' (invalid) in .env. Production fails closed: set BILLING_ENFORCED=true (with the Stripe keys; docs/billing.md) or, deliberately, BILLING_ENFORCED=false." ;;
esac
# Owner-phone grandfathering bypasses opt-outs and the country allow-list for unverified numbers: it needs an explicit acknowledgement.
if [[ "${OWNER_PHONE_GRANDFATHER:-}" == "true" ]]; then
  [[ "${OWNER_PHONE_GRANDFATHER_ACK:-}" == "i-understand" ]] \
    || die "OWNER_PHONE_GRANDFATHER=true needs OWNER_PHONE_GRANDFATHER_ACK=i-understand (and, strongly, OWNER_PHONE_GRANDFATHER_UNTIL / _BEFORE). Without the ack the app ignores it. See docs/runbook.md section 6."
  echo "WARNING: OWNER_PHONE_GRANDFATHER=true: unverified owner phones receive alerts that bypass opt-outs and the country allow-list. Turn it off once owners verified." >&2
fi
# Background jobs (docs/runbook.md "Background jobs"): JOBS takes the same values the app accepts (on/true/1/yes, off/false/0/no, or
# empty = on in production); anything else is refused instead of silently running the default. Off is allowed but loud: no daily
# briefing, no gratitude sweep, no cleanup, no retention purge.
jobs_value="$(printf '%s' "${JOBS:-}" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')"
case "${jobs_value}" in
  ""|on|true|1|yes|off|false|0|no) ;;
  *) die "JOBS is '${JOBS}' in .env: use on or off (also accepted: true/false, 1/0, yes/no; empty = on in production)." ;;
esac
case "${jobs_value}" in
  off|false|0|no)
    echo "WARNING: JOBS=${JOBS}. The 6 PM daily briefing, the hourly gratitude sweep, the expired-row cleanup and the retention purge will NOT run (docs/runbook.md)." >&2 ;;
esac
for v in JOBS_TICK_SECONDS TRIAL_SMS_CAP TRIAL_CALL_MINUTES_CAP OWNER_ALERT_HOURLY_LIMIT FORWARD_MAX_CALL_SECONDS FORWARD_CALLS_PER_HOUR VOICEMAIL_PER_HOUR \
  VOICEMAIL_MINUTES_CAP FORWARD_MINUTES_CAP TRIAL_FORWARD_MINUTES_CAP FORWARD_MAX_CONCURRENT FORWARD_PER_CALLER_PER_HOUR VOICEMAIL_PER_CALLER_PER_HOUR \
  FORWARD_WITHHELD_PER_HOUR VOICEMAIL_WITHHELD_PER_HOUR CALLER_UNKNOWN_SHARE_PCT FORWARD_MIN_ANSWERED_SECONDS FORWARD_RING_SECONDS; do
  [[ -z "${!v:-}" || "${!v}" =~ ^[0-9]+$ ]] || die "${v} is '${!v}' in .env: it must be a whole number (docs/env-vars.md)."
done
# Call handling (docs/runbook.md section 8): the line kind decides whether Forward exists at all; the deny list is 3-digit NANP area codes.
case "${VOICE_LINE_KIND:-}" in
  ""|native|webhook) ;;
  *) die "VOICE_LINE_KIND is '${VOICE_LINE_KIND}' in .env: use native (number imported into ElevenLabs) or webhook (Voice URL is /api/voice/incoming), or leave it empty." ;;
esac
# Round 6 L5: webhook against a native ElevenLabs number would only make the dashboard promise forwarding that never happens. The app
# treats the line as native (the safe reading) and logs/diagnoses it; say so here too.
if [[ "${VOICE_LINE_KIND:-}" == "webhook" && -n "${ELEVENLABS_API_KEY:-}" && -n "${ELEVENLABS_PHONE_NUMBER_ID:-}" ]]; then
  echo "WARNING: VOICE_LINE_KIND=webhook, but ELEVENLABS_PHONE_NUMBER_ID is set: that number is answered by ElevenLabs, which can never forward a call. The app will treat the line as NATIVE (forwarding NOT available). Unset VOICE_LINE_KIND, or remove the ElevenLabs phone number settings if this deployment really answers on a Twilio Voice URL (docs/runbook.md section 8)." >&2
fi
# Round 6: percentages and the ring time have a range (the app falls back to the default outside it; failing here is kinder than a silent default).
if [[ -n "${CALLER_UNKNOWN_SHARE_PCT:-}" ]] && (( CALLER_UNKNOWN_SHARE_PCT < 1 || CALLER_UNKNOWN_SHARE_PCT > 100 )); then
  die "CALLER_UNKNOWN_SHARE_PCT is '${CALLER_UNKNOWN_SHARE_PCT}' in .env: use a whole number from 1 to 100 (docs/env-vars.md)."
fi
if [[ -n "${FORWARD_RING_SECONDS:-}" ]] && (( FORWARD_RING_SECONDS < 10 || FORWARD_RING_SECONDS > 40 )); then
  die "FORWARD_RING_SECONDS is '${FORWARD_RING_SECONDS}' in .env: use a whole number from 10 to 40 (docs/env-vars.md)."
fi
# Phase 2 telephony switches (docs/env-vars.md).
for v in NATIVE_TRANSFER STIR_TRUST LANGUAGE_DETECTION; do
  case "${!v:-}" in "" | on | off) ;; *) die "$v is '${!v}' in .env: use on or off, or leave it empty (docs/env-vars.md)." ;; esac
done
if [[ "${NATIVE_TRANSFER:-}" == "on" && "${VOICE_LINE_KIND:-}" != "native" && ( -z "${ELEVENLABS_API_KEY:-}" || "${ELEVENLABS_TENANT_LINES:-}" == "off" && -z "${ELEVENLABS_PHONE_NUMBER_ID:-}" ) ]]; then
  echo "WARNING: NATIVE_TRANSFER=on only matters on a native ElevenLabs line (ELEVENLABS_API_KEY; each tenant's number is imported, or ELEVENLABS_PHONE_NUMBER_ID with ELEVENLABS_TENANT_LINES=off); here it has no effect. Each business also has to opt in under Settings. Run the live transfer test first (docs/runbook.md section 8)." >&2
fi
if [[ "${NATIVE_TRANSFER:-}" == "on" && -z "${ELEVENLABS_TOOL_SECRET:-}" ]]; then
  die "NATIVE_TRANSFER=on needs ELEVENLABS_TOOL_SECRET (the per-call transfer destination travels through the authenticated initiation webhook)."
fi
for v in LIVE_MAX_PER_USER LIVE_MAX_PER_BUSINESS LIVE_MAX_POLLS_PER_CALL RECONCILE_AFTER_MINUTES RECONCILE_MAX_ATTEMPTS; do
  if [[ -n "${!v:-}" ]] && ! [[ "${!v}" =~ ^[1-9][0-9]*$ ]]; then die "$v is '${!v}' in .env: use a whole number of at least 1 (docs/env-vars.md)."; fi
done
if [[ -n "${FORWARD_DENY_AREA_CODES:-}" ]]; then
  IFS=',' read -ra _deny_codes <<< "${FORWARD_DENY_AREA_CODES}"
  for c in "${_deny_codes[@]}"; do
    c="${c//[[:space:]]/}"
    [[ "${c}" =~ ^[2-9][0-9]{2}$ ]] || die "FORWARD_DENY_AREA_CODES has '${c}' in .env: use comma separated 3-digit NANP area codes such as 305,212 (docs/env-vars.md)."
  done
fi
# Default area code for newly bought numbers (a business's own owner-phone area code wins): three digits, first 2-9.
[[ -z "${TWILIO_AREA_CODE:-}" || "${TWILIO_AREA_CODE}" =~ ^[2-9][0-9]{2}$ ]] \
  || die "TWILIO_AREA_CODE is '${TWILIO_AREA_CODE}' in .env: it must be a 3-digit US/Canada area code such as 305 (docs/env-vars.md). Unset it to use 305."
# Phone numbers: in production a failed purchase FAILS provisioning (no fake number is ever issued), so Twilio must be complete.
if [[ -z "${TWILIO_ACCOUNT_SID:-}" || -z "${TWILIO_AUTH_TOKEN:-}" || -z "${TWILIO_PHONE_NUMBER:-}" ]]; then
  echo "WARNING: Twilio is not fully configured (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_PHONE_NUMBER). Provisioning a business will answer 503 phone_provider_not_configured: production never hands out a mock number (docs/runbook.md)." >&2
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

# ---- console-held settings the .env no longer carries ---------------------
# Asks the RUNNING server what it holds (read-only, from inside the container: no DNS or proxy involved; the Bearer ADMIN_TOKEN use is audited and mailed like any other).
if (( ${#DEFERRED[@]} > 0 )); then
  echo
  echo "Verifying ${#DEFERRED[@]} setting(s) that are not in .env are held by the admin console…"
  VERIFY_JS='
const specs = (process.env.RC_SPECS || "").split("\n").filter(Boolean);
const base = "http://127.0.0.1:" + (process.env.PORT || 3000);
const h = { authorization: "Bearer " + process.env.ADMIN_TOKEN };
const get = async (p) => { const r = await fetch(base + p, { headers: h }); if (!r.ok) throw new Error(p + " answered " + r.status); return (await r.json()).data; };
(async () => {
  const [self, all] = await Promise.all([get("/api/admin/selftest"), get("/api/admin/settings")]);
  const byKey = new Map(all.settings.map((s) => [s.key, s]));
  const isSet = (k) => { const s = byKey.get(k); return Boolean(s) && (s.kind === "secret" ? Boolean(s.secret && s.secret.set) : s.source !== "default" && s.value !== null && s.value !== ""); };
  const card = (n) => (self.providers.find((p) => p.provider === n) || {}).ready === true;
  const enforced = byKey.get("billing.enforced");
  const tokenOk = (t) => {
    if (t === "@llm") return card("llm");
    if (t === "@email") return card("email");
    if (t === "@captcha") return process.env.SIGNUP_ALLOW_WITHOUT_CAPTCHA === "true" || (isSet("signup.turnstile_secret_key") && isSet("signup.turnstile_site_key"));
    if (t === "@billing") {
      if (!enforced || enforced.source === "default") return false;
      return enforced.value !== true || ["stripe.secret_key", "stripe.price_id", "stripe.billing_webhook_secret"].every(isSet);
    }
    return t.split("/").some(isSet);
  };
  let bad = 0;
  for (const spec of specs) {
    const i = spec.lastIndexOf("=");
    const label = spec.slice(0, i), tokens = spec.slice(i + 1).split(",");
    if (!tokens.every(tokenOk)) { bad++; console.log("MISSING " + label); }
  }
  process.exit(bad ? 3 : 0);
})().catch((e) => { console.log("UNVERIFIED " + e.message); process.exit(4); });
'
  SPECS="$(printf '%s\n' "${DEFERRED[@]}")"
  set +e
  VERIFY_OUT="$("${COMPOSE[@]}" exec -T -e RC_SPECS="$SPECS" -e SIGNUP_ALLOW_WITHOUT_CAPTCHA="${SIGNUP_ALLOW_WITHOUT_CAPTCHA:-}" app node -e "$VERIFY_JS" 2>&1)"
  VERIFY_RC=$?
  set -e
  if [[ "$VERIFY_RC" == "0" ]]; then
    echo "OK: every setting missing from .env is held by the admin console."
  else
    printf '%s\n' "$VERIFY_OUT" >&2
    if [[ "$VERIFY_RC" == "3" ]]; then
      die "the stack is up but the settings listed above are in NEITHER .env NOR the admin console (the lines say what each one breaks). Set them in .env and re-run ./deploy.sh, or in the console (Settings, then Providers)."
    fi
    die "the stack is up but the console-held settings could not be verified (see above): check /api/admin/selftest by hand before sending traffic."
  fi
fi

"${COMPOSE[@]}" ps

if [[ "$FOLLOW_LOGS" == "1" ]]; then
  "${COMPOSE[@]}" logs -f app
fi
