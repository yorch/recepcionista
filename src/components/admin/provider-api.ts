import { apiRequest } from '@/hooks/use-api';
import type { SettingView, SecretInfo, Preview, SettingChange } from '@/lib/admin/settings-store';
import type { ProviderTestResult } from '@/lib/admin/provider-tests';
import type { FollowUpState, TestId } from '@/lib/admin/provider-meta';
import type { BatchPage } from '@/lib/admin/provider-ui';

/** Types and calls of the providers page. Only TYPES come from the server modules (nothing server-only is bundled). */
export type { SettingView, SecretInfo, Preview, SettingChange, ProviderTestResult };

export interface SettingsListing { version: number; frozen: { frozen: boolean; by_env: boolean }; settings: SettingView[] }

export interface WebhookInfo { id: string; card: string; path: string; url: string | null; secret_key: string | null; verifier_configured: boolean | null }
export interface ProvidersInfo {
  base_url: string | null;
  base_url_pinned: boolean;
  webhooks: WebhookInfo[];
  google_redirect: { url: string | null; overridden: boolean };
  usage: { numbers: number; agents: number; stripe_customers: number; messaging_service: boolean };
  stripe_mode: 'live' | 'test' | null;
  follow_ups: FollowUpState[];
}

export interface LiveCard {
  provider: string; ready: boolean; missing: string[]; tested: boolean;
  test: ProviderTestResult | null;
}
export interface LiveSelftest { providers: LiveCard[]; ready: boolean; tested: boolean }

export interface SystemInfo {
  keys: { current_kid: string; previous_kid: string | null } | null;
  loader: { canary?: string; ignored_rows?: number; needs_reencrypt?: boolean };
  reencrypt: ReencryptStatus | null;
}
export interface ReencryptStatus {
  settings: { remaining: number; failed?: number; done?: number }; revisions: { remaining: number; failed?: number; done?: number };
  totp: { remaining: number; failed?: number; done?: number }; calendar_tokens: { remaining: number; failed?: number; done?: number };
  done: boolean; next_cursor?: string | null;
}

export const testCandidate = (provider: TestId, candidate?: Record<string, string>): Promise<ProviderTestResult> =>
  apiRequest<ProviderTestResult>(`/api/admin/providers/${provider}/test`, { method: 'POST', body: candidate ? { candidate } : {}, timeoutMs: 40_000 });

export const previewChanges = (changes: SettingChange[]): Promise<Preview> => apiRequest<Preview>('/api/admin/settings/preview', { method: 'POST', body: { changes } });

export const applyChanges = (body: { changes: SettingChange[]; reason?: string; confirm?: string; expected_version?: number }): Promise<unknown> =>
  apiRequest('/api/admin/settings/apply', { method: 'POST', body });

export const putSecret = (key: string, body: { value: string; paired?: Record<string, string>; reason?: string; confirm?: string; acknowledge_orphans?: boolean; accept_unreachable?: boolean }): Promise<unknown> =>
  apiRequest(`/api/admin/secrets/${encodeURIComponent(key)}`, { method: 'PUT', body, timeoutMs: 60_000 });

export const deleteSecret = (key: string, body: { reason: string; confirm?: string }): Promise<unknown> =>
  apiRequest(`/api/admin/secrets/${encodeURIComponent(key)}`, { method: 'DELETE', body });

export const batchCall = (action: 'resync_agents' | 'repair_numbers', body: Record<string, unknown>): Promise<BatchPage & { dry_run: boolean; tools?: string[] }> =>
  apiRequest(action === 'resync_agents' ? '/api/admin/resync-agents' : '/api/admin/repair-numbers', { method: 'POST', body, timeoutMs: 120_000 });

export const reencrypt = (body: { reason: string; cursor?: string | null }): Promise<ReencryptStatus> =>
  apiRequest<ReencryptStatus>('/api/admin/secrets/reencrypt', { method: 'POST', body, timeoutMs: 120_000 });
