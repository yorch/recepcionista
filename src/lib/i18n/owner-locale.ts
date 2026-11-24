/**
 * The language to use when WE write to a business owner: the owner's own users.locale (first enabled owner; most businesses have one),
 * else the business default. Server side only (reads the team list). Customers are different: they get the call language / business default.
 */
import { listBusinessUsers } from '@/lib/db';
import { normalizeLocale, type Locale } from './core';

export async function ownerLocaleFor(business: { id: string; locale_default?: Locale | string | null }): Promise<Locale> {
  try {
    const owner = (await listBusinessUsers(business.id)).find((u) => u.role === 'owner' && !u.disabled_at);
    return normalizeLocale(owner?.locale) ?? normalizeLocale(business.locale_default) ?? 'en';
  } catch {
    return normalizeLocale(business.locale_default) ?? 'en';
  }
}
