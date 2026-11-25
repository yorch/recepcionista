'use client';
import { useId, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { TextField } from '@/components/ui/field';
import { apiRequest } from '@/hooks/use-api';
import { errorText } from '@/lib/i18n/api-errors';
import { useT } from '@/lib/i18n/client';
import { useReauth } from '@/components/dashboard/reauth';
import { ERASE_CONFIRM_WORD } from '@/lib/messaging/privacy-words';

interface Lookup { phone_last4: string; calls: number; bookings: number; sms: number; inbound_messages: number; briefings: number; sms_opted_out: boolean }
interface Erased { calls: number; sms_logs: number; inbound_messages: number; bookings_anonymized: number }

/**
 * Owner-only privacy tools: look up one customer number (counts only), download everything stored about it as JSON, or erase it.
 * Download and erase need a fresh proof of identity (the server answers `reauth_required`, the panel asks once and retries) and an
 * erase needs the typed word. The number is posted in the body, never put in a URL.
 */
export function PrivacyTools({ businessId }: { businessId: string }) {
  const t = useT();
  const confirmId = useId();
  const [phone, setPhone] = useState('');
  const [found, setFound] = useState<Lookup | null>(null);
  const [busy, setBusy] = useState<'lookup' | 'export' | 'erase' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [word, setWord] = useState('');
  const reauth = useReauth((e) => setError(errorText(t, e)));
  const base = `/api/businesses/${businessId}/privacy`;

  async function lookup(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !phone.trim()) return;
    setBusy('lookup');
    setError(null);
    setFound(null);
    setConfirming(false);
    try {
      setFound(await apiRequest<Lookup>(`${base}/lookup`, { method: 'POST', body: { phone } }));
    } catch (err) {
      setError(errorText(t, err));
    } finally {
      setBusy(null);
    }
  }

  async function download() {
    setBusy('export');
    setError(null);
    try {
      await reauth.guard(async () => {
        const data = await apiRequest<unknown>(`${base}/export`, { method: 'POST', body: { phone } });
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `customer-data-${found?.phone_last4 ?? 'export'}.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
        toast.success(t('pv.exported'));
      });
    } catch (err) {
      setError(errorText(t, err));
    } finally {
      setBusy(null);
    }
  }

  async function erase() {
    if (word !== ERASE_CONFIRM_WORD) return;
    setBusy('erase');
    setError(null);
    try {
      await reauth.guard(async () => {
        const r = await apiRequest<Erased>(`${base}/erase`, { method: 'POST', body: { phone, confirm: word } });
        toast.success(t('pv.erased', { calls: r.calls, sms: r.sms_logs, inbound: r.inbound_messages, bookings: r.bookings_anonymized }));
        setFound(null);
        setConfirming(false);
        setWord('');
        setPhone('');
      });
    } catch (err) {
      setError(errorText(t, err));
    } finally {
      setBusy(null);
    }
  }

  const empty = found && found.calls + found.bookings + found.sms + found.inbound_messages + found.briefings === 0;

  return (
    <div className="flex flex-col gap-4">
      <form onSubmit={lookup} className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <TextField className="flex-1" label={t('pv.phone')} hint={t('pv.phoneHint')} type="tel" inputMode="tel" autoComplete="off" value={phone} onChange={(e) => { setPhone(e.target.value); setFound(null); setConfirming(false); }} />
        <Button type="submit" variant="outline" disabled={busy !== null || !phone.trim()}>{busy === 'lookup' ? t('pv.looking') : t('pv.lookup')}</Button>
      </form>

      {found ? (
        <div role="status" className="rounded-xl border border-line bg-sunken p-4 text-[13px] text-body">
          <p>{empty ? t('pv.none', { last4: found.phone_last4 }) : t('pv.found', { last4: found.phone_last4, calls: found.calls, bookings: found.bookings, sms: found.sms, inbound: found.inbound_messages, briefings: found.briefings })}</p>
          {found.sms_opted_out ? <p className="mt-1 text-xs text-dim">{t('pv.optedOut')}</p> : null}
          {!empty ? (
            <div className="mt-3 flex flex-wrap gap-2">
              <Button variant="outline" disabled={busy !== null} onClick={() => void download()}>{busy === 'export' ? t('pv.exporting') : t('pv.export')}</Button>
              <Button variant="danger" disabled={busy !== null} onClick={() => setConfirming(true)}>{t('pv.erase')}</Button>
            </div>
          ) : null}
        </div>
      ) : null}

      {confirming ? (
        <div role="group" aria-labelledby={`${confirmId}-t`} className="rounded-xl border border-danger-line bg-danger-bg p-4">
          <h3 id={`${confirmId}-t`} className="text-[13px] font-semibold text-danger">{t('pv.eraseTitle')}</h3>
          <p className="mt-1 text-xs leading-relaxed text-body">{t('pv.eraseWarn')}</p>
          <TextField className="mt-3 max-w-xs" label={t('pv.eraseType', { word: ERASE_CONFIRM_WORD })} autoComplete="off" autoCapitalize="characters" spellCheck={false} value={word} onChange={(e) => setWord(e.target.value)} />
          <div className="mt-3 flex flex-wrap gap-2">
            <Button variant="danger" disabled={busy !== null || word !== ERASE_CONFIRM_WORD} onClick={() => void erase()}>{busy === 'erase' ? t('pv.erasing') : t('pv.eraseConfirm')}</Button>
            <Button variant="ghost" disabled={busy !== null} onClick={() => { setConfirming(false); setWord(''); }}>{t('pv.cancel')}</Button>
          </div>
        </div>
      ) : null}

      {error ? <p role="alert" className="text-xs text-danger">{error}</p> : null}
      {reauth.panel}
    </div>
  );
}
