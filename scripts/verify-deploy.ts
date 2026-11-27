/**
 * Post-deploy verification of a LIVE deployment. Run: bun run verify:deploy
 *
 *   APP_URL=https://app.example.com \
 *   TWILIO_AUTH_TOKEN=... STRIPE_WEBHOOK_SECRET=... ELEVENLABS_WEBHOOK_SECRET=... \
 *   [PUBLIC_BASE_URL=https://app.example.com] [ELEVENLABS_TOOL_SECRET=...] bun scripts/verify-deploy.ts
 *
 * Non-destructive and free of third-party calls: it only talks to APP_URL. The "accepts a correctly signed
 * request" checks forge requests with the configured secrets, using benign shapes that perform no writes:
 *   - Twilio:      POST /api/sms/inbound for a To number no business owns (answered with empty TwiML, no DB write)
 *   - ElevenLabs:  `post_call_audio` event (acknowledged and ignored)
 *   - Stripe:      `verify_deploy.synthetic` event type (acknowledged and ignored)
 *   - Tool route:  call with a bogus agent id (passes the secret check, then answers ok:false: no tenant, no write)
 *   - Initiation:  POST /api/voice/initiation with a bogus agent id (passes the secret check, 200 with a well-formed
 *                  conversation_initiation_client_data body and an EMPTY business_id: no tenant, no call row)
 *   - Billing:     `verify_deploy.synthetic` event type signed with STRIPE_BILLING_WEBHOOK_SECRET (acknowledged and ignored)
 * Also checks the public pages (/login, /signup, /robots.txt, /sitemap.xml) and that every mutating /api/auth/* endpoint
 * refuses a cross-site cookie POST.
 * /api/voice/incoming is checked for rejection only: a validly signed call would create a call row.
 * Secrets are never printed. Exit code 1 if any check fails; secrets that are not set are SKIPped (counted as
 * a failure with --strict).
 */
import { createHmac } from 'node:crypto';

const BASE = (process.env.APP_URL || '').trim().replace(/\/+$/, '');
if (!/^https?:\/\//.test(BASE)) {
  console.error('verify-deploy: set APP_URL to the deployment origin, e.g. APP_URL=https://app.example.com');
  process.exit(2);
}
const STRICT = process.argv.includes('--strict');
// Twilio signs the URL it was configured with; the app resolves ONE public origin (src/lib/base-url.ts: APP_URL, else PUBLIC_BASE_URL).
const SIGN_BASE = BASE;
const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const STRIPE_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const EL_SECRET = process.env.ELEVENLABS_WEBHOOK_SECRET;
const BILLING_SECRET = process.env.STRIPE_BILLING_WEBHOOK_SECRET;
const TOOL_SECRET = process.env.ELEVENLABS_TOOL_SECRET;

type Status = 'PASS' | 'FAIL' | 'SKIP';
const rows: { name: string; status: Status; detail: string }[] = [];
const record = (name: string, status: Status, detail = '') => rows.push({ name, status, detail });

