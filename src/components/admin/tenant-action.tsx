'use client';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { useT } from '@/lib/i18n/client';
import { useAdmin } from './provider';
import { ConfirmFields, confirmReady } from './ui';
import { Problems } from './tenant-errors';

/**
 * One guarded console action with its own inline form: optional extra fields (children), a REQUIRED reason and, for the critical tier, the exact phrase to type.
 * `run(reason)` performs the call; a `reauth_required` answer opens the console's step-up panel and retries once (AdminProvider.guard). The button is hidden by
 * the caller when the role lacks the permission; the server enforces it anyway.
 */
export function ReasonAction({
  label, title, description, phrase = null, variant = 'outline', run, onDone, children, disabled = false, ready = true, doneMessage,
}: {
  label: string; title?: string; description?: string; phrase?: string | null; variant?: 'outline' | 'danger' | 'primary';
  run: (reason: string) => Promise<unknown>; onDone?: () => void; children?: React.ReactNode; disabled?: boolean; ready?: boolean; doneMessage?: string;
}) {
  const t = useT();
  const { guard } = useAdmin();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setError(null);
    try {
      await guard(async () => { await run(reason.trim()); });
      toast.success(doneMessage ?? t('at.action.done'));
      setOpen(false); setReason(''); setTyped('');
      onDone?.();
    } catch (err) { setError(err); } finally { setBusy(false); }
  }

  if (!open) return <Button variant={variant} disabled={disabled} onClick={() => setOpen(true)}>{label}</Button>;
  return (
    <form onSubmit={submit} aria-label={title ?? label} className="flex flex-col gap-3 rounded-xl border border-line-3 bg-sunken/60 p-4">
      <p className="text-sm font-semibold text-white">{title ?? label}</p>
      {description ? <p className="text-[13px] text-mute">{description}</p> : null}
      {children}
      <ConfirmFields reasonRequired phrase={phrase} reason={reason} onReason={setReason} typed={typed} onTyped={setTyped} />
      {error ? <Problems error={error} /> : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant={variant === 'outline' ? 'primary' : variant} disabled={busy || !ready || !confirmReady({ reasonRequired: true, reason, phrase, typed })}>{busy ? t('common.loading') : label}</Button>
        <Button variant="ghost" onClick={() => { setOpen(false); setError(null); }}>{t('common.cancel')}</Button>
      </div>
    </form>
  );
}
