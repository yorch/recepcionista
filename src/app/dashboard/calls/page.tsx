import type { Metadata } from 'next';
import { countCalls, getCall, listCallsPage } from '@/lib/db';
import { getDashboardContext } from '@/lib/dashboard-context';
import { hasRole } from '@/lib/session';
import { EmptyState } from '@/components/ui/empty';
import { PageHeader } from '@/components/ui/page-header';
import { CallsList } from '@/components/dashboard/calls-list';
import { VoicemailList } from '@/components/dashboard/voicemail-list';
import { publicCall } from '@/lib/voice/voicemail';
import { cn } from '@/components/ui/cn';
import Link from 'next/link';

export const metadata: Metadata = { title: 'Calls' };

export const dynamic = 'force-dynamic';

export default async function CallsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await getDashboardContext();
  const biz = ctx.business;
  const q = await searchParams;
  const callId = Array.isArray(q.call) ? q.call[0] : q.call;
  const tab = (Array.isArray(q.tab) ? q.tab[0] : q.tab) === 'voicemails' ? 'voicemails' : 'calls';
  const [page, total, linked, voicemails] = await Promise.all([
    listCallsPage(biz.id, { limit: 25 }),
    countCalls(biz.id),
    // A call opened from a booking: only ever one of THIS business's calls.
    callId ? getCall(callId) : Promise.resolve(null),
    // Voicemails left on a paused / forwarded line (audio plays through /api/calls/:id/voicemail, never from a provider URL).
    listCallsPage(biz.id, { limit: 25, voicemailOnly: true }),
  ]);
  const focus = linked && linked.business_id === biz.id ? publicCall(linked) : null;
  const isOwner = hasRole(ctx.principal, 'owner');
  const nowMs = new Date().getTime();
  const tabs = [
    { key: 'calls', label: 'All calls', href: '/dashboard/calls' },
    { key: 'voicemails', label: voicemails.items.length > 0 ? `Voicemails (${voicemails.next_cursor ? `${voicemails.items.length}+` : voicemails.items.length})` : 'Voicemails', href: '/dashboard/calls?tab=voicemails' },
  ] as const;

  return (
    <main className="mx-auto w-full max-w-4xl px-4 py-6 sm:px-6 sm:py-8">
      <PageHeader title="Calls" subtitle="Every conversation, transcribed and triaged." right={<span className="text-xs text-dim">{total} total</span>} />

      <nav aria-label="Calls views" className="mt-5 flex gap-1 border-b border-line-2">
        {tabs.map((t) => (
          <Link
            key={t.key} href={t.href} aria-current={tab === t.key ? 'page' : undefined}
            className={cn('inline-flex min-h-11 items-center border-b-2 px-3.5 text-[13px] font-medium transition-colors', tab === t.key ? 'border-brand text-white' : 'border-transparent text-mute hover:text-soft')}
          >
            {t.label}
          </Link>
        ))}
      </nav>

      {tab === 'voicemails' ? (
        voicemails.items.length > 0 ? (
          <VoicemailList businessId={biz.id} initial={{ items: voicemails.items.map(publicCall), next_cursor: voicemails.next_cursor }} nowMs={nowMs} retentionDays={biz.retention_days ?? 365} />
        ) : (
          <div className="mt-6">
            <EmptyState
              title="No voicemails"
              body="When calls are paused, or a forwarded call is not answered, callers can leave a message here. You will see who called, when, and can play it back and call them."
              cta={isOwner ? { href: '/dashboard/settings#call-handling', label: 'Call handling settings' } : undefined}
            />
          </div>
        )
      ) : (
        <CallsList businessId={biz.id} initial={{ items: page.items.map(publicCall), next_cursor: page.next_cursor }} nowMs={nowMs} focus={focus} />
      )}

      {tab === 'calls' && page.items.length === 0 && !focus ? (
        <div className="mt-6">
          <EmptyState
            title="No calls yet"
            body={biz.phone
              ? `Call ${biz.phone} from another phone to hear her answer. Real calls show up here with a transcript, summary and urgency.`
              : 'Your receptionist needs a phone number before she can take calls.'}
            cta={isOwner ? { href: '/onboarding', label: biz.phone ? 'Test call and call forwarding' : 'Finish setup' } : undefined}
            secondary={{ href: '/dashboard/knowledge', label: 'Review what she knows' }}
          />
        </div>
      ) : null}
    </main>
  );
}
