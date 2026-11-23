# syntax=docker/dockerfile:1@sha256:572cebbc2b15e6f84c077742952674889cb63cd5e9b80abdffcbe587b6f19183
#
# Two runnable targets, one build:
#   runner — what serves traffic (slim, standalone, non-root)
#   tools  — migrations and seeding (full node_modules + prisma CLI + bun)
#
# `docker compose build` builds both; the shared deps/builder stages are cached
# once, so the second target costs only its final layer set.
#
# Base choice: the bun images are Debian-based (glibc), which is what keeps
# Prisma's native query engine from needing the musl workaround on alpine.

############### base ###############
# Digests are the multi-arch index digests, resolved 2026-11-23. Tags stay in
# the comments so Dependabot can bump both together.
# oven/bun:1.4.1
FROM oven/bun:1.4.1@sha256:9e123d5fc069e29d519fd4c981afb61b8542ac80274771961136db1e4538d53e AS base
WORKDIR /app

# Prisma's query engine links against openssl at runtime. ca-certificates is for
# the outbound calls to ElevenLabs/Twilio/Stripe/OpenAI.
#
# Versions are deliberately unpinned (hadolint DL3008): pinning openssl against a
# rolling base image guarantees a build failure the next time the base bumps,
# and these are patch-tracked security packages we want current, not frozen.
# hadolint ignore=DL3008
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ENV NEXT_TELEMETRY_DISABLED=1

############### deps ###############
FROM base AS deps

# `postinstall` runs `prisma generate`, so the schema must exist before install —
# otherwise the generate step has nothing to read and the client is never built.
COPY package.json bun.lock ./
COPY prisma ./prisma
RUN bun install --frozen-lockfile

############### builder ###############
FROM base AS builder

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# NEXT_PUBLIC_* values are inlined into the bundle at BUILD time (the .env file is not in the build context), so they
# arrive as build args from compose (app.build.args). Public values only: never put a secret in these.
ARG NEXT_PUBLIC_TURNSTILE_SITE_KEY=""
ARG NEXT_PUBLIC_PLAN_PRICE_DISPLAY=""
ENV NEXT_PUBLIC_TURNSTILE_SITE_KEY=$NEXT_PUBLIC_TURNSTILE_SITE_KEY \
    NEXT_PUBLIC_PLAN_PRICE_DISPLAY=$NEXT_PUBLIC_PLAN_PRICE_DISPLAY

# `next build` evaluates route modules, and several of them construct clients
# from their env at import time. The dummy URL satisfies that without a database
# ever being contacted — it is scoped to this RUN so it is not part of the image
# config, and nothing here is baked into the output.
RUN DATABASE_URL="postgresql://build:build@127.0.0.1:5432/build" \
    bun run build

############### tools ###############
# Migrations and the demo seed run as one-shot containers from this target.
# It deliberately keeps the full dependency tree (prisma CLI, bun for TS) and
# the app source, because `scripts/seed.ts` imports `src/lib/db` and the
# tsconfig `@/*` path alias that resolves it.
FROM base AS tools

ENV NODE_ENV=production

COPY --from=deps /app/node_modules ./node_modules
COPY package.json bun.lock tsconfig.json ./
COPY prisma ./prisma
COPY scripts ./scripts
COPY src ./src

# Run as an unprivileged uid, like the runner. The sources stay root-owned and
# read-only to this user. HOME points at /tmp because bunx and the Prisma CLI
# write caches under $HOME, and /tmp is writable by any user.
# oven/bun already ships a `bun` user at uid 1000, so the useradd fallback is
# normally skipped. It only matters if the base stops providing that uid.
ENV HOME=/tmp
RUN getent passwd 1000 >/dev/null || useradd --uid 1000 --no-create-home --shell /usr/sbin/nologin app
USER 1000:1000

# `prisma migrate deploy` — idempotent, applies only pending migrations.
CMD ["bunx", "prisma", "migrate", "deploy"]

############### runner ###############
# node:24-bookworm-slim
FROM node:24-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS runner

WORKDIR /app

# openssl: Prisma query engine. The rest of the image is distroless-ish by
# omission — no build toolchain, no bun, no dev dependencies.
# hadolint ignore=DL3008
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

# The standalone bundle carries its own traced node_modules and server.js.
# It does NOT include static assets or public/, which the Next docs expect to be
# copied alongside it.
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
COPY --from=builder --chown=node:node /app/public ./public

# Briefing audio is written at runtime (src/lib/briefing/tts.ts) and read back
# as the static path /audio/<file>.mp3. compose mounts a named volume here, and
# a fresh named volume inherits this directory's ownership from the image on
# first use — so it has to be node-writable before the volume exists.
RUN mkdir -p /app/public/audio && chown -R node:node /app/public/audio

# The node image's built-in user is uid 1000; compose's tmpfs entries spell out
# 1000 explicitly so both refer to the same principal (hadolint DL3066).
# hadolint ignore=DL3066
USER node

EXPOSE 3000

# Readiness, not liveness: /api/health returns 503 when Postgres is unreachable,
# which is the state Docker and Traefik should both back off from.
HEALTHCHECK --interval=15s --timeout=5s --start-period=40s --retries=5 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["node", "server.js"]
