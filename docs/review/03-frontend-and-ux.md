# 03 - Frontend and UX review

Scope: src/app pages/layouts/css, /pay, onboarding, dashboard, src/components, next.config.ts, eslint, tsconfig, package.json.
Caveat: `node_modules` is not installed, so `node_modules/next/dist/docs/` could not be read. Next API usage (async `params`/`searchParams`, `force-dynamic`, `next/font/google`, `logging`/`allowedDevOrigins` config) was judged from the code only. I saw nothing that looked wrong for Next 15/16, but not verified against the docs. package.json pins `next 16.4.6`, `react 19.3.0`, `tailwindcss 4.3.3`, `lucide-react ^1.73`, `bun 1.4.1` and `@tailwindcss/turbopack 4.3.3`. I could not confirm these exist; check `bun install` resolves.

## Summary
The UI is tidy and demo-polished. It is not a product yet. The dashboard has no authentication and always shows `businesses[0]`, so after onboarding a second business the owner sees someone else's data. The mock checkout is theatre: it never records payment and always shows $189. Onboarding hard-codes demo values (phone, hours, greeting, voice line). Colors are hard-coded hex everywhere instead of the tokens defined in globals.css.

## High

1. **Dashboard has no auth and is single-tenant by accident.**
   `src/app/dashboard/layout.tsx:8-10` and every dashboard page (`dashboard/page.tsx:13`, `calls/page.tsx:12`, `bookings/page.tsx:9`, `briefings/page.tsx:10`, `knowledge/page.tsx:10`, `demo/page.tsx:9`) use `(await listBusinesses())[0]`. No session, cookie, middleware or `proxy.ts` exists (`ls src` shows none).
   Impact: anyone with the URL sees every call transcript, caller phone number, address and briefing for the oldest business. Client components also receive `businessId` and call mutating APIs (`/api/briefings/generate`, `/api/businesses/:id/knowledge`, `/api/demo/reset`). Reset is exposed in the production UI.
   Fix: add real auth (even a signed-cookie owner login created at onboarding), scope queries by the session's business id, and gate or remove `/dashboard/demo` and `/api/demo/*` in production.

2. **Onboarding "Add another" and the landing page leak and mix tenants.**
   `onboarding/page.tsx:287` offers "Add another", but the dashboard only ever renders the first business. `src/app/page.tsx:8-13` is a public page that renders live call/booking/deposit counts for `businesses[0]` (aggregate only, but still real customer data on an unauthenticated route).
   Fix: after auth, remove or scope the landing stats. Use seeded demo data explicitly, not "first row".

3. **Mock payment page never records payment and ignores the real amount.**
   `src/lib/providers/stripe.ts:21,50` build `${appUrl()}/pay/mock_xxx` with no query string. A repo-wide grep finds nothing that appends `?amount=`, `for=` or `business=`. `pay/[id]/page.tsx:36-47` therefore always falls back to $189, "Emergency service deposit" and "Miami Cool Air Conditioning", whatever was booked. `checkout.tsx:28-33` only sets a timeout and flips local state, with no request to the server. `deposit_paid` is only set by the Stripe webhook (`webhook/route.ts:72`), so in mock mode the dashboard's "Deposits" stat never moves from a payment, and the "Payment received... We texted you the details" claim (`received.tsx:27`) is false.
   Fix: look up the payment link/booking server-side by id (persist it in `createPaymentLink`), render amount and label from the DB, and have the mock "Pay" call a server action or API route that marks the booking `deposit_paid`.

4. **Pay page trusts the URL for everything it displays (amount tampering and spoofing).**
   `pay/[id]/page.tsx:36-47`: `amount`, `for` and `business` come straight from the query string. Anyone can craft `/pay/x?amount=1&business=Chase%20Bank&for=Account%20verification`, a convincing phishing page on your domain that collects card-shaped input (`checkout.tsx` fields are real inputs with `autoComplete=cc-*`). It is mock today, but the same code path is reachable in production because `appUrl()` fallback is a mock whenever Stripe is unset or fails (`stripe.ts:47-50`). The same mock fallback means a Stripe outage silently sends customers to a fake checkout.
   XSS: React escapes the values, so no XSS found. Data leak via guessable ID: none. The id is only echoed back, and the page reads no DB. IDs are `Math.random().toString(36)` (`stripe.ts:20`), weak but unused for authorization.
   Fix: server-side lookup by an unguessable id (crypto.randomUUID); ignore query params; disable the mock page when `NODE_ENV=production`; fail visibly (not silently to mock) on Stripe errors.

