import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { getBooking, getBookingPaymentLinkId, getBusiness } from '@/lib/db';
import { demoModeEnabled } from '@/lib/auth';
import { lookupPaymentLink } from '@/lib/payments/link-lookup';
import { PayUnavailable } from './unavailable';
import Link from 'next/link';
import { Checkout } from './checkout';
import { policySentence } from '@/lib/refunds';
import type { Business } from '@/lib/types';
import { PaymentReceived } from './received';
import { LocaleSwitcher } from '@/components/ui/locale-switcher';
import { I18nProvider } from '@/lib/i18n/client';
import { MESSAGES, makeT } from '@/lib/i18n';
import { getCustomerLocale, getT } from '@/lib/i18n/server';
import { getCall } from '@/lib/db';
import type { Locale } from '@/lib/i18n/core';

/**
 * /pay/<bookingId>. PRODUCTION never renders a card form: a booking whose deposit link is still live is sent to Stripe's own page
 * (the link's `buy.stripe.com` URL, looked up on Stripe, cached briefly); an already-paid booking shows the receipt; anything else shows an
 * honest "this link is not available, call the business" page. The demo card form exists only outside production AND with DEMO_MODE=true.
 * The amount, description and business name come from the DATABASE, looked up by booking id, never from query params. The old
 * `mock_<random>` ids with query-param amounts remain for the local demo only (NODE_ENV !== 'production' and DEMO_MODE).
 *
 * Booking resolution: `/pay/<bookingId>` or `/pay/mock_x?booking=<bookingId>`.
 */
export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())('pay.metaTitle'), robots: { index: false, follow: false } };
}

export const dynamic = 'force-dynamic';

const DEFAULT_AMOUNT_CENTS = 18_900; // $189 — demo-only fallback
const MIN_DEMO_CENTS = 100;
const MAX_DEMO_CENTS = 50_000; // the $500 deposit cap
const DEFAULT_BUSINESS = 'Miami Cool Air Conditioning';

type Params = Promise<{ id: string }>;
type Search = Promise<Record<string, string | string[] | undefined>>;

/** The business's refund policy, in plain text (the free text is rendered as text, never as markup). */
function PolicyNote({ business, locale }: { business: Business | null; locale: Locale }) {
  if (!business) return null;
  const t = makeT(locale);
  return (
    <aside aria-label={t('pay.policyRegion')} className="mx-auto mt-4 w-full max-w-md px-4 pb-8 text-xs leading-relaxed text-dim">
      <p><strong className="text-soft">{t('pay.policyTitle')}</strong> {policySentence(business.refund_policy, locale)}</p>
      {business.refund_policy_text ? <p className="mt-1.5 whitespace-pre-line text-mute">{business.refund_policy_text}</p> : null}
      <p className="mt-1.5"><Link href="/refunds" className="underline underline-offset-2 hover:text-soft">{t('pay.howItWorks')}</Link></p>
    </aside>
  );
}

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** Demo-only: a bounded amount from the query string. Cents, or dollars if a decimal / < 100. */
function demoAmount(raw: string | undefined): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_AMOUNT_CENTS;
  const cents = Number.isInteger(n) && n >= 100 ? n : Math.round(n * 100);
  return Math.min(MAX_DEMO_CENTS, Math.max(MIN_DEMO_CENTS, cents));
}

export default async function PayPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: Search;
}) {
  const { id } = await params;
  const query = await searchParams;
  const isProd = process.env.NODE_ENV === 'production';
  const isMockId = id.startsWith('mock_');

  const bookingId = first(query.booking)?.trim() || (isMockId ? '' : id);
  const booking = bookingId ? await getBooking(bookingId).catch(() => null) : null;

  let amountCents: number;
  let label: string;
  let businessName: string;
  let policyBusiness: Business | null = null;
  // The customer's language: their own choice first, then the language of the call that booked the job, then the business default.
  const callLanguage = booking?.call_id ? (await getCall(booking.call_id).catch(() => null))?.language ?? null : null;
  const biz = booking ? await getBusiness(booking.business_id) : null;
  const locale = await getCustomerLocale({ callLanguage, business: biz?.locale_default });
  const t = makeT(locale);
  const scoped = (node: React.ReactNode) => (
    <I18nProvider locale={locale} messages={MESSAGES[locale]}>
      <div lang={locale} className="min-h-dvh">
        {node}
        <div className="mx-auto flex w-full max-w-md justify-center px-4 pb-8"><LocaleSwitcher compact /></div>
      </div>
    </I18nProvider>
  );

  const demoForm = !isProd && demoModeEnabled();

  if (booking) {
    const business = biz;
    policyBusiness = business;
    businessName = business?.name ?? t('pay.defaultProvider');
    label = t('pay.depositFor', { service: booking.service });
    const hasAmount = Boolean(booking.deposit_amount && booking.deposit_amount > 0);
    if (!hasAmount && !(demoForm && isMockId)) notFound();
    amountCents = hasAmount ? (booking.deposit_amount as number) : demoAmount(first(query.amount));
    if (booking.deposit_paid) {
      return scoped(
        <>
          <PaymentReceived reference={id} amountCents={amountCents} label={label} businessName={businessName} t={t} locale={locale} />
          <PolicyNote business={policyBusiness} locale={locale} />
        </>,
      );
    }
    if (!demoForm) {
      // No demo card form here. A live Stripe link: go there. Otherwise tell the customer plainly (never a fake payment page).
      if (booking.status !== 'cancelled') {
        const found = await lookupPaymentLink(await getBookingPaymentLinkId(booking.id).catch(() => null));
        if (found.state === 'active') redirect(found.url);
      }
      return scoped(<PayUnavailable businessName={businessName} businessPhone={business?.phone ?? null} t={t} />);
    }
  } else if (isMockId && demoForm) {
    // Local demo only: a bare mock link with no booking. Values are clamped and cosmetic.
    amountCents = demoAmount(first(query.amount));
    label = (first(query.for)?.trim() || t('pay.defaultLabel')).slice(0, 80);
    businessName = (first(query.business)?.trim() || DEFAULT_BUSINESS).slice(0, 60);
  } else {
    notFound();
  }

  return scoped(
    <>
      <Checkout
        reference={id}
        amountCents={amountCents}
        label={label}
        businessName={businessName}
        bookingId={booking?.id}
      />
      <PolicyNote business={policyBusiness} locale={locale} />
    </>,
  );
}
