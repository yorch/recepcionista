'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/components/ui/cn';

const NAV = [
  { href: '/dashboard', label: 'Today', icon: 'M3 10.5 12 3l9 7.5M5 9.5V21h5v-6h4v6h5V9.5' },
  { href: '/dashboard/calls', label: 'Calls', icon: 'M4 5c0 8 6 14 14 14l1.5-3.2-3.5-1.8-2 2C11 15 9 13 8 10l2-2-1.8-3.5L5 4' },
  { href: '/dashboard/bookings', label: 'Calendar', icon: 'M4 6h16v14H4zM4 10h16M9 3v4M15 3v4' },
  { href: '/dashboard/knowledge', label: 'Brain', icon: 'M9 4a3 3 0 0 0-3 3 3 3 0 0 0-1 5.8A3 3 0 0 0 8 18a3 3 0 0 0 4 2m0-16a3 3 0 0 1 3 3 3 3 0 0 1 1 5.8A3 3 0 0 1 16 18a3 3 0 0 1-4 2m0-16v16' },
  { href: '/dashboard/briefings', label: 'Briefings', icon: 'M4 13a8 8 0 1 0 16 0 8 8 0 0 0-16 0Zm4-2v4m4-7v10m4-7v4' },
  { href: '/dashboard/demo', label: 'Demo console', icon: 'M9 3h6l1 4h3v14H5V7h3l1-4Zm0 10h6m-3-3v6' },
] as const;

async function logout() {
  try {
    await fetch('/api/auth/logout', { method: 'POST' });
  } finally {
    window.location.href = '/login';
  }
}

export function Sidebar({ businessName, phone, live }: { businessName: string; phone?: string | null; live: boolean }) {
  const path = usePathname();
  return (
    <aside className="hidden w-[248px] shrink-0 flex-col border-r border-[#171f2a] bg-[#080b10]/70 px-4 py-5 lg:flex">
      <Link href="/dashboard" className="flex items-center gap-2.5 px-2">
        <span className="grid h-8 w-8 place-items-center rounded-lg bg-[#ff6b35] text-[15px] font-bold text-[#150800]">R</span>
        <span className="text-[15px] font-semibold tracking-tight">Recepcionista</span>
      </Link>

      <div className="mt-6 rounded-xl border border-[#1b2430] bg-[#0b1017] p-3">
        <p className="truncate text-[13px] font-medium text-white">{businessName}</p>
        <div className="mt-1.5 flex items-center gap-1.5">
          <span className={cn('h-1.5 w-1.5 rounded-full', live ? 'bg-[#3ddc97] live-dot' : 'bg-[#5a6b80]')} />
          <span className="text-[11px] text-[#8b98ab]">{live ? 'Answering calls' : 'Not live'}</span>
        </div>
        <a
          href={`tel:${process.env.NEXT_PUBLIC_ELEVENLABS_PHONE_NUMBER || ''}`}
          className="mt-2 flex items-center gap-2 rounded-lg border border-[#1c4635] px-2.5 py-1.5 font-mono text-[12px] text-[#6ee7b0] hover:border-[#3ddc97] transition-colors"
        >
          <span className="h-1.5 w-1.5 rounded-full bg-[#3ddc97]" />
          {process.env.NEXT_PUBLIC_ELEVENLABS_PHONE_NUMBER || phone || '—'}
        </a>
      </div>

      <nav className="mt-6 flex flex-col gap-0.5">
        {NAV.map((item) => {
          const active = path === item.href || (item.href !== '/dashboard' && path.startsWith(item.href));
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                'flex items-center gap-3 rounded-lg px-3 py-2 text-[13px] transition-colors',
                active ? 'bg-[#161e29] text-white' : 'text-[#8b98ab] hover:bg-[#111823] hover:text-[#cbd7e6]',
              )}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d={item.icon} />
              </svg>
              {item.label}
            </Link>
          );
        })}
      </nav>

      <button
        type="button"
        onClick={logout}
        className="mt-auto flex items-center gap-3 rounded-lg px-3 py-2 text-left text-[13px] text-[#8b98ab] transition-colors hover:bg-[#111823] hover:text-[#cbd7e6]"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M9 4H5v16h4M16 8l4 4-4 4M20 12H9" />
        </svg>
        Log out
      </button>

      <div className="mt-3 rounded-xl border border-[#1b2430] bg-[#0b1017] p-3">
        <p className="text-[11px] font-medium text-[#cbd7e6]">Bilingual by default</p>
        <p className="mt-1 text-[11px] leading-relaxed text-[#6b7b91]">
          English, Spanish, or both in the same sentence. She follows the caller.
        </p>
      </div>
    </aside>
  );
}
