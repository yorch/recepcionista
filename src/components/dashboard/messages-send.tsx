'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardHead } from '@/components/ui/card';
import { TextAreaField, TextField } from '@/components/ui/field';
import { apiRequest } from '@/hooks/use-api';
import { useT } from '@/lib/i18n/client';
import { MANUAL_TEXT_MAX } from '@/lib/messaging/manual-limits';
import { messageErrorText } from '@/components/dashboard/messages-shared';

/** A manual text to one known customer (booking, call or earlier message). The server enforces the rules; this form only reports them. */
export function MessagesSend({ businessId }: { businessId: string }) {
  const t = useT();
  const router = useRouter();
  const [to, setTo] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await apiRequest(`/api/businesses/${businessId}/messages/send`, { method: 'POST', body: { to, body } });
      toast.success(t('msg.new.sent'));
      setBody('');
      router.refresh();
    } catch (err) {
      setError(messageErrorText(t, err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="max-w-xl">
      <CardHead title={t('msg.new.title')} subtitle={t('msg.new.sub')} />
      <form onSubmit={submit} className="flex flex-col gap-4 p-4">
        <TextField label={t('msg.new.to')} hint={t('msg.new.toHint')} type="tel" inputMode="tel" autoComplete="off" value={to} onChange={(e) => setTo(e.target.value)} required />
        <TextAreaField
          label={t('msg.new.body')} rows={4} maxLength={MANUAL_TEXT_MAX} value={body} onChange={(e) => setBody(e.target.value)} required
          hint={`${t('msg.reply.hint')} ${t('msg.reply.counter', { count: [...body].length, max: MANUAL_TEXT_MAX })}`}
          error={error}
        />
        <div><Button type="submit" disabled={busy || !to.trim() || !body.trim()}>{busy ? t('msg.reply.sending') : t('msg.new.send')}</Button></div>
      </form>
    </Card>
  );
}
