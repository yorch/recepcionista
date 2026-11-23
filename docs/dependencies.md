# Dependency audit

Audit date: 2026-11-23. Scope: `package.json`, `bun.lock`, `.github/`, and the
source, scripts, tests and config files of this repo. Every "used" or "unused"
claim below comes from a repo-wide search for the package name (excluding
`node_modules`, `.next`, `bun.lock` and the review docs).

## Removed

| Package | Section | Evidence | Why removed |
| --- | --- | --- | --- |
| `lucide-react` | dependencies | No import anywhere. Icons are hand-drawn inline SVG. | Unused. Only the `package.json` line and review notes mention it. |
| `class-variance-authority` | dependencies | No import anywhere; no `cva` helper in the repo. | Unused. |
| `localtunnel` | devDependencies | No reference in code, scripts, Dockerfile, compose files or README. | Unused. The review notes called it a demo helper, but nothing invokes it. Dropping it also removes a large transitive tree. |

Removed with `bun remove lucide-react class-variance-authority localtunnel`.
The `bun.lock` diff for this step is deletion-only (43 lines).

## Config fix

- `ignoreScripts` (`sharp`, `unrs-resolver`) was removed from `package.json`.
  It is not a bun key, so it had no effect. Bun reads only `trustedDependencies`.
- `trustedDependencies` (`sharp`, `unrs-resolver`) is kept. Both packages are in
  `bun.lock`: `sharp` comes in as an optional dependency of `next`, and
  `unrs-resolver` as a dependency of `eslint-import-resolver-typescript`. Both
  have native or postinstall steps, which is why they are trusted.

## Kept (verified in use)

| Package | Where it is used |
| --- | --- |
| `next`, `react`, `react-dom` | App framework and UI (`src/app/**`, `src/components/**`) |
| `@prisma/client` | `src/lib/db/client.ts` and the rest of `src/lib/db/` |
| `prisma` (dev) | CLI, `postinstall` (`prisma generate`), `db:*` scripts |
| `cheerio` | `src/lib/extraction/index.ts` (server-side scrape) |
| `date-fns` | `src/lib/messaging/templates.ts` |
| `sonner` | Toasts in `src/components/dashboard/*.tsx`, `src/app/onboarding/page.tsx`, `src/app/layout.tsx` |
| `clsx`, `tailwind-merge` | `src/components/ui/cn.ts` |
| `tailwindcss` (dev) | `src/app/globals.css` (`@import "tailwindcss"`) |
| `@tailwindcss/turbopack` (dev) | `next.config.ts`, the `*.css` turbopack loader. It is referenced as a string, not imported, so a plain import grep misses it. |
| `eslint`, `eslint-config-next` (dev) | `eslint.config.mjs` |
| `typescript`, `@types/node`, `@types/react`, `@types/react-dom` (dev) | Compiler and type packages. Used by `tsc` and the editor, not imported. |

## Verification

- `npx tsc --noEmit`: exit 0.
- `DATABASE_URL=postgresql://x:x@localhost:5432/x ADMIN_TOKEN=x npx next build`:
  exit 0. Routes compiled as expected.
- `bun audit` ran with bun 1.4.4 (the repo pins 1.4.1).

## Known advisories (`bun audit`, 4 total: 3 high, 1 moderate)

All four are transitive, and none is a direct dependency.

| Package | Severity | Path | Advisory |
| --- | --- | --- | --- |
| `deepmerge-ts@7.1.5` | high | `prisma > @prisma/config > deepmerge-ts` | Stack exhaustion when merging recursive object graphs (<8.0.0). GHSA-ggr8-5vv4-36mx |
| `effect@3.16.12` | high | `prisma > @prisma/config > effect` | `AsyncLocalStorage` context contamination under concurrent RPC load (<3.20.0). GHSA-38f7-945m-qr2g |
| `effect@3.16.12` | high | `prisma > @prisma/config > effect` | ReDoS in `Schema.TemplateLiteral` (<=3.22.0). GHSA-7589-6fvf-x4pw |
| `minimatch@3.1.5`, `10.2.6` | moderate | `eslint > @eslint/eslintrc > minimatch`; `eslint-config-next > typescript-eslint > ... > minimatch` | Potential DoS via globparts amplification (>=7.0.0 <11.0.1). GHSA-g3hv-75wg-m249 |

Impact: the `prisma` path is the CLI config loader, which is a dev tool. It is
not in the `@prisma/client` runtime. The `eslint` path only runs at lint time.
The runtime exposure is low, but the advisories are real.

Recommended actions (not applied here, since they change `bun.lock` beyond
what this task allows):

1. Run `bun audit fix` in a dedicated PR. It updates the lock within the
   existing ranges. Then re-run `bun audit`.
2. Check whether a newer `prisma` / `@prisma/config` release pulls in a fixed
   `effect` and `deepmerge-ts`. `prisma` is pinned at `6.16.2`, so bump it
   deliberately and re-run the migrate and generate steps.
3. The `minimatch` items come from ESLint. A newer `eslint` or
   `typescript-eslint` will usually resolve them.

## Licenses

- **No `LICENSE` file exists in this repo.** It is not created here, since the
  owner decides the license. Without one, the code defaults to all rights
  reserved. `package.json` is `"private": true` and has no `license` field.
- Inventory: 421 installed packages, from each package's `license` field
  (script: `node_modules` walk, kept in the scratchpad, not added as a dependency).
  - Permissive (MIT, Apache-2.0, BSD-2/3-Clause, ISC, 0BSD, BlueOak-1.0.0,
    Python-2.0, CC0/CC-BY-4.0 data): the large majority.
  - No GPL, AGPL or SSPL packages found.
- Copyleft-type licenses to note:
  - **LGPL-3.0-or-later**: `@img/sharp-libvips-linux-x64` and
    `@img/sharp-libvips-linuxmusl-x64` (native libvips, via `sharp`, which
    `next` uses for image optimization). The standalone Docker image may ship
    these. Dynamic linking is normal, but if the image is distributed, keep the
    LGPL notice and source offer in mind. Not verified against the actual image.
  - **MPL-2.0** (file-level copyleft, permissive for application code):
    `lightningcss` (build-time CSS, via Next and Tailwind) and `axe-core`
    (via `eslint-plugin-jsx-a11y`, dev only). No action needed for normal use.

## Dependabot (`.github/dependabot.yml`)

- Added the `docker-compose` ecosystem for `compose.production.yaml` and
  `compose.dev.yaml`, so the postgres digest gets bump PRs.
- Minor and patch updates are grouped per ecosystem (`docker`,
  `docker-compose`, `github-actions`, `npm`).
- Not verified: whether Dependabot's `docker-compose` ecosystem matches the
  non-standard file names `compose.production.yaml` and `compose.dev.yaml`. The
  first run will show it. If it finds nothing, rename the files to
  `compose.yaml` or bump the digests by hand.

## GitHub Actions pins (`.github/workflows/ci.yml`)

| Action | Tag | Pinned SHA |
| --- | --- | --- |
| `actions/checkout` | `v4` -> `v4.4.0` | `11d5960a326750d5838078e36cf38b85af677262` |
| `oven-sh/setup-bun` | `v2` -> `v2.2.0` | `0c5077e51419868618aeaa5fe8019c62421857d6` |

Both SHAs were read from the public repos with `git ls-remote --tags`. Both
are lightweight tags, so the SHAs are commits, not tag objects. The GitHub
MCP server is scoped to `yorch/recepcionista` only, so it could not resolve
them. Dependabot's `github-actions` ecosystem will keep them current.
