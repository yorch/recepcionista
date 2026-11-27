/**
 * Google Calendar integration configuration (env only). Nothing here reads a secret into a log line.
 *
 * GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET   OAuth client (web application)
 * GOOGLE_OAUTH_REDIRECT_URI                 default `${APP_URL}/api/integrations/google/callback`
 * GOOGLE_WEBHOOK_SECRET                     HMAC key for push-channel tokens (falls back to a key derived from APP_SECRET_KEY)
 * GOOGLE_OAUTH_MOCK=true                    fake Google for local/e2e (REFUSED in production)
 */
import crypto from 'node:crypto';
import { appSecretKey } from '@/lib/totp';
import { baseUrlOrDev } from '@/lib/base-url';

export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
export const GOOGLE_API = 'https://www.googleapis.com/calendar/v3';

/** Minimal scopes: events (read/write: sync + push + watch) and the calendar LIST (to pick a calendar and learn the account email). */
export const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
] as const;

export const isProduction = (env: NodeJS.ProcessEnv = process.env): boolean => env.NODE_ENV === 'production';

/** Mock mode: only ever outside production. In production GOOGLE_OAUTH_MOCK=true is ignored and reported as a problem. */
export function googleMockEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.GOOGLE_OAUTH_MOCK ?? '').trim().toLowerCase() === 'true' && !isProduction(env);
}

/** A production deployment that asked for mock mode (a misconfiguration the boot log and status endpoint surface). */
export const googleMockRefused = (env: NodeJS.ProcessEnv = process.env): boolean =>
  (env.GOOGLE_OAUTH_MOCK ?? '').trim().toLowerCase() === 'true' && isProduction(env);

export function googleConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  if (googleMockEnabled(env)) return true;
  return Boolean((env.GOOGLE_CLIENT_ID ?? '').trim() && (env.GOOGLE_CLIENT_SECRET ?? '').trim());
}

export function appBase(env: NodeJS.ProcessEnv = process.env): string {
  return baseUrlOrDev(env);
}

export function redirectUri(env: NodeJS.ProcessEnv = process.env): string {
  return (env.GOOGLE_OAUTH_REDIRECT_URI ?? '').trim() || `${appBase(env)}/api/integrations/google/callback`;
}

export const webhookUrl = (env: NodeJS.ProcessEnv = process.env): string => `${appBase(env)}/api/integrations/google/webhook`;

export function clientCredentials(env: NodeJS.ProcessEnv = process.env): { id: string; secret: string } {
  return { id: (env.GOOGLE_CLIENT_ID ?? '').trim(), secret: (env.GOOGLE_CLIENT_SECRET ?? '').trim() };
}

/** HMAC-SHA256 hex with a purpose label so one secret never serves two roles. */
export function hmac(purpose: string, data: string, env: NodeJS.ProcessEnv = process.env): string {
  const explicit = (env.GOOGLE_WEBHOOK_SECRET ?? '').trim();
  const base = purpose.startsWith('channel') && explicit ? Buffer.from(explicit) : appSecretKey(env);
  const key = crypto.createHmac('sha256', base).update(`gcal:${purpose}`).digest();
  return crypto.createHmac('sha256', key).update(data).digest('hex');
}

export function safeEqualHex(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
