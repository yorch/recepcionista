import { Badge, type BadgeTone } from '@/components/ui/badge';
import { Card, CardHead } from '@/components/ui/card';
import { relative } from '@/lib/format';
import type { Locale, MessageKey, TFunction } from '@/lib/i18n/core';
import type { PublicOwnerReply, PublicReplyStatus } from '@/lib/voice/owner/reply-view';

const TONE: Record<PublicReplyStatus, BadgeTone> = { waiting: 'unsure', sending: 'unsure', uncertain: 'emergency', sent: 'routine', cancelled: 'neutral', expired: 'neutral', refused: 'emergency', failed: 'emergency' };

/**
 * "Owner voice replies": texts the owner asked the assistant to send to a customer from the private owner line, and what became of each
 * (sent, cancelled, expired, refused). Read-only: a reply is confirmed by the owner's YES text, never from here.
 */
export function OwnerReplies({ items, nowMs, locale, t }: { items: PublicOwnerReply[]; nowMs: number; locale: Locale; t: TFunction }) {
  return (
    <Card>
      <CardHead title={t('orp.title')} subtitle={t('orp.subtitle')} />
      {items.length === 0 ? (
        <p className="px-5 py-4 text-[13px] text-dim">{t('orp.empty')}</p>
      ) : (
        <ul className="divide-y divide-[#171f2a]">
          {items.map((r) => (
            <li key={r.id} className="flex flex-wrap items-start justify-between gap-3 px-5 py-3">
              <div className="min-w-0 flex-1">
                <p className="break-words text-[13px] text-white">{`\u201c${r.body}\u201d`}</p>
                <p className="mt-0.5 text-xs text-dim">
                  {t('orp.to', { who: r.to_name ?? t('orp.customer'), last4: r.to_last4 })} · <time dateTime={r.created_at}>{relative(r.created_at, nowMs, locale)}</time>
                  {r.reason ? ` · ${t(`orp.reason.${r.reason}` as MessageKey)}` : ''}
                </p>
              </div>
              <Badge tone={TONE[r.status]}>{t(`orp.status.${r.status}` as MessageKey)}</Badge>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
