/**
 * deploy.sh post-start verification (the VERIFY_JS the script runs inside the app container) against a stub admin API, and the automatic rollback of the previous app image
 * driven through a fake `docker`. No database, no network beyond 127.0.0.1.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, test } from 'bun:test';

const SCRIPT = readFileSync('deploy.sh', 'utf8');
const VERIFY_JS = /VERIFY_JS='\n([\s\S]*?)\n'\n/.exec(SCRIPT)![1];

type Setting = { key: string; kind: 'secret' | 'string' | 'bool'; source: 'env' | 'console' | 'default'; value?: unknown; secret?: { set: boolean } };
const secret = (key: string, set = true): Setting => ({ key, kind: 'secret', source: set ? 'env' : 'default', secret: { set } });
const card = (provider: string, ready: boolean, missing: string[] = []) => ({ provider, ready, missing });

const runNode = (env: Record<string, string>): Promise<{ rc: number; out: string }> => new Promise((resolve) => {
  const child = spawn('node', ['-e', VERIFY_JS], { env: { ...process.env, ...env } });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.on('close', (rc) => resolve({ rc: rc ?? -1, out }));
});

async function verify(opts: { settings: Setting[]; providers: ReturnType<typeof card>[]; specs?: string[] }) {
  const server = createServer((req, res) => {
    const reply = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.headers.authorization !== 'Bearer tok') return reply(401, {});
    if (req.url === '/api/admin/selftest') return reply(200, { ok: true, data: { providers: opts.providers } });
    if (req.url === '/api/admin/settings') return reply(200, { ok: true, data: { settings: opts.settings } });
    return reply(404, {});
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    return await runNode({ ADMIN_TOKEN: 'tok', RC_BASE: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, RC_SPECS: (opts.specs ?? []).join('\n') });
  } finally { server.close(); }
}

describe('deploy.sh VERIFY_JS: every configured provider must be ready, wherever its keys live', () => {
  test('console-held ELEVENLABS_API_KEY with missing tool/webhook secrets fails; complete passes; unused providers are ignored', async () => {
    const base = [card('twilio', false, ['twilio.account_sid']), card('google', false, ['google.client_id']), card('stripe', false, ['stripe.secret_key'])];
    const bad = await verify({ settings: [{ key: 'elevenlabs.api_key', kind: 'secret', source: 'console', secret: { set: true } }], providers: [...base, card('elevenlabs', false, ['elevenlabs.tool_secret', 'elevenlabs.webhook_secret'])] });
    expect(bad.rc).toBe(3);
    expect(bad.out).toMatch(/INCOMPLETE elevenlabs .*elevenlabs\.tool_secret, elevenlabs\.webhook_secret/);
    const good = await verify({ settings: [{ key: 'elevenlabs.api_key', kind: 'secret', source: 'console', secret: { set: true } }], providers: [...base, card('elevenlabs', true)] });
    expect(good.rc).toBe(0);
    const none = await verify({ settings: [], providers: [card('elevenlabs', false, ['elevenlabs.api_key'])] });
    expect(none.rc).toBe(0); // nothing configured -> nothing to complete (the deferred specs cover what is required)
  });
  test('twilio account sid, google client id and the annual stripe price each trigger their card', async () => {
    for (const [key, name] of [['twilio.account_sid', 'twilio'], ['google.client_id', 'google'], ['stripe.price_id_annual', 'stripe'], ['stripe.secret_key', 'stripe']] as const) {
      const settings: Setting[] = key === 'stripe.price_id_annual' ? [{ key, kind: 'string', source: 'console', value: 'price_1' }] : [secret(key)];
      const r = await verify({ settings, providers: [card(name, false, [`${name}.x`])] });
      expect([key, r.rc]).toEqual([key, 3]);
      expect(r.out).toContain(`INCOMPLETE ${name}`);
      expect((await verify({ settings, providers: [card(name, true)] })).rc).toBe(0);
    }
  });
  test('deferred specs still work, and an unreachable API is UNVERIFIED (rc 4)', async () => {
    const r = await verify({ settings: [], providers: [card('llm', false)], specs: ['OPENAI_API_KEY or ANTHROPIC_API_KEY=@llm'] });
    expect([r.rc, r.out]).toEqual([3, expect.stringContaining('MISSING OPENAI_API_KEY')]);
    expect((await runNode({ ADMIN_TOKEN: 'tok', RC_BASE: 'http://127.0.0.1:1' })).rc).toBe(4);
  });
});

describe('deploy.sh rolls the previous app image back when verification fails', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'deploy-rollback-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const env = [
    'DOMAIN=app.example.test', 'APP_URL=https://app.example.test', 'POSTGRES_USER=u', 'POSTGRES_PASSWORD=p', 'POSTGRES_DB=d', 'ADMIN_TOKEN=tok',
    `APP_SECRET_KEY=${Buffer.alloc(32, 3).toString('base64')}`, 'OPENAI_API_KEY=sk-x', 'EMAIL_PROVIDER=resend', 'RESEND_API_KEY=re_x', 'EMAIL_FROM=a@example.test',
    'BILLING_ENFORCED=false', 'STRIPE_WEBHOOK_SECRET=whsec_x', 'SIGNUP_ALLOW_WITHOUT_CAPTCHA=true',
  ].join('\n');
  const fakeDocker = `#!/usr/bin/env bash
echo "APP_IMAGE=\${APP_IMAGE:-} :: $*" >> "$FAKE_LOG"
case "$*" in
  *"ps -q app"*) n=$(cat "$FAKE_LOG.n" 2>/dev/null || echo 0); echo $((n+1)) > "$FAKE_LOG.n"; [[ "$FAKE_FIRST" == "1" && $n == 0 ]] && exit 0; echo cid-old ;;
  *"inspect -f {{.Image}}"*) echo sha256:oldimage ;;
  *"State.Health.Status"*) echo "$FAKE_HEALTH" ;;
  *" exec "*) echo "MISSING something"; exit "$FAKE_VERIFY_RC" ;;
esac
exit 0
`;
  function deploy(vars: Record<string, string>) {
    const work = mkdtempSync(path.join(dir, 'w-'));
    copyFileSync('deploy.sh', path.join(work, 'deploy.sh'));
    writeFileSync(path.join(work, 'compose.production.yaml'), 'services: {}\n');
    writeFileSync(path.join(work, '.env'), env);
    mkdirSync(path.join(work, 'bin'));
    writeFileSync(path.join(work, 'bin', 'docker'), fakeDocker); chmodSync(path.join(work, 'bin', 'docker'), 0o755);
    const log = path.join(work, 'log'); writeFileSync(log, '');
    const r = spawnSync('bash', ['deploy.sh'], { cwd: work, encoding: 'utf8', env: { ...process.env, PATH: `${work}/bin:${process.env.PATH}`, FAKE_LOG: log, FAKE_HEALTH: 'healthy', FAKE_VERIFY_RC: '0', FAKE_FIRST: '0', ...vars } });
    return { ...r, log: readFileSync(log, 'utf8') };
  }
  const restored = /APP_IMAGE=recepcionista-app:rollback :: compose -f compose.production.yaml up -d --no-build --no-deps --force-recreate app/;

  test('a failed settings verification puts the previous image back and fails the deploy', () => {
    const r = deploy({ FAKE_VERIFY_RC: '3' });
    expect(r.status).toBe(1);
    expect(r.log).toMatch(/tag sha256:oldimage recepcionista-app:rollback/);
    expect(r.log).toMatch(restored);
    expect(r.stderr).toMatch(/ROLLBACK: putting the previous app image back/);
    expect(r.stderr).toMatch(/previous release was put back/);
  });
  test('an unhealthy new app is rolled back too', () => {
    const r = deploy({ FAKE_HEALTH: 'unhealthy' });
    expect(r.status).toBe(1);
    expect(r.log).toMatch(restored);
  });
  test('a passing verification does not roll back; a first deploy has nothing to roll back to (the new app is stopped)', () => {
    const ok = deploy({});
    expect(ok.status).toBe(0);
    expect(ok.log).not.toMatch(restored);
    const first = deploy({ FAKE_VERIFY_RC: '3', FAKE_FIRST: '1' });
    expect(first.status).toBe(1);
    expect(first.log).not.toMatch(restored);
    expect(first.log).toMatch(/compose -f compose.production.yaml stop app/);
  });
});
