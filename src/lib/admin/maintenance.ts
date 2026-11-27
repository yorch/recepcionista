/**
 * Platform read-only / maintenance mode: the server-side helper (registry `platform.maintenance_mode`). The PURE decision lives in `src/lib/maintenance.ts` (used by the proxy:
 * a state-changing request made with a user session cookie is refused); this module is what route handlers and the banner call.
 *
 * Safe behaviour, decided once (webhooks must never be dropped):
 *   - refused (503 `maintenance`, `Retry-After`, a clear message): tenant-facing writes carrying a USER session cookie (proxy) and public signups (`refuseIfMaintenance`, called by `POST /api/auth/signup`);
 *   - never refused: reads, `/api/admin/*` (the console must stay able to switch the mode off), `/api/auth/*` (sign in / out / step-up), the Bearer token, and EVERY provider webhook /
 *     callback (Twilio voice + sms + status, ElevenLabs post-call / tools / initiation, Stripe, Google push): they carry no user cookie, are processed normally and stay idempotent,
 *     so a call is still answered, a text still delivered and a payment still recorded while the dashboard is read-only. Nothing is queued: accepting and processing is the
 *     safe choice, because a provider retry storm after the window is worse than a few extra rows.
 */
import { NextResponse } from 'next/server';
import { setting } from '@/lib/config';
import { MAINTENANCE_RETRY_AFTER_SECONDS } from '@/lib/maintenance';

export const MAINTENANCE_MESSAGE = 'The service is in read-only maintenance. Reading works; changes are refused until maintenance ends. Please try again shortly.';

export interface MaintenanceState {
  enabled: boolean;
  /** Seconds a client should wait before retrying a refused write. */
  retry_after: number;
  /** The announcement banner text (empty when none). */
  announcement: string;
}

/** Is the platform in read-only maintenance right now? Read at call time from the config snapshot (never cache it). */
export function maintenanceActive(): boolean {
  return setting('platform.maintenance_mode') === true;
}

export function maintenanceState(): MaintenanceState {
  return { enabled: maintenanceActive(), retry_after: MAINTENANCE_RETRY_AFTER_SECONDS, announcement: (setting('platform.announcement') ?? '').trim() };
}

/** The refusal body shared by the proxy rule and the route helper: 503, `Retry-After`, `{ ok:false, error:'maintenance', code:'maintenance', message }`. */
export function maintenanceResponse(): NextResponse {
  return NextResponse.json(
    { ok: false, error: 'maintenance', code: 'maintenance', message: MAINTENANCE_MESSAGE },
    { status: 503, headers: { 'Retry-After': String(MAINTENANCE_RETRY_AFTER_SECONDS), 'Cache-Control': 'no-store' } },
  );
}

/** For a write route the proxy rule cannot see (no user cookie yet: signup): the 503 while maintenance is on, else null. NEVER call it from a webhook. */
export function refuseIfMaintenance(): NextResponse | null {
  return maintenanceActive() ? maintenanceResponse() : null;
}
