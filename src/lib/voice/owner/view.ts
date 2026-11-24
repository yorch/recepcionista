/** What the dashboard sees of an owner knowledge change: no raw patch, no previous values. */
import type { OwnerKbChange, OwnerKbSource, OwnerKbStatus } from '@/lib/types';

export interface PublicKbChange {
  id: string;
  source: OwnerKbSource;
  status: OwnerKbStatus;
  summary: string;
  touches: string[];
  created_at: string;
  applied_at: string | null;
  reverted_at: string | null;
  call_id: string | null;
}

export const publicKbChange = (c: OwnerKbChange): PublicKbChange => ({
  id: c.id, source: c.source, status: c.status, summary: c.summary, touches: Object.keys(c.patch ?? {}),
  created_at: c.created_at, applied_at: c.applied_at, reverted_at: c.reverted_at, call_id: c.call_id,
});
