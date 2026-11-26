import { fail, ok, readJson } from '@/lib/http';
import { authenticate, authErrorResponse, requireBusinessAccess } from '@/lib/session';
import { countryForBusiness, getBusiness } from '@/lib/db';
import { exportCustomerData } from '@/lib/privacy';
import { checkPhone, privacyBudget } from '@/lib/messaging/privacy-api';

export const dynamic = 'force-dynamic';

export interface PrivacyLookup { phone_last4: string; calls: number; bookings: number; sms: number; inbound_messages: number; briefings: number; sms_opted_out: boolean }

/** POST { phone }  How much is stored about one customer number (counts only, no content). Owner only. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticate(req, { role: 'owner' });
  if (!auth.ok) return auth.response;
  try {
    const { id } = await params;
    requireBusinessAccess(auth.principal, id);
    const business = await getBusiness(id);
    if (!business) return fail('business not found', 404);
    const body = await readJson<{ phone?: unknown }>(req);
    const phone = checkPhone(business, body?.phone);
    if (!phone.ok) return phone.response;
    const limited = await privacyBudget(id, 'lookup');
    if (limited) return limited;
    const data = await exportCustomerData(id, phone.e164, countryForBusiness(business));
    return ok<PrivacyLookup>({
      phone_last4: phone.last4, calls: data.calls.length, bookings: data.bookings.length, sms: data.sms.length,
      inbound_messages: data.inbound_messages.length, briefings: data.briefings.length, sms_opted_out: data.sms_opted_out,
    });
  } catch (err) {
    return authErrorResponse(err) ?? fail(err, 500);
  }
}
