/** Data-subject access: everything stored about one customer (phone's last 10 digits) of one business. */
import { prisma } from '@/lib/db';
import { phoneKey } from '@/lib/format';

export interface CustomerExport {
  business_id: string;
  phone_key: string;
  exported_at: string;
  calls: unknown[];
  bookings: unknown[];
  sms: unknown[];
  sms_opted_out: boolean;
}

export async function exportCustomerData(businessId: string, phone: string): Promise<CustomerExport> {
  const key = phoneKey(phone);
  if (!key || key.length < 7) throw new Error('phone must have at least 7 digits');
  const [callIds, bookingIds, smsIds, optOut] = await Promise.all([
    prisma.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "calls" WHERE "business_id" = ${businessId}
         AND right(regexp_replace(coalesce("caller_phone", ''), '[^0-9]', '', 'g'), 10) = ${key}`,
    prisma.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "bookings" WHERE "business_id" = ${businessId}
         AND (right(regexp_replace("customer_phone", '[^0-9]', '', 'g'), 10) = ${key}
              OR "call_id" IN (SELECT "id" FROM "calls" WHERE "business_id" = ${businessId}
                   AND right(regexp_replace(coalesce("caller_phone", ''), '[^0-9]', '', 'g'), 10) = ${key}))`,
    prisma.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "sms_log" WHERE "business_id" = ${businessId}
         AND right(regexp_replace("to_phone", '[^0-9]', '', 'g'), 10) = ${key}`,
    prisma.smsOptOut.findUnique({ where: { businessId_phoneKey: { businessId, phoneKey: key } }, select: { id: true } }),
  ]);
  const [calls, bookings, sms] = await Promise.all([
    prisma.call.findMany({ where: { id: { in: callIds.map((r) => r.id) } }, orderBy: { startedAt: 'asc' } }),
    prisma.booking.findMany({ where: { id: { in: bookingIds.map((r) => r.id) } }, orderBy: { scheduledAt: 'asc' } }),
    prisma.smsLog.findMany({ where: { id: { in: smsIds.map((r) => r.id) } }, orderBy: { createdAt: 'asc' } }),
  ]);
  return {
    business_id: businessId,
    phone_key: key,
    exported_at: new Date().toISOString(),
    calls, bookings, sms,
    sms_opted_out: optOut !== null,
  };
}
