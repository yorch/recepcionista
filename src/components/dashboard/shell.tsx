'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { cn } from '@/components/ui/cn';
import { Logo } from '@/components/ui/logo';

interface NavItem {
  href: string;
  label: string;
  icon: string;
  /** Minimum role to see the link (server pages still enforce it). */
  gate?: 'owner' | 'admin';
}

const NAV: NavItem[] = [
  { href: '/dashboard', label: 'Today', icon: 'M3 10.5 12 3l9 7.5M5 9.5V21h5v-6h4v6h5V9.5' },
  { href: '/dashboard/calls', label: 'Calls', icon: 'M4 5c0 8 6 14 14 14l1.5-3.2-3.5-1.8-2 2C11 15 9 13 8 10l2-2-1.8-3.5L5 4' },
  { href: '/dashboard/bookings', label: 'Calendar', icon: 'M4 6h16v14H4zM4 10h16M9 3v4M15 3v4' },
  { href: '/dashboard/knowledge', label: 'Brain', icon: 'M9 4a3 3 0 0 0-3 3 3 3 0 0 0-1 5.8A3 3 0 0 0 8 18a3 3 0 0 0 4 2m0-16a3 3 0 0 1 3 3 3 3 0 0 1 1 5.8A3 3 0 0 1 16 18a3 3 0 0 1-4 2m0-16v16' },
  { href: '/dashboard/briefings', label: 'Briefings', icon: 'M4 13a8 8 0 1 0 16 0 8 8 0 0 0-16 0Zm4-2v4m4-7v10m4-7v4' },
  { href: '/dashboard/team', label: 'Team', icon: 'M16 11a3 3 0 1 0-6 0 3 3 0 0 0 6 0ZM5 20a7 7 0 0 1 14 0M19 8a2.5 2.5 0 0 1 0 5M5 8a2.5 2.5 0 0 0 0 5', gate: 'owner' },
  { href: '/dashboard/billing', label: 'Billing', icon: 'M3 7h18v12H3zM3 11h18M7 16h3', gate: 'owner' },
  { href: '/dashboard/security', label: 'Security', icon: 'M12 3 5 6v5c0 4.5 3 8 7 10 4-2 7-5.5 7-10V6l-7-3Zm-2.5 9 2 2 3.5-4', },
  { href: '/dashboard/settings', label: 'Settings', icon: 'M4 7h10m4 0h2M4 17h2m4 0h10M14 4v6m-4 4v6', gate: 'owner' },
  { href: '/dashboard/demo', label: 'Demo console', icon: 'M9 3h6l1 4h3v14H5V7h3l1-4Zm0 10h6m-3-3v6', gate: 'admin' },
];

const BUSINESS_COOKIE = 'rc_business';

export interface SidebarProps {
  businessName: string;
  /** The business's own (provisioned) number; null until provisioned. */
  phone?: string | null;
  live: boolean;
  /** Short status shown next to the green dot while live ('Answering calls', 'Paused', 'Forwarding calls'). */
  statusText?: string;
  /** Signed-in user's email (or "admin token"). */
  who: string;
  role: 'staff' | 'owner' | 'admin';
  isAdmin: boolean;
  /** owner or admin: may see Team / Billing / Settings and finish onboarding. */
  isOwner: boolean;
  currentBusinessId: string;
  /** Admin only: every business for the switcher. */
  businesses: { id: string; name: string }[];
}

const FOCUSABLE = 'a[href], button:not([disabled]), select, input, textarea, [tabindex]:not([tabindex="-1"])';

function Icon({ d }: { d: string }) {
  return (
    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  );
}

export function Sidebar(props: SidebarProps) {
  const { businessName, live, statusText = 'Answering calls' } = props;
  const path = usePathname();
  // `open` remembers the path it was opened on, so navigating closes the drawer without an effect.
  const [openAt, setOpenAt] = useState<string | null>(null);
  const open = openAt === path;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => {
    setOpenAt(null);
    triggerRef.current?.focus();
  }, []);

  // Drawer behaviour: focus trap, Escape, scroll lock, focus the first control.
  useEffect(() => {
    if (!open) return;
    const root = drawerRef.current;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    root?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
        return;
      }
      if (e.key !== 'Tab' || !root) return;
      const items = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null);
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      document.removeEventListener('keydown', onKey);
    };
  }, [open, close]);

  return (
    <>
      {/* Mobile top bar (below lg) */}
      <header className="sticky top-0 z-30 flex items-center justify-between gap-3 border-b border-[#171f2a] bg-ink/90 px-4 backdrop-blur lg:hidden">
        <div className="flex min-w-0 items-center gap-3">
          <Logo href="/dashboard" label="Recepcionista" className="[&>span:last-child]:sr-only" />
          <div className="min-w-0">
            <p className="truncate text-[13px] font-medium text-white">{businessName}</p>
            <p className="flex items-center gap-1.5 text-xs text-mute">
              <span aria-hidden="true" className={cn('h-1.5 w-1.5 rounded-full', live ? (statusText === 'Answering calls' ? 'bg-mint' : 'bg-warn') : 'bg-dim')} />
              {live ? statusText : 'Not live'}
            </p>
          </div>
        </div>
        <button
          ref={triggerRef}
          type="button"
          onClick={() => setOpenAt(path)}
          aria-label="Open menu"
          aria-expanded={open}
          aria-controls="mobile-nav"
          className="grid h-11 w-11 shrink-0 place-items-center rounded-xl border border-line-3 text-soft hover:bg-panel-2"
        >
          <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
            <path d="M4 7h16M4 12h16M4 17h16" />
          </svg>
        </button>
      </header>

      {open ? (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 bg-black/60" onClick={close} aria-hidden="true" />
          <div
            id="mobile-nav"
            ref={drawerRef}
            role="dialog"
            aria-modal="true"
            aria-label="Main menu"
            className="absolute inset-y-0 left-0 flex w-[min(86vw,320px)] flex-col overflow-y-auto border-r border-[#171f2a] bg-sunken px-4 py-4"
          >
            <div className="flex items-center justify-between">
              <Logo href="/dashboard" />
              <button
                type="button"
                onClick={close}
                aria-label="Close menu"
                className="grid h-11 w-11 place-items-center rounded-xl text-soft hover:bg-raised"
              >
                <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                  <path d="M6 6l12 12M18 6 6 18" />
                </svg>
              </button>
            </div>
            <SidebarBody {...props} path={path} />
          </div>
        </div>
      ) : null}

      {/* Desktop sidebar */}
      <aside aria-label="Sidebar" className="hidden w-[248px] shrink-0 flex-col border-r border-[#171f2a] bg-sunken/70 px-4 py-5 lg:flex lg:sticky lg:top-0 lg:h-screen lg:overflow-y-auto">
        <Logo href="/dashboard" className="px-2" />
        <SidebarBody {...props} path={path} />
      </aside>
    </>
  );
}

