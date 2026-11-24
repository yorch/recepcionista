'use client';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import type { ApiResult } from '@/lib/types';

/** Starts Checkout / opens the Customer Portal and navigates the browser to the URL Stripe returned. */
export function BillingActions({
  businessId, mode,
}: {
  businessId: string;
  /** 'start' = no plan yet (or canceled): Checkout. 'manage' = has a Stripe customer: Portal. */
  mode: 'start' | 'manage';
}) {
  const [busy, setBusy] = useState(false);
  const label = mode === 'start' ? 'Start free trial' : 'Manage billing';

  async function go() {
    setBusy(true);
    try {
      const res = await fetch(mode === 'start' ? '/api/billing/checkout' : '/api/billing/portal', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ business_id: businessId }),
      });
      const json = (await res.json()) as ApiResult<{ url: string }>;
      if (!json.ok) throw new Error(json.error === 'email_not_verified' ? 'Confirm your email address first, then try again.' : json.error);
      window.location.assign(json.data.url);
    } catch (err) {
      toast.error((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <Button onClick={go} disabled={busy} aria-busy={busy} className="min-h-11 w-full sm:w-auto">
      {busy ? 'Redirecting…' : label}
    </Button>
  );
}
