'use client';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { TextAreaField } from '@/components/ui/field';
import { ApiError, apiRequest } from '@/hooks/use-api';
import { POLICY_LABEL } from '@/lib/refunds';
import { REFUND_POLICIES, REFUND_POLICY_TEXT_MAX, type RefundPolicy } from '@/lib/types';

/** Deposit refund policy: a choice the app uses to decide what it OFFERS on a cancellation, plus free text customers can read. */
export function RefundPolicySettings({ businessId, initialPolicy, initialText }: { businessId: string; initialPolicy: RefundPolicy; initialText: string }) {
  const [policy, setPolicy] = useState<RefundPolicy>(initialPolicy);
  const [text, setText] = useState(initialText);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      await apiRequest(`/api/businesses/${businessId}/refund-policy`, { method: 'PUT', body: { refund_policy: policy, refund_policy_text: text.trim() ? text : null } });
      toast.success('Refund policy saved.');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not save.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <label htmlFor="refund-policy-select" className="block text-xs font-medium uppercase tracking-wider text-dim">When a cancelled booking&apos;s deposit is refundable</label>
        <select id="refund-policy-select" value={policy} onChange={(e) => setPolicy(e.target.value as RefundPolicy)} className="mt-1.5 min-h-11 w-full max-w-md rounded-xl border border-line-3 bg-sunken px-3 text-[15px] text-white sm:text-sm">
          {REFUND_POLICIES.map((p) => <option key={p} value={p}>{POLICY_LABEL[p]}</option>)}
        </select>
        <p className="mt-1.5 text-xs text-dim">The app uses this to offer a refund when you cancel, and to tell customers. It never refunds by itself; you always confirm, and you can refund against the policy.</p>
      </div>
      <TextAreaField
        label="Your policy in your own words" optional rows={4} maxLength={REFUND_POLICY_TEXT_MAX} value={text} onChange={(e) => setText(e.target.value)}
        hint={`${text.length}/${REFUND_POLICY_TEXT_MAX}. Shown to customers on the payment page. Plain text only.`}
      />
      <div className="flex"><Button onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save policy'}</Button></div>
    </div>
  );
}
