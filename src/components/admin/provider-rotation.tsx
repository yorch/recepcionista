'use client';
import { useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHead } from '@/components/ui/card';
import { useT } from '@/lib/i18n/client';
import type { MessageKey } from '@/lib/i18n/core';
import { TextAreaField } from '@/components/ui/field';
import { adminErrorText } from './errors';
import { useAdmin } from './provider';
import { reencrypt, type ReencryptStatus, type SystemInfo } from './provider-api';

/**
 * APP_SECRET_KEY rotation: the key id in use, whether APP_SECRET_KEY_PREVIOUS is present, the canary, what is still under an older key, and "Re-encrypt all" that loops
 * the server batches (`next_cursor`) with progress until everything is under the current key. The env steps (set the new key, remove the old one) stay with the operator.
 */
export function KeyRotationPanel({ system, onDone }: { system: SystemInfo | null; onDone: () => void }) {
  const t = useT();
  const { can, guard, me } = useAdmin();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [batches, setBatches] = useState(0);
  const [live, setLive] = useState<ReencryptStatus | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [finished, setFinished] = useState(false);

  const status = live ?? system?.reencrypt ?? null;
  const keys = system?.keys ?? null;
  const canary = system?.loader?.canary ?? null;
  const remaining = status ? status.settings.remaining + status.revisions.remaining + status.totp.remaining + status.calendar_tokens.remaining : 0;
  const failedRows = status ? (status.settings.failed ?? 0) + (status.revisions.failed ?? 0) + (status.totp.failed ?? 0) + (status.calendar_tokens.failed ?? 0) : 0;
  const mayRun = can('settings.secrets.write') && !me.frozen;
  const reasonOk = reason.trim().length >= 8;

  async function run() {
    if (busy || !mayRun || !reasonOk) return;
    setBusy(true); setError(null); setBatches(0); setFinished(false);
    try {
      await guard(async () => {
        let cursor: string | null = null;
        for (let i = 0; i < 1000; i++) {
          const r: ReencryptStatus = await reencrypt({ reason: reason.trim(), cursor });
          setLive(r); setBatches(i + 1);
          if (r.done || !r.next_cursor || r.next_cursor === cursor) { setFinished(r.done); break; }
          cursor = r.next_cursor;
        }
      });
      toast.success(t('ap.rot.finished'));
      onDone();
    } catch (err) { setError(err); } finally { setBusy(false); }
  }

  return (
    <Card>
      <CardHead title={t('ap.rot.title')} subtitle={t('ap.rot.sub')} />
      <div className="flex flex-col gap-4 p-5">
        {!keys ? <p className="text-[13px] text-dim">{t('ap.rot.unavailable')}</p> : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone="sky"><span className="font-mono">{t('ap.rot.keyId', { kid: keys.current_kid })}</span></Badge>
              <Badge tone={keys.previous_kid ? 'unsure' : 'neutral'}>{keys.previous_kid ? t('ap.rot.prevPresent', { kid: keys.previous_kid }) : t('ap.rot.prevAbsent')}</Badge>
              <Badge tone={canary === 'ok' ? 'routine' : canary === 'failed' ? 'emergency' : 'neutral'}>{`${t('ap.rot.canary')}: ${t(canary === 'ok' ? 'ap.rot.canary.ok' : canary === 'failed' ? 'ap.rot.canary.failed' : 'ap.rot.canary.unknown')}`}</Badge>
            </div>
            <ol className="list-decimal space-y-1 pl-5 text-[13px] text-soft">
              {(['ap.rot.step1', 'ap.rot.step2', 'ap.rot.step3'] as MessageKey[]).map((k) => <li key={k}>{t(k)}</li>)}
            </ol>
            {status ? (
              <p className="text-[13px] text-soft" role="status">
                {remaining === 0 ? t('ap.rot.allCurrent') : t('ap.rot.remaining', { settings: status.settings.remaining, revisions: status.revisions.remaining, totp: status.totp.remaining, calendar: status.calendar_tokens.remaining })}
              </p>
            ) : null}
            {remaining > 0 && !keys.previous_kid ? <p className="text-[13px] text-warn">{t('ap.rot.needsPrev')}</p> : null}
            {failedRows > 0 ? <p className="text-[13px] text-danger" role="alert">{t('ap.rot.failedRows', { n: failedRows })}</p> : null}
            {mayRun ? (
              <div className="flex max-w-xl flex-col gap-3">
                <TextAreaField label={t('ap.rot.reasonLabel')} rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
                <div className="flex flex-wrap items-center gap-3">
                  <Button disabled={busy || !reasonOk || remaining === 0} onClick={() => void run()}>{busy ? t('ap.rot.running') : t('ap.rot.start')}</Button>
                  {batches > 0 ? <span className="text-xs text-dim" aria-live="polite">{t('ap.rot.progress', { n: batches })}</span> : null}
                </div>
              </div>
            ) : <p className="text-xs text-dim">{t('ap.rot.noPermission')}</p>}
            {finished ? <p className="text-[13px] text-mint-text" role="status">{t('ap.rot.finished')}</p> : null}
            {error ? <p role="alert" className="text-[13px] text-danger">{adminErrorText(t, error)}</p> : null}
          </>
        )}
      </div>
    </Card>
  );
}