async function check(name: string, fn: () => Promise<string | { skip: string }>) {
  try {
    const r = await fn();
    if (typeof r === 'string') record(name, 'PASS', r);
    else record(name, 'SKIP', r.skip);
  } catch (err) {
    record(name, 'FAIL', (err as Error).message);
  }
}
function expect(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

async function http(path: string, init: RequestInit & { base?: string } = {}) {
  const { base, ...rest } = init;
  return fetch(`${base ?? BASE}${path}`, { redirect: 'manual', signal: AbortSignal.timeout(15_000), ...rest });
}
const blocked = (r: Response) => r.status === 401 || r.status === 403 || (r.status >= 300 && r.status < 400 && /\/login/.test(r.headers.get('location') ?? ''));

// ------------------------------------------------------------------ signers (match the app's verifiers)

const twilioSign = (url: string, params: Record<string, string>, token: string) =>
  createHmac('sha1', token).update(url + Object.keys(params).sort().reduce((a, k) => a + k + params[k], ''), 'utf8').digest('base64');
const hmacHex = (secret: string, payload: string) => createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
const elSign = (secret: string, body: string, t = Math.floor(Date.now() / 1000)) => `t=${t},v0=${hmacHex(secret, `${t}.${body}`)}`;
const stripeSign = (secret: string, body: string, t = Math.floor(Date.now() / 1000)) => `t=${t},v1=${hmacHex(secret, `${t}.${body}`)}`;
const form = (p: Record<string, string>) => new URLSearchParams(p).toString();

const SYN = `verify-deploy-${Date.now().toString(36)}`;
const NOT_A_NUMBER = '+15005550001'; // Twilio magic number range: never assigned to a business here

async function main() {
  // 1. health
  await check('GET /api/health is 200 and db up', async () => {
    const r = await http('/api/health');
    expect(r.status === 200, `status ${r.status}`);
    const j = (await r.json()) as { ok?: boolean; db?: string };
    expect(j.ok === true && j.db === 'up', 'body says not ready');
    return `200 db=${j.db}`;
  });

  // 2. unauthenticated access is blocked
  const protectedPaths: [string, string][] = [
    ['GET', '/dashboard'], ['GET', '/dashboard/calls'], ['GET', '/onboarding'],
    ['GET', '/api/businesses'], ['GET', '/api/admin/retention'], ['POST', '/api/admin/retention'],
    ['GET', '/api/briefings/audio/x.mp3'], ['GET', '/audio/x.mp3'], ['POST', '/api/extract'],
    ['GET', '/api/voice/agent-prompt'],
    // tricky variants: encoding, dot segments, trailing slash, double slash, case, fake extension
    ['GET', '/dashboard/'], ['GET', '//dashboard'], ['GET', '/%64ashboard'], ['GET', '/api/businesses/'],
    ['GET', '/api/%62usinesses'], ['GET', '/api/businesses.js'], ['GET', '/api/businesses;.css'],
    ['GET', '/pay/../dashboard'], ['GET', '/pay/%2e%2e/dashboard'], ['GET', '/login/../dashboard'],
    ['GET', '/api/voice/tools/../../businesses'], ['GET', '/api/voice/tools/%2e%2e/%2e%2e/businesses'],
    ['GET', '/_next/static/../../dashboard'], ['GET', '/DASHBOARD'], ['GET', '/api/BUSINESSES'],
  ];
  for (const [method, path] of protectedPaths) {
    await check(`blocked unauth ${method} ${path}`, async () => {
      const r = await http(path, { method, ...(method === 'POST' ? { headers: { 'content-type': 'application/json' }, body: '{}' } : {}) });
      // 404 is acceptable for odd paths that simply do not exist; leaking content (2xx) is not.
      // 308 = Next's canonical trailing-slash redirect (no content; the redirect target is itself checked as the un-slashed path)
      const canonical = r.status === 308 && path.endsWith('/') && (r.headers.get('location') ?? '').replace(/^https?:\/\/[^/]+/, '') === path.slice(0, -1);
      expect(blocked(r) || canonical || r.status === 404 || r.status === 400 || r.status === 405, `status ${r.status} (expected 401/403/login redirect)`);
      return `${r.status}`;
    });
  }
  await check('wrong Bearer token is rejected on API', async () => {
    const r = await http('/api/businesses', { headers: { authorization: 'Bearer definitely-not-the-token' } });
    expect(r.status === 401 || r.status === 403, `status ${r.status}`);
    return `${r.status}`;
  });
  await check('forged session cookie does not open the dashboard', async () => {
    const r = await http('/api/businesses', { headers: { cookie: 'session=forged; recepcionista_session=forged' } });
    expect(r.status === 401 || r.status === 403, `status ${r.status}`);
    return `${r.status}`;
  });
  await check('cross-site cookie POST is refused or unauthorized', async () => {
    const r = await http('/api/admin/retention', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: 'session=forged', origin: 'https://evil.example' },
      body: '{"dry_run":true}',
    });
    expect(r.status === 401 || r.status === 403, `status ${r.status}`);
    return `${r.status}`;
  });

  // 3. webhooks reject unsigned / badly signed
  const incomingParams = { CallSid: `CA${SYN}`, From: NOT_A_NUMBER, To: NOT_A_NUMBER, CallStatus: 'ringing', Direction: 'inbound' };
  const smsParams = { MessageSid: `SM${SYN}`, From: NOT_A_NUMBER, To: NOT_A_NUMBER, Body: `${SYN} synthetic` };
  const twilioPost = (path: string, params: Record<string, string>, sig?: string) =>
    http(path, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...(sig ? { 'x-twilio-signature': sig } : {}) }, body: form(params) });

  await check('Twilio /api/voice/incoming rejects unsigned', async () => {
    const r = await twilioPost('/api/voice/incoming', incomingParams);
    expect(r.status === 403, `status ${r.status}`);
    return '403';
  });
  await check('Twilio /api/voice/incoming rejects bad signature', async () => {
    const r = await twilioPost('/api/voice/incoming', incomingParams, twilioSign(`${SIGN_BASE}/api/voice/incoming`, incomingParams, 'not-the-token'));
    expect(r.status === 403, `status ${r.status}`);
    return '403';
  });
  await check('Twilio /api/sms/inbound rejects unsigned', async () => {
    const r = await twilioPost('/api/sms/inbound', smsParams);
    expect(r.status === 403, `status ${r.status}`);
    return '403';
  });
  await check('Twilio /api/sms/inbound rejects bad signature', async () => {
    const r = await twilioPost('/api/sms/inbound', smsParams, twilioSign(`${SIGN_BASE}/api/sms/inbound`, smsParams, 'not-the-token'));
    expect(r.status === 403, `status ${r.status}`);
    return '403';
  });
  await check('Twilio /api/sms/inbound ACCEPTS correctly signed synthetic request', async () => {
    if (!TWILIO_TOKEN) return { skip: 'TWILIO_AUTH_TOKEN not set here' };
    const r = await twilioPost('/api/sms/inbound', smsParams, twilioSign(`${SIGN_BASE}/api/sms/inbound`, smsParams, TWILIO_TOKEN));
    expect(r.status === 200, `status ${r.status} (token or PUBLIC_BASE_URL differs from the server's, or Twilio URL scheme/host mismatch)`);
    return '200';
  });

  const elBody = JSON.stringify({ type: 'post_call_audio', event_timestamp: Math.floor(Date.now() / 1000), data: { agent_id: `agent_${SYN}`, conversation_id: `conv_${SYN}`, full_audio: '' } });
  const elPost = (body: string, sig?: string) =>
    http('/api/voice/post-call', { method: 'POST', headers: { 'content-type': 'application/json', ...(sig ? { 'elevenlabs-signature': sig } : {}) }, body });
  await check('ElevenLabs post-call rejects unsigned', async () => {
    const r = await elPost(elBody);
    expect(r.status === 401, `status ${r.status}`);
    return '401';
  });
  await check('ElevenLabs post-call rejects bad signature and stale timestamp', async () => {
    const bad = await elPost(elBody, elSign('not-the-secret', elBody));
    expect(bad.status === 401, `bad secret: status ${bad.status}`);
    if (EL_SECRET) {
      const stale = await elPost(elBody, elSign(EL_SECRET, elBody, Math.floor(Date.now() / 1000) - 7200));
      expect(stale.status === 401, `stale timestamp: status ${stale.status}`);
    }
    return '401';
  });
  await check('ElevenLabs post-call ACCEPTS correctly signed synthetic event (post_call_audio, ignored)', async () => {
    if (!EL_SECRET) return { skip: 'ELEVENLABS_WEBHOOK_SECRET not set here' };
    const r = await elPost(elBody, elSign(EL_SECRET, elBody));
    expect(r.status === 200, `status ${r.status} (secret differs from the one the server holds / the one ElevenLabs signs with)`);
    return '200';
  });

  const stBody = JSON.stringify({ id: `evt_${SYN}`, object: 'event', type: 'verify_deploy.synthetic', data: { object: {} } });
  const stPost = (sig?: string) =>
    http('/api/payments/webhook', { method: 'POST', headers: { 'content-type': 'application/json', ...(sig ? { 'stripe-signature': sig } : {}) }, body: stBody });
  await check('Stripe webhook rejects unsigned and bad signature', async () => {
    const a = await stPost();
    expect(a.status === 400 || a.status === 401 || a.status === 403, `unsigned: status ${a.status}`);
    const b = await stPost(stripeSign('whsec_not_the_secret', stBody));
    expect(b.status === 400 || b.status === 401 || b.status === 403, `bad sig: status ${b.status}`);
    return `${a.status}/${b.status}`;
  });
  await check('Stripe webhook ACCEPTS correctly signed synthetic event (ignored type)', async () => {
    if (!STRIPE_SECRET) return { skip: 'STRIPE_WEBHOOK_SECRET not set here' };
    const r = await stPost(stripeSign(STRIPE_SECRET, stBody));
    expect(r.status === 200, `status ${r.status}`);
    return '200';
  });

  // ElevenLabs tool route: secret header gate. A wrong/missing secret must be refused; with the right secret the
  // request gets past authentication and is then refused because the synthetic agent maps to no business.
  const toolPost = (secret?: string) =>
    http('/api/voice/tools/get_pricing', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(secret ? { 'x-recepcionista-tool-secret': secret } : {}) },
      body: JSON.stringify({ agent_id: `agent_${SYN}`, service_name: 'synthetic' }),
    });
  await check('Tool route rejects missing/wrong tool secret', async () => {
    const a = await toolPost();
    const b = await toolPost('not-the-secret');
    expect(a.status === 401 || a.status === 403, `missing: status ${a.status}`);
    expect(b.status === 401 || b.status === 403, `wrong: status ${b.status}`);
    return `${a.status}/${b.status}`;
  });
  await check('Tool route accepts the configured tool secret (unknown synthetic agent -> ok:false, no write)', async () => {
    if (!TOOL_SECRET) return { skip: 'ELEVENLABS_TOOL_SECRET not set here' };
    const r = await toolPost(TOOL_SECRET);
    expect(r.status === 200, `status ${r.status} (tool secret differs from the server's)`);
    const j = (await r.json()) as { ok?: boolean };
    expect(j.ok === false, 'synthetic agent unexpectedly resolved a tenant');
    return '200 ok:false';
  });

  // ElevenLabs conversation-initiation webhook (native Twilio path): same shared secret header as the tools.
  const initPost = (secret?: string) =>
    http('/api/voice/initiation', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(secret ? { 'x-recepcionista-tool-secret': secret } : {}) },
      body: JSON.stringify({ agent_id: `agent_${SYN}`, caller_id: NOT_A_NUMBER, called_number: NOT_A_NUMBER, call_sid: `CA${SYN}`, conversation_id: `conv_${SYN}` }),
    });
  await check('Initiation webhook rejects missing/invalid tool secret', async () => {
    const a = await initPost();
    const b = await initPost('not-the-secret');
    expect(a.status === 401, `missing: status ${a.status}`);
    expect(b.status === 401, `wrong: status ${b.status}`);
    return '401/401';
  });
  await check('Initiation webhook accepts the tool secret (unknown agent -> 200, well-formed, no tenant)', async () => {
    if (!TOOL_SECRET) return { skip: 'ELEVENLABS_TOOL_SECRET not set here' };
    const r = await initPost(TOOL_SECRET);
    expect(r.status === 200, `status ${r.status} (tool secret differs from the server's)`);
    const j = (await r.json()) as { type?: string; dynamic_variables?: { business_id?: string }; conversation_config_override?: unknown };
    expect(j.type === 'conversation_initiation_client_data', `unexpected body type ${String(j.type)}`);
    expect(j.dynamic_variables?.business_id === '', 'a synthetic agent unexpectedly resolved a tenant');
    expect(j.conversation_config_override === undefined, 'no disclosure override may be sent for an unknown tenant');
    return '200 well-formed, no tenant';
  });

  // Phase 2 telephony: transfer configuration, call screening, live transcript. Non-destructive (rejections and empty tenants only).
  await check('Transfer config: an unknown tenant gets NO transfer destination (the per-call variable stays empty)', async () => {
    if (!TOOL_SECRET) return { skip: 'ELEVENLABS_TOOL_SECRET not set here' };
    const j = (await (await initPost(TOOL_SECRET)).json()) as { dynamic_variables?: Record<string, string> };
    const d = j.dynamic_variables ?? {};
    expect((d.transfer_destination ?? '') === '', 'a synthetic tenant received a transfer destination');
    expect((d.transfer_mode ?? 'off') === 'off', `transfer_mode is ${String(d.transfer_mode)} for a synthetic tenant`);
    return 'no destination for an unknown tenant';
  });
  await check('Call screening /api/voice/screen rejects unsigned requests', async () => {
    const r = await http('/api/voice/screen', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `ParentCallSid=CA${SYN}` });
    expect(r.status === 403, `status ${r.status}`);
    return '403';
  });
  await check('Live transcript push /api/voice/transcript-event rejects a missing tool secret', async () => {
    const r = await http('/api/voice/transcript-event', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ call_sid: `CA${SYN}`, events: [] }) });
    expect(r.status === 401, `status ${r.status}`);
    return '401';
  });
  await check('Live transcript /api/calls/:id/live and /transcript require a session', async () => {
    const a = await http(`/api/calls/call_${SYN}/live`);
    const b = await http(`/api/calls/call_${SYN}/transcript`);
    expect(a.status === 401 || a.status === 403, `live: status ${a.status}`);
    expect(b.status === 401 || b.status === 403, `transcript: status ${b.status}`);
    return `${a.status}/${b.status}`;
  });

  // Stripe BILLING webhook (subscriptions; a different endpoint secret from the deposit webhook).
  const bbBody = JSON.stringify({ id: `evt_${SYN}`, object: 'event', type: 'verify_deploy.synthetic', data: { object: {} } });
  const bbPost = (sig?: string) =>
    http('/api/billing/webhook', { method: 'POST', headers: { 'content-type': 'application/json', ...(sig ? { 'stripe-signature': sig } : {}) }, body: bbBody });
  await check('Billing webhook rejects unsigned and bad signature', async () => {
    const a = await bbPost();
    const b = await bbPost(stripeSign('whsec_not_the_secret', bbBody));
    // 400 invalid signature; 503 = STRIPE_BILLING_WEBHOOK_SECRET unset on the server (refuses everything, still safe)
    expect(a.status === 400 || a.status === 503, `unsigned: status ${a.status}`);
    expect(b.status === 400 || b.status === 503, `bad sig: status ${b.status}`);
    return `${a.status}/${b.status}`;
  });
  await check('Billing webhook ACCEPTS correctly signed synthetic event (ignored type)', async () => {
    if (!BILLING_SECRET) return { skip: 'STRIPE_BILLING_WEBHOOK_SECRET not set here' };
    const r = await bbPost(stripeSign(BILLING_SECRET, bbBody));
    expect(r.status === 200, `status ${r.status} (secret differs from the billing endpoint's signing secret)`);
    return '200';
  });

  // Public pages and crawler files must be reachable without credentials.
  for (const path of ['/login', '/signup', '/robots.txt', '/sitemap.xml']) {
    await check(`public ${path} is reachable`, async () => {
      const r = await http(path);
      expect(r.status === 200, `status ${r.status} (expected 200; a redirect to /login means the path is not on the public allowlist)`);
      return '200';
    });
  }

  // Mutating /api/auth/* endpoints must refuse a cross-site cookie POST (CSRF), whether or not the cookie is real.
  const authPosts = ['login', 'logout', 'signup', 'mfa', 'verify-email', 'resend-verification', 'forgot-password', 'reset-password', 'accept-invite',
    '2fa/enroll', '2fa/confirm', '2fa/disable', '2fa/recovery-codes', 'sessions/revoke-others', 'revoke-admin-sessions'];
  await check(`cross-site cookie POST refused on ${authPosts.length} /api/auth/* endpoints`, async () => {
    const bad: string[] = [];
    for (const p of authPosts) {
      const r = await http(`/api/auth/${p}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: 'rc_user_session=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' },
        body: '{}',
      });
      if (r.status !== 403 && r.status !== 401) bad.push(`${p}:${r.status}`);
    }
    expect(bad.length === 0, `not refused: ${bad.join(', ')}`);
    return '403';
  });

  // 4. security headers on public pages
  const wantHeaders: [string, RegExp | null][] = [
    ['x-content-type-options', /nosniff/i],
    ['x-frame-options', /deny|sameorigin/i],
    ['referrer-policy', null],
    ['content-security-policy', null],
    ['permissions-policy', null],
  ];
  for (const path of ['/login', '/pay/verify-deploy-synthetic']) {
    await check(`security headers on ${path}`, async () => {
      const r = await http(path);
      const missing: string[] = [];
      for (const [h, re] of wantHeaders) {
        const v = r.headers.get(h);
        if (!v || (re && !re.test(v))) missing.push(h);
      }
      // frame-ancestors in a CSP substitutes for x-frame-options
      if (missing.includes('x-frame-options') && /frame-ancestors/i.test(r.headers.get('content-security-policy') ?? '')) missing.splice(missing.indexOf('x-frame-options'), 1);
      if (new URL(BASE).protocol === 'https:' && !r.headers.get('strict-transport-security')) missing.push('strict-transport-security');
      expect(missing.length === 0, `missing/invalid: ${missing.join(', ')} (status ${r.status})`);
      expect(!r.headers.get('x-powered-by'), 'x-powered-by is exposed');
      return `status ${r.status}`;
    });
  }

  // 5. TLS / redirect sanity
  const u = new URL(BASE);
  if (u.protocol === 'https:') {
    await check('HTTP redirects to HTTPS', async () => {
      const r = await fetch(`http://${u.host}/login`, { redirect: 'manual', signal: AbortSignal.timeout(15_000) });
      const loc = r.headers.get('location') ?? '';
      expect(r.status >= 300 && r.status < 400 && loc.startsWith('https://'), `status ${r.status} location=${loc || '(none)'}`);
      return `${r.status} -> https`;
    });
    await check('HTTPS certificate valid (no TLS errors)', async () => {
      const r = await http('/api/health');
      return `TLS ok (status ${r.status})`;
    });
    await check('Webhook base URL matches APP_URL', async () => {
      const sb = new URL(SIGN_BASE);
      expect(sb.protocol === 'https:', `APP_URL is ${sb.protocol} but Twilio signs the https URL`);
      const pub = (process.env.PUBLIC_BASE_URL || '').trim();
      if (pub) expect(new URL(pub).host === u.host, `PUBLIC_BASE_URL host (${new URL(pub).host}) differs from APP_URL host (${u.host}); APP_URL wins on the server`);
      return sb.host;
    });
  } else {
    record('HTTPS checks', 'SKIP', `APP_URL is ${u.protocol}; production must be https`);
  }

  // ------------------------------------------------------------------ report
  const w = Math.max(...rows.map((r) => r.name.length), 10);
  console.log(`\nverify-deploy against ${BASE}\n`);
  for (const r of rows) console.log(`${r.status.padEnd(4)}  ${r.name.padEnd(w)}  ${r.detail}`);
  const fails = rows.filter((r) => r.status === 'FAIL').length;
  const skips = rows.filter((r) => r.status === 'SKIP').length;
  console.log(`\n${rows.length - fails - skips} passed, ${fails} failed, ${skips} skipped${STRICT && skips ? ' (--strict: skips fail)' : ''}`);
  process.exit(fails > 0 || (STRICT && skips > 0) ? 1 : 0);
}

main().catch((err) => {
  console.error(`verify-deploy crashed: ${(err as Error).message}`);
  process.exit(2);
});
