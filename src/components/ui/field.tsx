'use client';
import { useId } from 'react';
import { useT } from '@/lib/i18n/client';
import { cn } from './cn';

export const inputClass =
  'w-full min-h-11 rounded-xl border bg-sunken px-3.5 py-2.5 text-[15px] text-white transition-colors placeholder:text-dim focus:border-brand/70 sm:text-sm';

interface FieldShellProps {
  label: string;
  hint?: string;
  error?: string | null;
  optional?: boolean;
  className?: string;
  /** Hide the visible label (still announced). */
  srOnlyLabel?: boolean;
}

/** Label + control + hint + error, wired together (htmlFor, aria-describedby, aria-invalid). */
function useFieldIds(id?: string) {
  const auto = useId();
  const base = id ?? auto;
  return { id: base, hintId: `${base}-hint`, errId: `${base}-err` };
}

function Shell({
  ids, label, hint, error, optional, className, srOnlyLabel, children,
}: FieldShellProps & { ids: ReturnType<typeof useFieldIds>; children: React.ReactNode }) {
  const t = useT();
  return (
    <div className={className}>
      <label htmlFor={ids.id} className={cn('block text-xs font-medium uppercase tracking-wider text-dim', srOnlyLabel && 'sr-only')}>
        {label}
        {optional ? <span className="ml-1 normal-case tracking-normal text-dim">({t('common.optional')})</span> : null}
      </label>
      <div className={srOnlyLabel ? '' : 'mt-1.5'}>{children}</div>
      {hint && !error ? <p id={ids.hintId} className="mt-1.5 text-xs leading-relaxed text-dim">{hint}</p> : null}
      {error ? <p id={ids.errId} role="alert" className="mt-1.5 text-xs text-danger">{error}</p> : null}
    </div>
  );
}

function describedBy(ids: ReturnType<typeof useFieldIds>, hint?: string, error?: string | null) {
  return error ? ids.errId : hint ? ids.hintId : undefined;
}

export function TextField({
  label, hint, error, optional, className, srOnlyLabel, mono, id, inputClassName, ...rest
}: FieldShellProps & { mono?: boolean; inputClassName?: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  const ids = useFieldIds(id);
  return (
    <Shell ids={ids} {...{ label, hint, error, optional, className, srOnlyLabel }}>
      <input
        {...rest}
        id={ids.id}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(ids, hint, error)}
        className={cn(inputClass, mono && 'font-mono', error ? 'border-danger/70' : 'border-line-2', inputClassName)}
      />
    </Shell>
  );
}

export function TextAreaField({
  label, hint, error, optional, className, srOnlyLabel, id, inputClassName, ...rest
}: FieldShellProps & { inputClassName?: string } & React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const ids = useFieldIds(id);
  return (
    <Shell ids={ids} {...{ label, hint, error, optional, className, srOnlyLabel }}>
      <textarea
        {...rest}
        id={ids.id}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(ids, hint, error)}
        className={cn(inputClass, 'resize-y leading-relaxed', error ? 'border-danger/70' : 'border-line-2', inputClassName)}
      />
    </Shell>
  );
}

export function SelectField({
  label, hint, error, optional, className, srOnlyLabel, id, children, ...rest
}: FieldShellProps & React.SelectHTMLAttributes<HTMLSelectElement>) {
  const ids = useFieldIds(id);
  return (
    <Shell ids={ids} {...{ label, hint, error, optional, className, srOnlyLabel }}>
      <select
        {...rest}
        id={ids.id}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(ids, hint, error)}
        className={cn(inputClass, error ? 'border-danger/70' : 'border-line-2')}
      >
        {children}
      </select>
    </Shell>
  );
}

/** Small uppercase section label (replaces the ad-hoc `text-xs uppercase tracking-wider` markup). */
export function SectionLabel({ children, className, as: Tag = 'p', id }: { children: React.ReactNode; className?: string; as?: 'p' | 'h2' | 'h3'; id?: string }) {
  return <Tag id={id} className={cn('text-xs font-medium uppercase tracking-wider text-dim', className)}>{children}</Tag>;
}
