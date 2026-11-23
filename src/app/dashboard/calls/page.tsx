import { listCalls } from '@/lib/db';
import { getDashboardContext } from '@/lib/dashboard-context';
import { hasRole } from '@/lib/session';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty';
import { PageHeader } from '@/components/ui/page-header';
import { relative, seconds } from '@/lib/format';

export const dynamic = 'force-dynamic';

const LANG_LABEL: Record<string, string> = { en: 'English', es: 'Español', mixed: 'Spanglish' };
const LANG_TONE: Record<string, string> = { en: 'neutral', es: 'brand', mixed: 'sky' };

export default async function CallsPage() {
  const ctx = await getDashboardContext();
  const biz = ctx.business;
  const calls = await listCalls(biz.id);
  const isOwner = hasRole(ctx.principal, 'owner');

  return (
    <main className="mx-auto w-full max-w-4xl px-4 py-6 sm:px-6 sm:py-8">
      <PageHeader
        title="Calls"
        subtitle="Every conversation, transcribed and triaged."
        right={<span className="text-xs text-dim">{calls.length} total</span>}
      />

      <ul className="mt-6 flex flex-col gap-3">
        {calls.map((c) => (
          <li key={c.id}>
            <Card className="p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex items-start gap-3">
                  <div aria-hidden="true" className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-raised text-xs font-medium text-body">
                    {(c.caller_name ?? c.caller_phone ?? '?').slice(0, 2).toUpperCase()}
                  </div>
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="text-[13.5px] font-medium text-white">{c.caller_name ?? 'Unknown caller'}</h2>
                      <Badge tone={LANG_TONE[c.language ?? 'en']}>{LANG_LABEL[c.language ?? 'en']}</Badge>
                      {c.urgency !== 'routine' ? <Badge tone={c.urgency}>{c.urgency}</Badge> : null}
                    </div>
                    <p className="mt-0.5 font-mono text-xs text-dim">
                      {c.caller_phone} · {relative(c.started_at)} · {seconds(c.duration_sec)}
                    </p>
                  </div>
                </div>
                {c.flagged_reason ? (
                  <span className="rounded-lg border border-warn-line bg-warn-bg px-2.5 py-1 text-xs text-warn">needs you</span>
                ) : (
                  <span className="rounded-lg border border-mint-line bg-mint-bg px-2.5 py-1 text-xs text-mint-text">handled</span>
                )}
              </div>

              {c.summary ? <p className="mt-3 text-[13px] leading-relaxed text-body">{c.summary}</p> : null}

              {c.flagged_reason ? (
                <p className="mt-2 rounded-lg bg-[#1a1208] px-3 py-2 text-xs text-warn">{c.flagged_reason}</p>
              ) : null}

              {c.transcript ? (
                <details className="group mt-3">
                  <summary className="inline-flex min-h-11 cursor-pointer list-none items-center text-xs text-dim transition-colors hover:text-brand-soft">
                    <span className="group-open:hidden">Show transcript ▾</span>
                    <span className="hidden group-open:inline">Hide transcript ▴</span>
                  </summary>
                  <p className="mt-2 max-h-48 overflow-y-auto rounded-lg bg-sunken p-3.5 text-xs leading-relaxed text-mute">
                    {c.transcript}
                  </p>
                </details>
              ) : null}
            </Card>
          </li>
        ))}
      </ul>
      {calls.length === 0 ? (
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
