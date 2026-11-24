import type { Metadata } from 'next';
import Link from 'next/link';
import { Logo } from '@/components/ui/logo';

/**
 * Public, static explanation of how deposits and refunds work on this platform. It describes what the software does; it is NOT legal
 * advice and states nothing about any one business's terms (each business sets its own refund policy, shown on its payment page).
 * The operator must review this text (and have counsel review it where required) before launch: see docs/refunds.md.
 */
export const metadata: Metadata = {
  title: 'Deposits and refunds',
  description: 'How booking deposits and refunds work when a business uses Recepcionista.',
  alternates: { canonical: '/refunds' },
};

export default function RefundsPage() {
  return (
    <div className="mx-auto flex min-h-screen w-full max-w-3xl flex-col px-4 py-6 sm:px-6 sm:py-8">
      <header><Logo /></header>
      <main id="main-content" className="mt-10 text-[15px] leading-relaxed text-body">
        <h1 className="text-[28px] font-semibold tracking-[-0.02em] text-white">Deposits and refunds</h1>
        <p className="mt-3 text-mute">How a booking deposit works when you book with a business that uses Recepcionista, the AI receptionist.</p>

        <h2 className="mt-8 text-[18px] font-semibold text-white">Who you are paying</h2>
        <p className="mt-2">A deposit is a payment to the business you booked with, not to Recepcionista. The business is named on the payment page and in the text message that carried the link. Card payments are processed by Stripe; the card number is typed into Stripe&apos;s page and is never taken over the phone or stored by the receptionist.</p>

        <h2 className="mt-8 text-[18px] font-semibold text-white">The business sets its own refund policy</h2>
        <p className="mt-2">Each business chooses whether a cancelled booking&apos;s deposit is refunded: never, in full if you cancel at least 24 or 48 hours before the appointment, or always. That policy is shown on the payment page and summarised in the payment text. If you cancel, the confirmation text tells you what the policy says about your deposit.</p>

        <h2 className="mt-8 text-[18px] font-semibold text-white">How a refund happens</h2>
        <ul className="mt-2 list-disc space-y-1.5 pl-5">
          <li>Cancelling a booking does not refund it automatically. The business owner reviews the cancellation and issues the refund from their dashboard; they may refund all of the deposit or part of it, and may refund even when their policy would not require it.</li>
          <li>Refunds go back to the card that paid. After the business issues it, your bank usually shows it within 5 to 10 business days; the timing is up to your bank.</li>
          <li>If the business issues a refund you are sent a text message saying so (unless you opted out of texts).</li>
          <li>If you moved or cancelled by phone, the receptionist can tell you what the business&apos;s policy says, but it cannot promise a refund: the owner decides.</li>
        </ul>

        <h2 className="mt-8 text-[18px] font-semibold text-white">Questions or disputes</h2>
        <p className="mt-2">Contact the business directly: call the number you booked with. If you dispute the charge with your card issuer, the business is notified and can respond through Stripe. Reply STOP to any text to stop receiving texts from a business.</p>

        <h2 className="mt-8 text-[18px] font-semibold text-white">The Recepcionista subscription</h2>
        <p className="mt-2">Businesses pay Recepcionista a subscription, billed separately through Stripe and managed from the Billing page of their dashboard. It is unrelated to customer deposits.</p>

        <p className="mt-10 text-xs text-dim">This page describes how the software behaves. It is general information, not legal advice, and does not replace the terms a business gives you.</p>
      </main>
      <footer className="mt-auto pt-12 text-xs text-dim"><Link href="/" className="inline-flex min-h-11 items-center hover:text-soft">Back to home</Link></footer>
    </div>
  );
}
