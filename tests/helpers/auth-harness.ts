/**
 * Shared set-up for the DB-backed auth tests (tests/db/auth-*.test.ts). Skipped unless TEST_DATABASE_URL names a
 * database containing "test" or "scratch". Emails are captured by stubbing `fetch` behind the Resend provider, so
 * the REAL templates and links (with raw tokens) are what the tests read.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
export const TEST_URL = process.env.TEST_DATABASE_URL;
if (TEST_URL && !/\/[^/?]*(test|scratch)[^/?]*(\?|$)/i.test(TEST_URL)) {
  throw new Error('TEST_DATABASE_URL must name a database containing "test" or "scratch"');
}

export const PASSWORD = 'correct horse battery';
export const ADMIN_TOKEN = 'test-admin-token-123';

export const rid = () => Math.random().toString(36).slice(2, 8);

/** A Request the way a same-origin browser sends it; each call gets its own client IP (TRUSTED_PROXY=true) unless `ip` is given. */
let ipCounter = 10;
export function req(path: string, init: RequestInit & { ip?: string; json?: unknown } = {}): Request {
  const { ip, json, ...rest } = init;
  const headers: Record<string, string> = {
    'sec-fetch-site': 'same-origin',
    'content-type': 'application/json',
    'x-forwarded-for': ip ?? `198.51.100.${(ipCounter = (ipCounter % 240) + 1)}`,
    ...((rest.headers as Record<string, string>) ?? {}),
  };
  return new Request(`http://app.test${path}`, { ...rest, headers, body: json !== undefined ? JSON.stringify(json) : rest.body });
}

export function cookieFrom(res: Response, name = 'rc_user_session'): string | null {
  const c = res.headers.getSetCookie().find((x) => x.startsWith(`${name}=`) && !x.startsWith(`${name}=;`));
  return c ? c.split(';')[0] : null;
}

export interface CapturedMail { to: string; subject: string; text: string; link: string | null; token: string | null }

/**
 * Route outbound mail into an array and answer Turnstile calls. Restores everything with `restore()`.
 * `turnstile`: what siteverify should answer (default: success).
 */
export function captureMail(opts: { turnstile?: boolean } = {}) {
  const mails: CapturedMail[] = [];
  const savedFetch = globalThis.fetch;
  const saved: Record<string, string | undefined> = {
    EMAIL_PROVIDER: process.env.EMAIL_PROVIDER, EMAIL_FROM: process.env.EMAIL_FROM, RESEND_API_KEY: process.env.RESEND_API_KEY,
    TRUSTED_PROXY: process.env.TRUSTED_PROXY, APP_URL: process.env.APP_URL,
  };
  process.env.EMAIL_PROVIDER = 'resend';
  process.env.EMAIL_FROM = 'Test <test@example.test>';
  process.env.RESEND_API_KEY = 'test-key';
  process.env.TRUSTED_PROXY = 'true';
  process.env.APP_URL = 'http://app.test';
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.startsWith('https://api.resend.com/')) {
      const b = JSON.parse(init.body);
      const text: string = b.text;
      const link = text.match(/https?:\/\/\S+/)?.[0] ?? null;
      mails.push({ to: b.to[0], subject: b.subject, text, link, token: link ? new URL(link).searchParams.get('token') : null });
      return new Response(JSON.stringify({ id: 'm1' }), { status: 200 });
    }
    if (url.startsWith('https://challenges.cloudflare.com/')) {
      return new Response(JSON.stringify({ success: opts.turnstile ?? true }), { status: 200 });
    }
    throw new Error(`unexpected outbound fetch in test: ${url}`);
  }) as typeof fetch;
  return {
    mails,
    to: (email: string) => mails.filter((m) => m.to === email),
    restore() {
      globalThis.fetch = savedFetch;
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    },
  };
}

/** The modules every auth DB test needs, imported AFTER DATABASE_URL/ADMIN_TOKEN are set. */
export async function loadAuthModules() {
  process.env.DATABASE_URL = TEST_URL;
  process.env.ADMIN_TOKEN = ADMIN_TOKEN;
  delete process.env.REQUIRE_2FA_FOR_ADMINS;
  const db: any = await import('../../src/lib/db');
  const s: any = await import('../../src/lib/session');
  const pw: any = await import('../../src/lib/password');
  return { db, s, pw };
}

export async function clearLimiter(db: any, prefixes: string[]) {
  for (const p of prefixes) await db.prisma.rateLimitBucket.deleteMany({ where: { key: { startsWith: p } } });
}
