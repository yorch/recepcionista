# Security headers and Content-Security-Policy

## Where the headers come from

| Header | Source | Notes |
| --- | --- | --- |
| `Content-Security-Policy` (pages) | `src/proxy.ts` via `src/lib/csp.ts` | per-request nonce, see below |
| `Content-Security-Policy` (`/api/*`) | `src/proxy.ts` | `default-src 'none'; frame-ancestors 'none'`: JSON never loads anything |
| `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy`, `Cross-Origin-Opener-Policy`, HSTS (production) | `next.config.ts` `headers()` | static, every path |
| `Referrer-Policy: no-referrer`, `Cache-Control: no-store` | `next.config.ts`, `/pay/*` only | the payment link must not leak through Referer |

`bun run verify:deploy` checks the headers on `/login` and `/pay/*` of a live deployment.

## The policy (strict, enforced by default)

```
default-src 'self'
script-src 'self' 'nonce-<per request>' 'strict-dynamic'          (+ 'unsafe-eval' in dev only)
style-src 'self' 'unsafe-inline'
img-src 'self' data: blob:        font-src 'self' data:        media-src 'self' blob:
connect-src 'self'                (+ ws: wss: in dev for HMR)
object-src 'none'  base-uri 'self'  form-action 'self'  frame-ancestors 'none'
upgrade-insecure-requests         (production + https origin only; CSP_UPGRADE_INSECURE overrides)
```

### How the nonce works in Next 16

1. `src/proxy.ts` mints a 128-bit nonce for every request and builds the policy (`cspHeadersFor`).
2. It puts the policy on the **forwarded request** headers. Next.js parses `'nonce-...'` out of the request's CSP while server
   rendering and stamps the nonce on its own inline bootstrap/RSC scripts and on the page's script tags. (The Next docs describe this
   in `node_modules/next/dist/docs/01-app/02-guides/content-security-policy.md`.) A client-sent `Content-Security-Policy` or
   `x-nonce` header is always overwritten.
3. It sets the same policy on the **response**.
4. The root layout awaits `connection()`, so every page is rendered per request. A prerendered page has no request and could not
   carry a nonce. Nothing in this app benefited from static prerendering (all authenticated or personalised pages were already
   dynamic; `/`, `/login`, `/signup`, `/verify-email-sent` were the only static ones and are tiny). `robots.txt` and `sitemap.xml`
   are route handlers and stay static; they carry no HTML.
5. `'strict-dynamic'` lets the nonced scripts load their chunks; host allow-lists and `'unsafe-inline'` are ignored by browsers
   that support it, so an injected `<script>` or `onerror=` handler without the nonce does not run.

Verified in Chromium against a production build (`next build && next start`): `/`, `/login`, `/signup`, `/forgot-password`, `/pay/*`,
`/dashboard`, `/dashboard/billing`, `/dashboard/knowledge`, `/dashboard/settings`, `/onboarding` rendered and hydrated with **zero**
`securitypolicyviolation` events or console errors, and the signup/login forms (client-side JS) worked.

## The 'unsafe-inline' trade-off (styles)

`script-src` has no `'unsafe-inline'`. `style-src` keeps it deliberately:

- React `style={{...}}` attributes (progress bars, waveforms) and styles injected at runtime by third-party UI (sonner toasts) cannot carry a nonce.
  Nonce-only styles would mean removing every `style=` attribute and forking the toast library.
- Inline CSS cannot run script. The residual risk is CSS-based data exfiltration or UI redress by an attacker who already has HTML
  injection; with `script-src` strict, `default-src`/`form-action`/`connect-src`/`img-src` limited to `'self'` and no framing, that is small.
- Revisit if the product starts rendering untrusted HTML.

## Rollout and rollback switches

| Variable | Effect |
| --- | --- |
| `CSP_REPORT_ONLY=true` | **Enforce the moderate policy** (`script-src 'self' 'unsafe-inline'`, no nonce) and only **report** violations of the strict one (`Content-Security-Policy-Report-Only`). Use it on a new deployment (new CDN, new embed, new third-party script) to see what the strict policy would break, then remove it. The request still carries the strict policy so Next keeps stamping nonces. |
| `CSP_REPORT_URI=https://collector.example/r` | Adds `report-uri` to the policy so browsers POST violations to a collector you operate (none is bundled). Without it, read violations in the browser console. |

Rollback in an incident is `CSP_REPORT_ONLY=true` plus a restart: pages keep working with the pre-nonce policy.

## Cloudflare Turnstile

When `NEXT_PUBLIC_TURNSTILE_SITE_KEY` (build time) or `TURNSTILE_SECRET_KEY` is set, the policy additionally allows exactly
`https://challenges.cloudflare.com` in `script-src` (the widget's `api.js`; under `'strict-dynamic'` it is loaded by the nonced app script and the
host entry only serves browsers without strict-dynamic support), in `connect-src`, and as the only `frame-src` (the challenge is an iframe). The same
holds for the moderate policy used by `CSP_REPORT_ONLY=true`. With Turnstile off none of this is added. A test covers both modes (`tests/csp.test.ts`) and the
widget was exercised in Chromium against a production build with Cloudflare's always-pass test site key `1x00000000000000000000AA`: zero CSP violations.

## Adding third-party scripts

Load them from a nonced script (`<Script nonce=...>` gets the nonce automatically) or a script that a nonced script injects
(`'strict-dynamic'` trusts it), and add the origin to `connect-src` / `img-src` only if it makes requests or loads images. Do not add
`'unsafe-inline'` to `script-src`; use `CSP_REPORT_ONLY` while testing.

## Known limits

- Dev (`next dev`) adds `'unsafe-eval'` for React's debugging; production never does.
- `upgrade-insecure-requests` is emitted only in production AND when the public origin (`APP_URL`, else `PUBLIC_BASE_URL`: `src/lib/base-url.ts`) is `https://`. It rewrites every `http://` subresource to `https://`, which breaks a plain-HTTP staging box (`ERR_SSL_PROTOCOL_ERROR` on each asset). `CSP_UPGRADE_INSECURE=true|false` forces it on/off (default: unset = automatic as above; production deploys through deploy.sh always have an https `APP_URL`, so it stays on there). Never in development.
- Responses produced by the proxy itself (the 401/403/503 JSON, the login redirect) do not carry the page CSP; they contain no HTML.
