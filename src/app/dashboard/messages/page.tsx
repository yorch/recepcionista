import type { Metadata } from 'next';
import Link from 'next/link';
import { getDashboardContext } from '@/lib/dashboard-context';
import { getT } from '@/lib/i18n/server';
import { PageHeader } from '@/components/ui/page-header';
import { cn } from '@/components/ui/cn';
import { MessagesInbox } from '@/components/dashboard/messages-inbox';
import { MessagesLog } from '@/components/dashboard/messages-log';
import { MessagesSend } from '@/components/dashboard/messages-send';
import { getInboxPage, getMessageLog } from '@/lib/messaging/inbox-view';
import { tzOf } from '@/lib/time';
import { INBOUND_STATUSES, type InboundStatus } from '@/lib/types';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())('msg.title') };
}

export const dynamic = 'force-dynamic';

const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);
const TABS = ['inbox', 'new', 'log'] as const;
type Tab = (typeof TABS)[number];

/** The business's messages: the inbox of customer texts, a manual text form and the text log. Owner and staff of this business. */
export default async function MessagesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const t = await getT();
  const ctx = await getDashboardContext();
  const biz = ctx.business;
  const q = await searchParams;
  const rawTab = one(q.tab);
  const tab: Tab = (TABS as readonly string[]).includes(rawTab ?? '') ? (rawTab as Tab) : 'inbox';
  const rawStatus = one(q.status);
  const filter: InboundStatus | 'all' = rawStatus === 'all' ? 'all' : (INBOUND_STATUSES as readonly string[]).includes(rawStatus ?? '') ? (rawStatus as InboundStatus) : 'new';

  const tabClass = (active: boolean) => cn('inline-flex min-h-11 items-center rounded-xl px-4 text-[13px] font-medium', active ? 'bg-raised text-white' : 'text-mute hover:bg-hover hover:text-soft');
  const tz = tzOf(biz);

  let body: React.ReactNode;
  if (tab === 'new') body = <MessagesSend businessId={biz.id} />;
  else if (tab === 'log') body = <MessagesLog businessId={biz.id} tz={tz} initial={await getMessageLog(biz.id, { direction: 'out', limit: 25 })} />;
  else {
    const initial = await getInboxPage(biz.id, { status: filter === 'all' ? undefined : filter, limit: 25 });
    body = <MessagesInbox businessId={biz.id} tz={tz} initial={initial} initialFilter={filter} />;
  }

  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 sm:py-8">
      <PageHeader
        title={t('msg.title')}
        subtitle={t('msg.subtitle')}
        right={
          <nav aria-label={t('msg.tabsLabel')} className="inline-flex flex-wrap gap-1 rounded-2xl border border-line p-1">
            {TABS.map((id) => (
              <Link key={id} href={id === 'inbox' ? '/dashboard/messages' : `/dashboard/messages?tab=${id}`} aria-current={tab === id ? 'page' : undefined} className={tabClass(tab === id)}>
                {t(`msg.tab.${id}` as const)}
              </Link>
            ))}
          </nav>
        }
      />
      <div className="mt-6">{body}</div>
    </main>
  );
}
