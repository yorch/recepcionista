'use client';
import { useCallback, useRef, useState } from 'react';
import { toast } from 'sonner';

/** Error from the API client; keeps the HTTP status so callers can react to 401/402/409/429. */
export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly payload?: unknown) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
  /** Abort (and report a friendly timeout) after this many ms. Default 30s. */
  timeoutMs?: number;
}

/**
 * fetch + JSON + the repo's `{ ok, data } | { ok: false, error }` envelope. Resolves with `data`
 * (or, for routes that answer a bare `{ ok: true, ...fields }`, the fields). Throws ApiError otherwise.
 */
export async function apiRequest<T = unknown>(path: string, opts: RequestOptions = {}): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 30_000);
  opts.signal?.addEventListener('abort', () => ctrl.abort(), { once: true });
  let res: Response;
  try {
    res = await fetch(path, {
      method: opts.method ?? (opts.body === undefined ? 'GET' : 'POST'),
      headers: opts.body === undefined ? undefined : { 'content-type': 'application/json' },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: ctrl.signal,
      cache: 'no-store',
    });
  } catch (err) {
    if (opts.signal?.aborted) throw err;
    if (ctrl.signal.aborted) throw new ApiError('That took too long. Check your connection and try again.', 0);
    throw new ApiError('Network error. Check your connection and try again.', 0);
  } finally {
    clearTimeout(timer);
  }
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    /* non-JSON body */
  }
  const j = (json ?? {}) as { ok?: boolean; data?: T; error?: string } & Record<string, unknown>;
  if (!res.ok || j.ok === false) {
    throw new ApiError(
      typeof j.error === 'string' && j.error ? j.error : `Request failed (${res.status})`,
      res.status,
      json,
    );
  }
  if ('data' in j) return j.data as T;
  const { ok: _ok, ...rest } = j;
  void _ok;
  return rest as T;
}

export interface CallOptions {
  /** Toast shown while running (loading), replaced by success/error. */
  loading?: string;
  success?: string | ((data: never) => string);
  /** false = do not toast the error (the caller renders it inline). */
  toastError?: boolean;
}

/**
 * The one fetch + toast pattern: tracks `busy`, toasts loading/success/error (success and failure
 * replace the loading toast), and resolves to the data or `undefined` on failure so call sites stay flat.
 * Pass `{ throws: true }` semantics via `request` when you want to handle ApiError yourself.
 */
export function useApi() {
  const [busy, setBusy] = useState(false);
  const inflight = useRef(0);

  const track = useCallback(async <T,>(fn: () => Promise<T>): Promise<T> => {
    inflight.current += 1;
    setBusy(true);
    try {
      return await fn();
    } finally {
      inflight.current -= 1;
      if (inflight.current === 0) setBusy(false);
    }
  }, []);

  /** Run a request; toast per `opts`; return data or undefined on error. */
  const call = useCallback(
    async <T,>(path: string, req: RequestOptions = {}, opts: CallOptions = {}): Promise<T | undefined> => {
      const id = opts.loading ? toast.loading(opts.loading) : undefined;
      try {
        const data = await track(() => apiRequest<T>(path, req));
        if (opts.success) {
          const msg = typeof opts.success === 'function' ? (opts.success as (d: T) => string)(data) : opts.success;
          toast.success(msg, id !== undefined ? { id } : undefined);
        } else if (id !== undefined) {
          toast.dismiss(id);
        }
        return data;
      } catch (err) {
        if (opts.toastError === false) {
          if (id !== undefined) toast.dismiss(id);
        } else {
          toast.error((err as Error).message, id !== undefined ? { id } : undefined);
        }
        return undefined;
      }
    },
    [track],
  );

  /** Like `call` but rethrows (no toasts): for flows that branch on ApiError.status. */
  const request = useCallback(<T,>(path: string, req: RequestOptions = {}) => track(() => apiRequest<T>(path, req)), [track]);

  return { busy, call, request };
}
