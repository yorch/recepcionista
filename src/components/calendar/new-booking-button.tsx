'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { useT } from '@/lib/i18n/client';
import { BookingFormDialog } from './booking-form-dialog';

/** "New booking" for the agenda tab (the calendar has its own button and prefills from a clicked slot). Refreshes the server-rendered list after a create. */
export function NewBookingButton({ businessId, tz, today }: { businessId: string; tz: string; today: string }) {
  const t = useT();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  return (
    <>
      <Button onClick={() => { setDone(null); setOpen(true); }}>{t('nb.button')}</Button>
      {done ? <p role="status" className="sr-only">{done}</p> : null}
      {open ? (
        <BookingFormDialog
          mode="create" tz={tz} businessId={businessId} prefill={{ date: today }} onClose={() => setOpen(false)}
          onCreated={() => { setOpen(false); setDone(t('nb.created')); router.refresh(); }}
        />
      ) : null}
    </>
  );
}
