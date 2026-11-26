/** Data-subject access: everything stored about one customer (matched on their E.164 number) of one business. */
import { prisma, recordingDeletionStatus } from '@/lib/db';
import { isOptedOut, locateCustomerRecords, phoneIdent } from '@/lib/db/compliance';
import { defaultPhoneCountry } from '@/lib/phone';
import { parseRecordingUrl } from '@/lib/voice/voicemail';

export interface CustomerExport {
  business_id: string;
  /** The customer's number in E.164 (what the records were matched on). */
  phone_e164: string;
  exported_at: string;
  calls: unknown[];
  /** Live transcript rows (utterance by utterance) of those calls; empty for calls whose consent was declined. */
  transcript_events: unknown[];
  bookings: unknown[];
  /** Texts to the customer and owner alerts / other texts that mention them. */
  sms: unknown[];
  /** Evening briefings (narration + stats) that cover a day the customer appears in, or mention them. */
  briefings: unknown[];
  /** Texts the customer sent to the business (the owner's inbox). */
  inbound_messages: unknown[];
  sms_opted_out: boolean;
  /** Voicemail recordings of this business that were deleted here but whose provider-side deletion is still PENDING (retried automatically); 0 = nothing outstanding. */
  recording_deletions_pending: number;
}

export async function exportCustomerData(businessId: string, phone: string, country: string = defaultPhoneCountry()): Promise<CustomerExport> {
  const id = phoneIdent(phone, country);
  if (!id.e164) throw new Error('phone must be a valid number (use +country code for non-US numbers)');
  const [rec, optedOut] = await Promise.all([
    locateCustomerRecords(prisma, businessId, id, country),
    isOptedOut(businessId, id.e164),
  ]);
  const [calls, bookings, sms, briefings, events, inbound] = await Promise.all([
    prisma.call.findMany({ where: { id: { in: rec.callIds } }, orderBy: { startedAt: 'asc' } }),
    prisma.booking.findMany({ where: { id: { in: rec.bookingIds } }, orderBy: { scheduledAt: 'asc' } }),
    prisma.smsLog.findMany({ where: { id: { in: rec.smsIds } }, orderBy: { createdAt: 'asc' } }),
    prisma.briefing.findMany({ where: { id: { in: rec.briefingIds } }, orderBy: { date: 'asc' } }),
    prisma.callTranscriptEvent.findMany({ where: { callId: { in: rec.callIds } }, orderBy: [{ callId: 'asc' }, { seq: 'asc' }] }),
    prisma.inboundMessage.findMany({ where: { businessId, fromE164: id.e164 }, orderBy: { receivedAt: 'asc' } }),
  ]);
  return {
    business_id: businessId,
    phone_e164: id.e164,
    exported_at: new Date().toISOString(),
    // A voicemail is the customer's own recorded voice: the export says it exists and where the owner plays it back (the
    // authenticated proxy), never the credentialed provider URL.
    calls: calls.map(({ recordingUrl, ...c }) => ({
      ...c,
      voicemail: recordingUrl && parseRecordingUrl(recordingUrl) ? { available: true, playback_path: `/api/calls/${c.id}/voicemail`, seconds: c.durationSec ?? null } : null,
    })),
    transcript_events: events.map((e) => ({ call_id: e.callId, seq: e.seq, role: e.role, text: e.text, at: e.at.toISOString(), is_final: e.isFinal })),
    bookings, sms, briefings,
    inbound_messages: inbound,
    sms_opted_out: optedOut,
    recording_deletions_pending: (await recordingDeletionStatus(businessId)).pending,
  };
}
