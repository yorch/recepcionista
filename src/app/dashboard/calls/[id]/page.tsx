import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getCall, listTranscriptEventsAfter } from '@/lib/db';
import { getDashboardContext } from '@/lib/dashboard-context';
import { PageHeader } from '@/components/ui/page-header';
import { LiveCall } from '@/components/dashboard/live-call';
import { isLive } from '@/lib/voice/live-transcript';
import { RecordingPlayer } from '@/components/dashboard/recording-player';
import { callHasRecording } from '@/lib/voice/recording-audio';

export const metadata: Metadata = { title: 'Live call' };
export const dynamic = 'force-dynamic';

export default async function CallPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await getDashboardContext();
  const { id } = await params;
  const call = await getCall(id);
  if (!call || call.business_id !== ctx.business.id) notFound(); // another tenant's call is a 404, like a missing one
  const consented = call.consent_status === 'disclosed';
  const events = consented ? await listTranscriptEventsAfter(call.id, -1, 500, { businessId: ctx.business.id }) : [];
  const live = isLive(call) && consented;

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6 sm:py-8">
      <Link href="/dashboard/calls" className="inline-flex min-h-11 items-center text-[13px] text-mute hover:text-soft">← All calls</Link>
      <PageHeader title={live ? 'Live call' : 'Call'} subtitle={live ? 'The conversation as it happens. Lines appear a few seconds late and are replaced by the saved transcript afterwards.' : undefined} />
      {!live && callHasRecording(call) ? <RecordingPlayer callId={call.id} label={call.caller_name ?? call.caller_phone ?? 'caller'} /> : null}
      <div className="mt-5">
        {call.consent_status === 'declined' ? (
          <p className="rounded-lg bg-warn-bg px-3 py-2 text-[13px] text-warn">The caller asked not to be recorded or transcribed, so there is no transcript for this call.</p>
        ) : !consented && isLive(call) ? (
          <p className="rounded-lg bg-raised px-3 py-2 text-[13px] text-mute">A live transcript is only shown once it is confirmed the caller heard the recording notice. This call has not confirmed it yet.</p>
        ) : (
          <LiveCall callId={call.id} callerLabel={call.caller_name ?? call.caller_phone ?? 'Unknown caller'} initialEvents={events} initiallyLive={live} />
        )}
      </div>
    </main>
  );
}
