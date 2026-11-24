'use client';
import Link from 'next/link';
import { useId } from 'react';
import { cn } from '@/components/ui/cn';

/** Centered card used by every public account page. Server- and client-component safe. */
export function AuthShell({ title, subtitle, children, footer }: {
  title: string; subtitle?: string; children: React.ReactNode; footer?: React.ReactNode;
}) {
  return (
    <main className="grid min-h-screen place-items-center px-4 py-10">
      <div className="w-full max-w-sm rounded-xl border border-[#1b2430] bg-[#0b1017] p-6">
        <p className="text-[12px] font-medium uppercase tracking-wide text-[#6b7b91]">Recepcionista</p>
        <h1 className="mt-1 text-lg font-semibold text-white">{title}</h1>
        {subtitle ? <p className="mt-1 text-[13px] text-[#8b98ab]">{subtitle}</p> : null}
        <div className="mt-4">{children}</div>
        {footer ? <div className="mt-5 border-t border-[#1b2430] pt-4 text-center text-[12px] text-[#8b98ab]">{footer}</div> : null}
      </div>
    </main>
  );
}

export function AuthLink({ href, children }: { href: string; children: React.ReactNode }) {
  return <Link href={href} className="text-[#ffb08a] underline-offset-2 hover:underline">{children}</Link>;
}

export const inputCls =
  'mt-1 block w-full rounded-lg border border-[#2a3546] bg-[#080b10] px-3 py-2.5 text-[15px] text-white outline-none focus:border-[#ff6b35] focus-visible:ring-2 focus-visible:ring-[#ff6b35]/40';

export function Field({ label, hint, className, ...props }: React.InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string }) {
  const id = useId();
  return (
    <div className="mt-3 first:mt-0">
      <label htmlFor={id} className="block text-[13px] text-[#a8b6c8]">{label}</label>
      <input id={id} aria-describedby={hint ? `${id}-hint` : undefined} {...props} className={cn(inputCls, className)} />
      {hint ? <p id={`${id}-hint`} className="mt-1 text-[12px] text-[#6b7b91]">{hint}</p> : null}
    </div>
  );
}

export function FormError({ message }: { message: string | null }) {
  return message ? <p role="alert" className="mt-3 rounded-lg bg-[#3a1512] px-3 py-2 text-[13px] text-[#ff9b86]">{message}</p> : null;
}

export function FormNotice({ children }: { children: React.ReactNode }) {
  return <p role="status" className="mt-3 rounded-lg bg-[#10261c] px-3 py-2 text-[13px] text-[#8fe3b4]">{children}</p>;
}

export function SubmitButton({ busy, children, disabled }: { busy: boolean; children: React.ReactNode; disabled?: boolean }) {
  return (
    <button
      type="submit"
      disabled={busy || disabled}
      className="mt-4 w-full rounded-lg bg-[#ff6b35] px-3 py-2.5 text-[14px] font-semibold text-[#150800] hover:bg-[#ff8558] disabled:opacity-50"
    >
      {children}
    </button>
  );
}

export interface ApiOutcome<T = Record<string, unknown>> { ok: boolean; status: number; error?: string; code?: string; data?: T }

/** POST/PATCH/DELETE JSON to our own API. Never throws: network failure becomes `{ ok: false, error }`. */
export async function sendJson<T = Record<string, unknown>>(url: string, body?: unknown, method: 'POST' | 'PATCH' | 'DELETE' | 'GET' = 'POST'): Promise<ApiOutcome<T>> {
  try {
    const res = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await res.json().catch(() => null)) as { ok?: boolean; error?: string; code?: string; data?: T } | null;
    return { ok: res.ok && json?.ok !== false, status: res.status, error: json?.error, code: json?.code, data: json?.data };
  } catch {
    return { ok: false, status: 0, error: 'Network error, please try again' };
  }
}

/** Human message for an API error string (the API's are terse). */
export function friendly(error: string | undefined, fallback = 'Something went wrong. Please try again.'): string {
  if (!error) return fallback;
  if (error === 'rate limit exceeded' || error.startsWith('too many')) return 'Too many attempts. Please wait a few minutes and try again.';
  if (error === 'service temporarily unavailable') return 'The service is temporarily unavailable. Please try again shortly.';
  if (error === 'email_not_configured') return 'Email delivery is not configured on this server, so the message could not be sent.';
  if (error === 'email_send_failed') return 'The email provider did not accept the message. Please try again later.';
  if (error === 'email_not_verified') return 'Please verify your email address first.';
  if (error === 'captcha_failed') return 'The human check failed. Please reload the page and try again.';
  return error;
}

/** Full-page navigation (new session state must be re-read by the server); same-origin paths only. */
export function go(path: string): void {
  window.location.assign(new URL(path, window.location.origin).toString());
}
