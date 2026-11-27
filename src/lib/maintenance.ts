/**
 * Maintenance mode (registry `platform.maintenance_mode`, "read-only incident switch"). PURE decision used by src/proxy.ts and the banner.
 *
 * What it refuses: a state-changing request to a tenant JSON route made with a USER session cookie (the dashboard, onboarding, owner tools). What it never
 * touches: reads, `/api/admin/*` (the console must stay usable to switch it off), `/api/auth/*` (sign in, out, step-up, 2FA), the Bearer token, the
 * break-glass admin cookie and every webhook / provider callback (they carry no user cookie), so calls, texts and payments keep working while the
 * dashboard is read-only. The refusal is a 503 with `Retry-After`.
 */
export interface MaintenanceRequest {
  enabled: boolean;
  method: string;
  pathname: string;
  /** The request carries `Authorization: Bearer`. */
  bearer: boolean;
  /** The request carries a user session cookie (rc_user_session). */
  userCookie: boolean;
}

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

export function maintenanceRefuses(r: MaintenanceRequest): boolean {
  if (!r.enabled || r.bearer || !r.userCookie || SAFE.has(r.method.toUpperCase())) return false;
  const p = r.pathname;
  if (!p.startsWith('/api/')) return false;
  if (p.startsWith('/api/admin/') || p === '/api/admin' || p.startsWith('/api/auth/') || p === '/api/me/locale') return false;
  return true;
}

export const MAINTENANCE_RETRY_AFTER_SECONDS = 300;