5. **Prefilled test card and "Test mode" shown to real customers.**
   `checkout.tsx:20-23` default state is `4242 4242 4242 4242 / 12 / 29 / 123 / 33131`. Combined with item 3 this leaves a deposit that looks paid and is not collected. Fix: empty defaults, and only render this page in demo mode.

## Medium

6. **Onboarding hard-codes demo values into a "real" flow.**
   - `onboarding/page.tsx:30-31`: owner name defaults to "Jorge", phone to `+13055550199`. A user who does not edit them gets briefings sent to a fake number.
   - `:24,266-269`: `VOICE_LINE = '+12028972767'` is shown as "Your AI front desk" instead of the provisioned `phone` (the `||` chain makes `phone` unreachable).
   - `:239-241`: hours are literal text ("Mon-Fri 8-6..."), not the extracted `ex.hours`.
   - `:280`: greeting hard-codes "le habla Maria" and Spanish, regardless of `kb`.
   - `:234`: falls back to 'Miami-Dade'.
   - `:112`: "Step 1/2/3 of 3" is not tied to real stages.
   - `:252`: "This provisions a real phone number" even in mock mode (the API returns `mock`, ignored).
   The review step says "Fix anything below" (`:205`) but nothing is editable. Fix: use extracted/provisioned data, make fields editable (name, hours, services), show the mock flag, validate owner phone as E.164.

7. **Onboarding flow has no recovery or loading guard.**
   `start()` (`:39-84`) creates a Business before `/api/extract`; if extraction fails the user returns to `input` and a retry creates another orphan business ("New business", `:59`) that then becomes `businesses[0]`-adjacent clutter. `onKeyDown` Enter can fire `start()` twice (no re-entrancy guard besides stage change after the first await path). `goLive` has no timeout; a hung provision leaves the spinner indefinitely. Labels (`:125,141,149`) are not associated with inputs (no `htmlFor`/`id`) and the form is not a `<form>`.
   Fix: wrap in a `<form onSubmit>`, associate labels, create the business only after extract succeeds (or reuse the id on retry), add an error panel rather than only a toast.

8. **No `loading.tsx` / `error.tsx` / `not-found.tsx` anywhere** (`git ls-files src/app` shows none). Every dashboard page is `force-dynamic` with 3-4 sequential awaits (`dashboard/page.tsx:16-19`: calls, bookings, briefing, sms awaited serially). A DB error shows Next's generic error page; a slow DB blocks navigation with no feedback.
   Fix: `Promise.all`, add `loading.tsx` skeletons and an `error.tsx` boundary under `dashboard/`.

9. **Time/timezone bugs on the Today page.**
   `dashboard/page.tsx:23` computes "today" as UTC (`toISOString().slice(0,10)`) and compares to `started_at.slice(0,10)`, while all display uses America/New_York. Between 7-8 PM ET and midnight "Calls today" resets to 0 and tomorrow's bookings are labelled today. `:31` `now.getHours()` uses the server's local zone (UTC in the container), so the greeting ("Buenas noches") is wrong for the owner. `bookings/page.tsx:15,21` has the same UTC grouping, then renders `dayET(`${key}T12:00:00`)`. Fix: derive the ET day key with `Intl` (`en-CA`, as `format.ts:whenET` already does) and take hours from ET. Also store a business timezone instead of the hard-coded `TZ`.

10. **Stats are mislabelled.** `dashboard/page.tsx:54` "bilingual" counts all calls ever, not today's. Landing page `page.tsx:88` "en espanol" counts `mixed` too. `page.tsx:97` "Owner briefing: 0/1" and `:98` "1 item needs you" (hard-coded singular).

11. **Phone number display inconsistency / env bug.**
   `shell.tsx:31-35` is a client component reading `process.env.NEXT_PUBLIC_ELEVENLABS_PHONE_NUMBER`, while every other page reads the non-public `ELEVENLABS_PHONE_NUMBER` (server only). Neither `NEXT_PUBLIC_` var is in `.env.example` (grep). Inlined at build time, so in the Docker standalone build the sidebar shows `phone` or a dash while the Today page shows the real number. Also, the env var (shared demo line) takes priority over `biz.phone` everywhere, so a freshly provisioned business displays the demo number, not its own. Fix: pass the number from the server layout as a prop; prefer `biz.phone`.
   Also `tel:` with an empty value renders `<a href="tel:">` (`page.tsx:74`, labelled "Call her").

12. **Hydration/consistency risk in `VoicePlayer`.** `ui/audio.tsx:57-60` uses `Math.sin` for bar heights. Deterministic, so safe. `VoicePlayer` has `aria-label` on the button but no `aria-pressed`, no progress semantics, no seek, and `void el.play()` swallows a rejected promise (autoplay policy), leaving UI inconsistent. `missing` hides errors silently.

