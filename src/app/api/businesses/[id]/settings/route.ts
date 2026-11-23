import { fail, ok, readJson } from '@/lib/http';
import { authenticate, authErrorResponse, requireBusinessAccess } from '@/lib/session';
import { getBusiness, updateBusiness } from '@/lib/db';
import { cleanDisclosure, MAX_DISCLOSURE_LENGTH } from '@/lib/kb/disclosure';

export const dynamic = 'force-dynamic';

export interface BusinessSettings {
  retention_days: number;
  recording_disclosure_text: string | null;
  timezone: string;
}

const view = (b: { retention_days?: number; recording_disclosure_text?: string | null; timezone?: string }): BusinessSettings => ({
  retention_days: b.retention_days ?? 365,
  recording_disclosure_text: b.recording_disclosure_text ?? null,
  timezone: b.timezone ?? 'America/New_York',
});

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticate(req); // staff+ may read their own business's settings
  if (!auth.ok) return auth.response;
  try {
    const { id } = await params;
    requireBusinessAccess(auth.principal, id);
    const business = await getBusiness(id);
    if (!business) return fail('business not found', 404);
    return ok(view(business));
  } catch (err) {
    return authErrorResponse(err) ?? fail(err, 500);
  }
}

/** Only retention_days and recording_disclosure_text are editable here (timezone is display-only). */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticate(req, { role: 'owner' }); // only owners/admins change retention and disclosure
  if (!auth.ok) return auth.response;
  try {
    const { id } = await params;
    requireBusinessAccess(auth.principal, id);
    const body = await readJson<Record<string, unknown>>(req);
    if (!body || typeof body !== 'object' || Array.isArray(body)) return fail('invalid body', 422);
    const patch: { retention_days?: number; recording_disclosure_text?: string | null } = {};
    for (const [key, value] of Object.entries(body)) {
      if (key === 'retention_days') {
        if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 3650) {
          return fail('retention_days must be a whole number from 1 to 3650', 422);
        }
        patch.retention_days = value;
      } else if (key === 'recording_disclosure_text') {
        if (value === null || (typeof value === 'string' && value.trim() === '')) {
          patch.recording_disclosure_text = null; // back to the default
        } else if (typeof value !== 'string' || value.trim().length > MAX_DISCLOSURE_LENGTH) {
          return fail(`recording_disclosure_text must be at most ${MAX_DISCLOSURE_LENGTH} characters`, 422);
        } else {
          patch.recording_disclosure_text = cleanDisclosure(value);
        }
      } else {
        return fail(`field "${key}" cannot be updated here`, 422);
      }
    }
    if (Object.keys(patch).length === 0) return fail('nothing to update', 422);
    const updated = await updateBusiness(id, patch);
    if (!updated) return fail('business not found', 404);
    return ok(view(updated));
  } catch (err) {
    return authErrorResponse(err) ?? fail(err, 500);
  }
}
