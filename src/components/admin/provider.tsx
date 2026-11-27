'use client';
import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { useReauth } from '@/components/dashboard/reauth';
import { toast } from 'sonner';
import { useT } from '@/lib/i18n/client';
import { adminErrorText } from './errors';
import type { AdminRole, Permission } from '@/lib/admin/permissions';

export interface AdminMe {
  role: AdminRole;
  via: 'token' | 'cookie' | 'user' | 'dev';
  email: string | null;
  twoFactor: boolean;
  permissions: Permission[];
  sudoAt: string | null;
  frozen: boolean;
  frozenByEnv: boolean;
}

interface Ctx {
  me: AdminMe;
  can: (p: Permission) => boolean;
  /** Run a write; a `reauth_required` answer opens the step-up panel and retries the action once after the proof. */
  guard: (action: () => Promise<void>) => Promise<void>;
  setFrozen: (frozen: boolean) => void;
}

const AdminContext = createContext<Ctx | null>(null);

export function AdminProvider({ me: initial, children }: { me: AdminMe; children: React.ReactNode }) {
  const t = useT();
  const [me, setMe] = useState(initial);
  const { guard: baseGuard, panel } = useReauth((err) => toast.error(adminErrorText(t, err)));
  // A write that went through (directly or after the step-up panel) proves the session is within the 5 minute window: the shell's indicator follows it.
  const guard = useCallback((action: () => Promise<void>) => baseGuard(async () => {
    await action();
    setMe((m) => (m.via === 'token' || m.via === 'dev' ? m : { ...m, sudoAt: new Date().toISOString() }));
  }), [baseGuard]);
  const can = useCallback((p: Permission) => me.permissions.includes(p), [me.permissions]);
  const setFrozen = useCallback((frozen: boolean) => setMe((m) => ({ ...m, frozen })), []);
  const value = useMemo<Ctx>(() => ({ me, can, guard, setFrozen }), [me, can, guard, setFrozen]);
  return <AdminContext.Provider value={value}>{children}{panel ? <div className="fixed inset-x-4 bottom-4 z-[60] flex justify-center sm:justify-end">{panel}</div> : null}</AdminContext.Provider>;
}

export function useAdmin(): Ctx {
  const c = useContext(AdminContext);
  if (!c) throw new Error('useAdmin outside AdminProvider');
  return c;
}