13. **Dashboard is not usable on mobile.** `shell.tsx:18` sidebar is `hidden ... lg:flex` and there is no mobile nav replacement, so below 1024px there is no way to navigate between Today/Calls/Calendar/Brain/Briefings except typing URLs. For a plumber/HVAC owner on a phone this is the primary device. Fix: bottom tab bar or a menu button below `lg`.

14. **Knowledge editor quirks.** `knowledge-editor.tsx:13` `const [prompt] = useState(initialPrompt)` and `[script] = useState(initialScript)` capture the server value once. After `router.refresh()` the display still shows the old state if the server value changed (e.g. a re-provision). Edit/hide toggle button has no `aria-expanded`; textarea has no label. Services, FAQs and hours cannot be edited at all in the Brain page, only the opening script, despite the copy "Edit it and she picks it up on the next call" (`knowledge/page.tsx:19`).

15. **Accessibility basics.**
   - Contrast: many text colors are `#5a6b80`/`#6b7b91`/`#3f4c5e` on `#07090d`-`#0d1117` at 10-11px (e.g. `checkout.tsx:127` `#3f4c5e` ~2.3:1; `#5a6b80` ~3.6:1). They fail WCAG AA 4.5:1 for small text.
   - Tiny type: 9.5-11px used widely.
   - Demo console script picker (`demo-tools.tsx:80-96`) is a list of plain `<button>`s acting as radio options without `role="radio"`/`aria-checked`.
   - No `:focus-visible` styles: inputs use `outline-none` with only a border color change (`checkout.tsx:147`, onboarding inputs), buttons/links rely on browser default.
   - `Toaster` hard-coded `theme="dark"`; `color-scheme: dark` only (no light mode, acceptable but unlabelled).
   - Dashboard nav `<aside>` lacks `aria-label` and the active link lacks `aria-current="page"` (`shell.tsx:43-55`).
   - Emoji used as icons (`checkout.tsx:123` lock, `received.tsx:21` check) with no `aria-hidden`.
   - `pay` main flashes `h-full` on `html`/`body` plus `min-h-full` (globals.css:23, layout.tsx:18) fine, but `body` radial background with `height:100%` can repeat on long pages (the background is not `fixed`/`no-repeat`).

## Low

16. **DRY.** Brand logo block is copy-pasted in `page.tsx:19`, `onboarding/page.tsx:109`, `shell.tsx:20`, `checkout.tsx:51`. "Section label" markup `text-[11px] uppercase tracking-wider text-[#6b7b91]` appears >25 times. List-row/Stat/Empty-state patterns repeat across pages (`Stat` is local to `dashboard/page.tsx:161` while landing page `page.tsx:85-99` duplicates it by hand). `post`/`patch` fetch helpers are in `onboarding/page.tsx:299-319` while `briefing-actions.tsx`, `demo-tools.tsx`, `knowledge-editor.tsx` each inline the same fetch + `ApiResult` unwrap + toast pattern. Extract `src/lib/api-client.ts` and a `useAction` hook.

17. **Design tokens defined but unused.** `globals.css:3-15` defines `--color-ink/panel/line/mute/brand/mint/sky`, yet the markup uses raw hex (`bg-[#ff6b35]`, `#0d1117`, `#1f2937`...) hundreds of times; `.next` cannot theme or tweak. Use `bg-brand`, `border-line`, etc. `Badge` tones (`badge.tsx:3-10`) and `Button` variants also hard-code hex. `--foreground` and Geist variables are fine.

18. **`Button` is marked `'use client'`** (`ui/button.tsx:1`) though it has no state/hooks, which forces a client boundary for server pages that import it for no reason (only a small bundle cost, but unnecessary). `Badge`/`Card` are correctly server-compatible. `tone` typed as `keyof typeof tones | string` collapses to `string`; `Badge tone={c.urgency}` accepts anything.

19. **Dependencies.** `lucide-react` is in `dependencies` but a grep of src/ shows icons are hand-drawn SVG paths (`shell.tsx:7-12`); check and remove if unused. `cheerio` is used server-side only (extraction), fine. `date-fns` is installed while `lib/format.ts` uses `Intl`; verify use (`grep date-fns src` before keeping). `localtunnel` is a devDependency only used for demos (large transitive tree). `@types/node ^20` vs an engine that may be Node 22+; align. `package.json` has non-standard keys `ignoreScripts`; bun uses `trustedDependencies` only, so `ignoreScripts` has no effect. `postinstall: prisma generate` in a Dockerfile `deps` stage requires the schema to be copied before install. `package.json` name is `app`.

