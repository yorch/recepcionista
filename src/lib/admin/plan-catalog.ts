/**
 * In-memory plan catalog: the `plans` table as the loader last read it. PURE and synchronous, because the cap helpers (smsCapFor ...) that read it are
 * synchronous. The catalog lives on globalThis (the proxy and route bundles load separate module copies). With no catalog installed (no console database,
 * unit tests) every lookup answers "unknown plan" and callers fall back to the platform settings: behaviour is identical to before the table existed.
 */
export interface PlanRow {
  key: string;
  name: string;
  public: boolean;
  is_comped: boolean;
  stripe_price_id: string | null;
  stripe_price_id_annual: string | null;
  trial_days: number | null;
  sms_cap: number | null;
  call_minutes_cap: number | null;
  voicemail_minutes_cap: number | null;
  forward_minutes_cap: number | null;
  max_locations: number | null;
  features: Record<string, boolean>;
  sort: number;
  archived_at: string | null;
}

/** Feature entitlements a plan can switch off (a missing key means ENABLED: plans start with {} and today's behaviour). */
export const PLAN_FEATURES = ['owner_callin', 'owner_reply', 'native_transfer', 'calendar_sync', 'deposits', 'multi_location', 'voicemail', 'call_forwarding'] as const;
export type PlanFeature = (typeof PLAN_FEATURES)[number];

const KEY = Symbol.for('rc.plan-catalog');
const store = (): { plans: Map<string, PlanRow> | null } => {
  const g = globalThis as unknown as Record<symbol, { plans: Map<string, PlanRow> | null } | undefined>;
  return (g[KEY] ??= { plans: null });
};

export function setPlanCatalog(rows: readonly PlanRow[] | null): void {
  store().plans = rows ? new Map(rows.map((r) => [r.key, r])) : null;
}
export const planCatalogLoaded = (): boolean => store().plans !== null;
export const planRow = (key: string | null | undefined): PlanRow | null => (key ? store().plans?.get(key) ?? null : null);
export const allPlanRows = (): PlanRow[] => [...(store().plans?.values() ?? [])].sort((a, b) => a.sort - b.sort || a.key.localeCompare(b.key));

/** Is this plan string an admin-comped plan? Catalog first; before it is loaded the historic list applies. */
export function isCompedPlan(key: string | null | undefined, fallback: readonly string[] = ['legacy', 'grandfathered']): boolean {
  if (!key) return false;
  const row = planRow(key);
  return row ? row.is_comped : fallback.includes(key);
}

/** Does the plan include `feature`? Unknown plan / no catalog / feature not mentioned => true (today's behaviour: every feature is on). */
export function planAllows(key: string | null | undefined, feature: PlanFeature): boolean {
  const row = planRow(key);
  return !row || row.features[feature] !== false;
}

/** Max locations a plan allows (null = unlimited / unknown). */
export const planMaxLocations = (key: string | null | undefined): number | null => planRow(key)?.max_locations ?? null;