function SidebarBody({
  businessName, phone, live, statusText = 'Answering calls', who, role, isAdmin, isOwner, currentBusinessId, businesses, path,
}: SidebarProps & { path: string }) {
  const router = useRouter();
  const gates = { owner: isOwner, admin: isAdmin };

  async function logout() {
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } finally {
      router.push('/login');
      router.refresh();
    }
  }

  function switchBusiness(id: string) {
    // UI preference only: the server re-validates it against the real business list on every render.
    document.cookie = `${BUSINESS_COOKIE}=${encodeURIComponent(id)}; path=/; max-age=${60 * 60 * 24 * 30}; samesite=lax`;
    router.refresh();
  }

  return (
    <>
      <div className="mt-5 rounded-xl border border-[#1b2430] bg-[#0b1017] p-3">
        {isAdmin && businesses.length > 1 ? (
          <select
            aria-label="Switch business"
            value={currentBusinessId}
            onChange={(e) => switchBusiness(e.target.value)}
            className="mb-2 min-h-11 w-full rounded-lg border border-[#1b2430] bg-sunken px-2 py-1 text-[13px] text-soft lg:min-h-9"
          >
            {businesses.map((b) => (
              <option key={b.id} value={b.id}>{b.name}</option>
            ))}
          </select>
        ) : null}
        <p className="truncate text-[13px] font-medium text-white">{businessName}</p>
        <div className="mt-1.5 flex items-center gap-1.5">
          <span aria-hidden="true" className={cn('h-1.5 w-1.5 rounded-full', live ? (statusText === 'Answering calls' ? 'bg-mint live-dot' : 'bg-warn') : 'bg-dim')} />
          <span className="text-xs text-mute">{live ? statusText : 'Not live yet'}</span>
        </div>
        {phone ? (
          <a
            href={`tel:${phone}`}
            aria-label={`Call your front desk line, ${phone}`}
            className="mt-2 flex min-h-11 items-center gap-2 rounded-lg border border-mint-line px-2.5 py-1.5 font-mono text-[12px] text-mint-text transition-colors hover:border-mint lg:min-h-9"
          >
            <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-mint" />
            {phone}
          </a>
        ) : isOwner ? (
          <Link
            href="/onboarding"
            className="mt-2 flex min-h-11 items-center justify-center rounded-lg bg-brand px-2.5 py-1.5 text-[13px] font-semibold text-on-brand hover:bg-brand-hover lg:min-h-9"
          >
            Finish setup
          </Link>
        ) : (
          <p className="mt-2 text-xs text-dim">No number yet</p>
        )}
      </div>

      <nav aria-label="Dashboard" className="mt-5 flex flex-col gap-0.5">
        {NAV.filter((item) => !item.gate || gates[item.gate]).map((item) => {
          const active = path === item.href || (item.href !== '/dashboard' && path.startsWith(item.href));
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'flex min-h-11 items-center gap-3 rounded-lg px-3 py-2 text-[14px] transition-colors lg:min-h-9 lg:text-[13px]',
                active ? 'bg-raised text-white' : 'text-mute hover:bg-hover hover:text-soft',
              )}
            >
              <Icon d={item.icon} />
              {item.label}
            </Link>
          );
        })}
      </nav>

      <div className="mt-auto px-3 pb-1 pt-5 text-xs leading-tight">
        <p className="truncate text-soft" title={who}>{who}</p>
        <p className="mt-0.5 uppercase tracking-wider text-dim">{role}</p>
      </div>
      <button
        type="button"
        onClick={logout}
        className="mt-1 flex min-h-11 items-center gap-3 rounded-lg px-3 py-2 text-left text-[14px] text-mute transition-colors hover:bg-hover hover:text-soft lg:min-h-9 lg:text-[13px]"
      >
        <Icon d="M9 4H5v16h4M16 8l4 4-4 4M20 12H9" />
        Log out
      </button>

      <div className="mt-3 rounded-xl border border-[#1b2430] bg-[#0b1017] p-3">
        <p className="text-xs font-medium text-soft">Bilingual by default</p>
        <p className="mt-1 text-xs leading-relaxed text-dim">
          English, Spanish, or both in the same sentence. She follows the caller.
        </p>
      </div>
    </>
  );
}