20. **next.config.ts.** `allowedDevOrigins: ['recepcionista.brnby.in']` and the `turbopack.rules` entry that runs `@tailwindcss/turbopack` for `*.css` are fine for dev but hard-code a personal tunnel domain into committed config. No security headers (CSP, `X-Frame-Options`, `Referrer-Policy`) configured, relevant for the pay page, which should not be framable and should send `Referrer-Policy: no-referrer`. Add `headers()`.

21. **Metadata.** Only root `metadata` exists; dashboard/onboarding have no titles or `noindex`; `robots` is set only on `/pay`. No `viewport`/`themeColor`. Dashboard routes should be `noindex`.

22. **Landing page claims not backed by the UI.** `page.tsx:108` "A 45-second voice note at 6 PM": no scheduling UI or setting. `:105` "Real availability": no availability/hours editing exists anywhere in the dashboard. Footer hackathon credit (`:118`) shipped to the public page.

23. **Hydration/Date.** `dashboard/page.tsx:39` formats `new Date()` a second time instead of the `now` read at `:22` (comment on `:21` says render is pure). Server-only here, so no hydration mismatch, but inconsistent.

## Next/React usage notes (verified by reading)
- `params`/`searchParams` are typed as Promises and awaited (`pay/[id]/page.tsx:19-33`): correct for current Next.
- Server components fetch via the db module directly: correct. Client islands are small (Checkout, DemoTools, KnowledgeEditor, BriefingActions, Sidebar, VoicePlayer). `router.refresh()` after mutations is the right pattern.
- `force-dynamic` on every page plus no `revalidate`: all dashboard views are uncached, appropriate for live data, but the landing page (public, does 3 DB queries per request) is also dynamic. A cheap DoS/cost surface; cache it or drop the stats.
- `Home` page reads `process.env.ELEVENLABS_PHONE_NUMBER` at request time, which works only because of `force-dynamic`.
- Fonts via `next/font/google` need network at build time in Docker; consider `next/font/local`.
- `onboarding/page.tsx` is an entire `'use client'` page (319 lines) that imports `normalizeUrl` from `@/lib/extraction`. If that index also imports cheerio/server code, it will be bundled into the client or fail the build. Check `src/lib/extraction/index.ts` imports; move `normalizeUrl` to a client-safe module.

## UX / value proposition

What works: a clear story (paste a URL, get a bilingual receptionist, bookings + deposits + evening voice briefing), and the dashboard's Today view maps to it well (briefing player, next up, "needs your call", recent calls). The demo console is a good sales tool.

What is missing or confusing:
1. **Onboarding to value is thin.** After "Go live" the owner gets a number but no instruction to forward their existing business line to it, no test-call prompt, and nothing about connecting their calendar, Stripe or SMS. The "done" page shows a shared demo number (`VOICE_LINE`), so the owner may be told to give customers a number that is not theirs.
2. **No way to correct what she learned.** The review step says "Fix anything" but is read-only; the Brain page edits only the opening script. Wrong prices quoted to customers is the highest-trust risk, and there is no UI to fix services, prices, hours, emergency rules or service area.
3. **Owner never sees real money flow in demo/mock mode.** Payment never completes (see High 3), so the headline "takes the deposit" cannot be demonstrated end to end; deposits stat is seed-data only.
4. **No operational controls.** No pause/forward-to-me switch, no business hours/after-hours setting, no briefing schedule or delivery number (owner cell is collected but never shown or editable), no way to mark a flagged call handled ("Needs you" never clears), no call-back button on flagged items (phone is plain text, `dashboard/page.tsx:114`).
5. **Calendar is a list, not a calendar,** and bookings cannot be rescheduled/cancelled from the UI.
6. **Bilingual promise is under-evidenced in the UI.** Language shows as a badge, but transcripts are not translated or labelled by speaker and the dashboard itself is English-only for a Spanish-speaking owner base.
7. **Copy/branding inconsistency:** product name "Recepcionista", persona "Maria" (hard-coded), `firstNameOf(business.name)` renders "Miami is answering." (`onboarding/page.tsx:260`), which reads as a person called Miami. Use the persona name.
8. **Trust/legal:** no call-recording consent notice, privacy policy or terms anywhere, which matters for an app that records and transcribes calls (Florida is an all-party-consent state).

## Suggested priority
1. Auth + tenant scoping, gate demo/reset (High 1-2).
2. Real payment link persistence + server-rendered amount, disable mock in prod (High 3-5).
3. Fix onboarding hard-codes and editable review (Medium 6-7), mobile nav (13), ET date handling (9).
4. `loading.tsx`/`error.tsx`, `Promise.all`, a11y contrast/focus, DRY tokens (rest).
