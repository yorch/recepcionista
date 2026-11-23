/** Data-subject access: everything stored about one customer (phone's last 10 digits) of one business. */
import { prisma } from '@/lib/db';
import { locateCustomerRecords } from '@/lib/db/compliance';
import { phoneKey } from '@/lib/format';

export interface CustomerExport {
  business_id: string;
  phone_key: string;
  exported_at: string;
  calls: unknown[];
  bookings: unknown[];
  /** Texts to the customer and owner alerts / other texts that mention them. */
  sms: unknown[];
  /** Evening briefings (narration + stats) that cover a day the customer appears in, or mention them. */
  briefings: unknown[];
  sms_opted_out: boolean;
}

export async function exportCustomerData(businessId: string, phone: string): Promise<CustomerExport> {
  const key = phoneKey(phone);
  if (!key || key.length < 7) throw new Error('phone must have at least 7 digits');
  const [rec, optOut] = await Promise.all([
    locateCustomerRecords(prisma, businessId, key),
    prisma.smsOptOut.findUnique({ where: { businessId_phoneKey: { businessId, phoneKey: key } }, select: { id: true } }),
  ]);
  const [calls, bookings, sms, briefings] = await Promise.all([
    prisma.call.findMany({ where: { id: { in: rec.callIds } }, orderBy: { startedAt: 'asc' } }),
    prisma.booking.findMany({ where: { id: { in: rec.bookingIds } }, orderBy: { scheduledAt: 'asc' } }),
    prisma.smsLog.findMany({ where: { id: { in: rec.smsIds } }, orderBy: { createdAt: 'asc' } }),
    prisma.briefing.findMany({ where: { id: { in: rec.briefingIds } }, orderBy: { date: 'asc' } }),
  ]);
  return {
    business_id: businessId,
    phone_key: key,
    exported_at: new Date().toISOString(),
    calls, bookings, sms, briefings,
    sms_opted_out: optOut !== null,
  };
}
