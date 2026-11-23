/**
 * Per-request tenant context for dashboard / onboarding server components. Validates the session
 * in Node (the proxy only gates cheaply), so EVERY page must call this rather than assume it ran.
 *
 * - owner/staff: always their own business (cannot be overridden).
 * - admin / ADMIN_TOKEN: all businesses; the selected one comes from the `rc_business` cookie
 *   (set by the switcher; validated against the real list) and defaults to the first.
 */
import { cache } from 'react';
import { cookies } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { BUSINESS_COOKIE } from '@/lib/auth';
import { getBusiness, listBusinesses } from '@/lib/db';
import { getServerPrincipal, hasRole, principalRole, type Principal, type Role } from '@/lib/session';
import type { Business } from '@/lib/types';

export interface DashboardContext {
  principal: Principal;
  role: Role;
  /** Human label for the shell: the user's email, or the admin credential type. */
  who: string;
  business: Business;
  /** Admin: every business (switcher). Users: just their own. */
  businesses: Business[];
}

export const getDashboardContext = cache(async (): Promise<DashboardContext> => {
  const principal = await getServerPrincipal();
  if (!principal) redirect('/login');
  const role = principalRole(principal);

  if (principal.kind === 'user') {
    const business = await getBusiness(principal.business_id);
    if (!business) notFound();
    return { principal, role, who: principal.user.email, business, businesses: [business] };
  }

  const businesses = await listBusinesses();
  if (businesses.length === 0) redirect('/onboarding');
  let selected: string | undefined;
  try {
    selected = (await cookies()).get(BUSINESS_COOKIE)?.value;
  } catch {
    selected = undefined;
  }
  const business = businesses.find((b) => b.id === selected) ?? businesses[0];
  const who = principal.user?.email ?? (principal.via === 'dev' ? 'dev (auth disabled)' : 'admin token');
  return { principal, role, who, business, businesses };
});

/** 404 unless the caller has at least `min` (don't advertise admin-only pages to tenants). */
export function requireRolePage(ctx: DashboardContext, min: Role): void {
  if (!hasRole(ctx.principal, min)) notFound();
}
