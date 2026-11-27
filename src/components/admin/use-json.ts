'use client';
import { useCallback, useEffect, useState } from 'react';
import { apiRequest } from '@/hooks/use-api';

export interface JsonState<T> { data: T | null; error: unknown; loading: boolean; reload: () => void }

interface Settled<T> { token: string; data: T | null; error: unknown }

/**
 * GET a console JSON route: loading / error / data, `reload()` to refetch (the previous data stays visible while it reloads). A null `url` waits (nothing is
 * fetched). A response for a superseded request is ignored. `loading` is derived (the request in flight has not settled yet), never set from an effect.
 */
export function useJson<T>(url: string | null): JsonState<T> {
  const [tick, setTick] = useState(0);
  const [settled, setSettled] = useState<Settled<T> | null>(null);
  const token = url === null ? null : `${url}#${tick}`;
  useEffect(() => {
    if (url === null || token === null) return;
    const ctrl = new AbortController();
    apiRequest<T>(url, { signal: ctrl.signal })
      .then((data) => { if (!ctrl.signal.aborted) setSettled({ token, data, error: null }); })
      .catch((error) => { if (!ctrl.signal.aborted) setSettled((cur) => ({ token, data: cur?.data ?? null, error })); });
    return () => ctrl.abort();
  }, [url, token]);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  return { data: settled?.data ?? null, error: settled && settled.token === token ? settled.error : null, loading: token !== null && settled?.token !== token, reload };
}
