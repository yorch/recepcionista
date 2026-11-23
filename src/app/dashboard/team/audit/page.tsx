import type { Metadata } from 'next';
import Link from 'next/link';
import { Card, CardHead } from '@/components/ui/card';
import { getDashboardContext, requireRolePage } from '@/lib/dashboard-context';
import { listAuditEvents } from '@/lib/db';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Activity log' };

const PAGE = 50;

/** Owners see their business's events; admins see the selected business, or everything with ?all=1. Staff get a 404. */
export default async function AuditPage({ searchParams }: { searchParams: Promise<{ before?: string; all?: string }> }) {
  const ctx = await getDashboardContext();
  requireRolePage(ctx, 'owner');
  const sp = await searchParams;
  const before = sp.before && !Number.isNaN(new Date(sp.before).getTime()) ? sp.before : undefined;
  const all = ctx.role === 'admin' && sp.all === '1';
  const rows = await listAuditEvents({ business_id: all ? undefined : ctx.business.id, before, limit: PAGE + 1 });
  const events = rows.slice(0, PAGE);
  const nextBefore = rows.length > PAGE ? events[events.length - 1].at : null;
  const qs = (b: string) => `?before=${encodeURIComponent(b)}${all ? '&all=1' : ''}`;
  return (
    <main className="mx-auto w-full max-w-4xl px-6 py-8">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[24px] font-semibold tracking-[-0.02em]">Activity log</h1>
          <p className="mt-1 text-[13px] text-[#8b98ab]">Sign-ins, security changes and team changes for {all ? 'all businesses' : ctx.business.name}.</p>
        </div>
        <nav className="flex gap-4 text-[13px] text-[#ffb08a]">
          {ctx.role === 'admin' ? <Link href={all ? '/dashboard/team/audit' : '/dashboard/team/audit?all=1'} className="hover:underline">{all ? 'This business only' : 'All businesses'}</Link> : null}
          <Link href="/dashboard/team" className="hover:underline">Back to team</Link>
        </nav>
      </header>
      <Card className="mt-6">
        <CardHead title="Events" subtitle="Newest first" />
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-[13px]">
            <caption className="sr-only">Audit events</caption>
            <thead className="text-[12px] text-[#8b98ab]">
              <tr><th scope="col" className="px-5 py-2 font-medium">When</th><th scope="col" className="px-2 py-2 font-medium">Action</th><th scope="col" className="px-2 py-2 font-medium">Target</th><th scope="col" className="px-2 py-2 font-medium">From</th></tr>
            </thead>
            <tbody className="divide-y divide-[#1f2937]">
              {events.length === 0 ? <tr><td colSpan={4} className="px-5 py-4 text-[#8b98ab]">No events yet.</td></tr> : null}
              {events.map((e) => (
                <tr key={e.id}>
                  <td className="whitespace-nowrap px-5 py-2 text-[#a8b6c8]">{new Date(e.at).toLocaleString()}</td>
                  <td className="px-2 py-2 font-mono text-white">{e.action}</td>
                  <td className="max-w-[16rem] truncate px-2 py-2 text-[#a8b6c8]">{e.target}</td>
                  <td className="px-2 py-2 text-[#8b98ab]">{e.ip ?? '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      <p className="mt-4 flex justify-between text-[13px]">
        {before ? <Link href={all ? '/dashboard/team/audit?all=1' : '/dashboard/team/audit'} className="text-[#ffb08a] hover:underline">Newest</Link> : <span />}
        {nextBefore ? <Link href={qs(nextBefore)} className="text-[#ffb08a] hover:underline">Older</Link> : null}
      </p>
    </main>
  );
}
