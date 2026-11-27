'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/components/ui/cn';
import { LocaleSwitcher } from '@/components/ui/locale-switcher';
import { Logo } from '@/components/ui/logo';
import { useT } from '@/lib/i18n/client';
import type { MessageKey } from '@/lib/i18n/core';
import { ADMIN_NAV, ADMIN_NAV_GROUPS } from './nav';
import { AdminProvider, useAdmin, type AdminMe } from './provider';

const STEP_UP_MS = 5 * 60_000;

function Icon({ d }: { d: string }) {
  return (
    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d={d} /></svg>
  );
}

/** The console's own chrome: a distinct top bar and banner (you are NOT in a business's dashboard), a sidebar built from ADMIN_NAV by permission, and the session state. */
export function AdminShell({ me, maintenance, children }: { me: AdminMe; maintenance: boolean; children: React.ReactNode }) {
  return (
    <AdminProvider me={me}>
      <Chrome maintenance={maintenance}>{children}</Chrome>
    </AdminProvider>
  );
}

function StepUpState() {
  const t = useT();
  const { me } = useAdmin();
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const first = setTimeout(() => setNow(Date.now()), 0);
    const id = setInterval(() => setNow(Date.now()), 15_000);
    return () => { clearTimeout(first); clearInterval(id); };
  }, []);
  if (me.via === 'token' || me.via === 'dev') return <span>{t('ac.session.bearer')}</span>;
  if (now === null) return null;
  const left = me.sudoAt ? new Date(me.sudoAt).getTime() + STEP_UP_MS - now : 0;
  return left > 0 ? <span>{t('ac.session.stepUpOk', { minutes: Math.max(1, Math.ceil(left / 60_000)) })}</span> : <span>{t('ac.session.stepUpNeeded')}</span>;
}

function Chrome({ maintenance, children }: { maintenance: boolean; children: React.ReactNode }) {
  const t = useT();
  const { me, can } = useAdmin();
  const path = usePathname();
  const router = useRouter();
  const [openAt, setOpenAt] = useState<string | null>(null);
  const open = openAt === path;
  const writer = can('settings.write');

  async function logout() {
    try { await fetch('/api/auth/logout', { method: 'POST' }); } finally { router.push('/login'); router.refresh(); }
  }

  const items = ADMIN_NAV.filter((i) => !i.permission || can(i.permission));
  const nav = (
    <nav aria-label={t('ac.shell.nav')} className="flex flex-col gap-4">
      {ADMIN_NAV_GROUPS.map((g) => {
        const list = items.filter((i) => i.group === g.id);
        if (!list.length) return null;
        return (
          <div key={g.id}>
            <p className="px-3 text-[11px] font-medium uppercase tracking-wider text-dim">{t(g.label)}</p>
            <ul className="mt-1 flex flex-col gap-0.5">
              {list.map((i) => {
                const active = i.exact ? path === i.href : path === i.href || path.startsWith(`${i.href}/`);
                return (
                  <li key={i.href}>
                    <Link
                      href={i.href} aria-current={active ? 'page' : undefined}
                      className={cn('flex min-h-11 items-center gap-3 rounded-lg px-3 py-2 text-[14px] transition-colors lg:min-h-9 lg:text-[13px]', active ? 'bg-raised text-white' : 'text-mute hover:bg-hover hover:text-soft')}
                    >
                      <Icon d={i.icon} />{t(i.label)}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </nav>
  );

  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-30 border-b border-warn-line bg-ink/95 backdrop-blur">
        <div className="flex min-h-14 flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2 sm:px-6">
          <Logo href="/admin" label="Recepcionista" className="[&>span:last-child]:sr-only sm:[&>span:last-child]:not-sr-only" />
          <Badge tone="unsure" className="uppercase tracking-wider">{t('ac.shell.console')}</Badge>
          <button
            type="button" aria-expanded={open} aria-controls="admin-nav" onClick={() => setOpenAt(open ? null : path)}
            className="ml-auto grid h-11 w-11 place-items-center rounded-xl border border-line-3 text-soft hover:bg-panel-2 lg:hidden"
          >
            <span className="sr-only">{t('ac.shell.menu')}</span>
            <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M4 7h16M4 12h16M4 17h16" /></svg>
          </button>
          <div className="ml-auto hidden flex-wrap items-center gap-x-4 gap-y-1 text-xs text-dim lg:flex">
            <Badge tone="brand">{t(`ac.role.${me.role}` as MessageKey)}</Badge>
            <span className="max-w-[16rem] truncate text-soft" title={me.email ?? undefined}>{me.email ?? t('ac.session.token')}</span>
            <span>{me.twoFactor ? t('ac.session.twoFactorOn') : me.via === 'token' || me.via === 'cookie' ? t('ac.session.twoFactorNone') : t('ac.session.twoFactorOff')}</span>
            <StepUpState />
            <LocaleSwitcher compact />
            <Link href="/dashboard" className="inline-flex min-h-9 items-center text-brand-soft hover:underline">{t('ac.shell.toDashboard')}</Link>
            <button type="button" onClick={logout} className="inline-flex min-h-9 items-center text-mute hover:text-soft">{t('shell.logout')}</button>
          </div>
        </div>
        <p className={cn('px-4 py-1.5 text-center text-[12px] sm:px-6', writer ? 'bg-warn-bg text-warn' : 'bg-sky-bg text-sky-text')} role="note">
          {writer ? t('ac.shell.editingBanner') : t('ac.shell.readOnlyBanner')}
        </p>
        {me.frozen ? <p role="status" className="bg-danger-bg px-4 py-1.5 text-center text-[12px] font-medium text-danger sm:px-6">{me.frozenByEnv ? t('ac.shell.frozenEnvBanner') : t('ac.shell.frozenBanner')}</p> : null}
        {maintenance ? <p role="status" className="bg-brand-bg px-4 py-1.5 text-center text-[12px] font-medium text-[#ffb08a] sm:px-6">{t('ac.shell.maintenanceBanner')}</p> : null}
      </header>

      <div className="flex min-w-0 flex-1 flex-col lg:flex-row">
        {open ? (
          <div id="admin-nav" className="border-b border-line bg-sunken px-4 py-3 lg:hidden">
            <div className="mb-3 flex flex-wrap items-center gap-3 text-xs text-dim">
              <Badge tone="brand">{t(`ac.role.${me.role}` as MessageKey)}</Badge>
              <span className="truncate text-soft">{me.email ?? t('ac.session.token')}</span>
              <StepUpState />
            </div>
            {nav}
            <div className="mt-3 flex flex-wrap items-center gap-4 text-xs">
              <LocaleSwitcher compact />
              <Link href="/dashboard" className="inline-flex min-h-11 items-center text-brand-soft hover:underline">{t('ac.shell.toDashboard')}</Link>
              <button type="button" onClick={logout} className="inline-flex min-h-11 items-center text-mute hover:text-soft">{t('shell.logout')}</button>
            </div>
          </div>
        ) : null}
        <aside className="hidden w-[248px] shrink-0 border-r border-line bg-sunken/70 px-3 py-5 lg:sticky lg:top-[88px] lg:block lg:h-[calc(100vh-88px)] lg:overflow-y-auto">{nav}</aside>
        <main id="main-content" tabIndex={-1} className="mx-auto w-full min-w-0 max-w-5xl flex-1 px-4 py-6 outline-none sm:px-6 sm:py-8">{children}</main>
      </div>
    </div>
  );
}
