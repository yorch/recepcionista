'use client';
import { useT } from '@/lib/i18n/client';
import type { MessageKey, TFunction } from '@/lib/i18n/core';
import { adminErrorText, apiCode, problemsOf } from './errors';

/** Machine codes of the tenant / plan / administrator routes (catalog keys `at.err.<code>`). */
export const TENANT_ERROR_CODES = [
  'last_owner', 'self', 'in_use', 'protected_plan', 'exists', 'already_suspended', 'not_suspended', 'support_write_required', 'platform_only', 'email_taken',
  'invalid_plan', 'invalid_email', 'invalid_role', 'invalid_password', 'not_tenant_key', 'invalid_filter',
] as const;
const SET = new Set<string>(TENANT_ERROR_CODES);

/** Localized text of a failure: this page family's codes first, then the console's generic map. */
export function tenantErrorText(t: TFunction, err: unknown): string {
  const code = apiCode(err);
  return code && SET.has(code) ? t(`at.err.${code}` as MessageKey) : adminErrorText(t, err);
}

/** Same contract as the console's `Problems`, with this family's codes localized. */
export function Problems({ error }: { error: unknown }) {
  const t = useT();
  const list = problemsOf(error);
  return (
    <div role="alert" className="rounded-xl border border-danger-line bg-danger-bg/40 p-3 text-[13px] text-danger">
      <p className="font-medium">{tenantErrorText(t, error)}</p>
      {list.length > 1 ? (
        <ul className="mt-1.5 list-disc space-y-1 pl-5 text-soft">{list.map((p, i) => <li key={`${p.key}-${i}`}><span className="font-mono text-xs">{p.key}</span>: {p.message}</li>)}</ul>
      ) : null}
    </div>
  );
}
