import type { Permission } from '@/lib/admin/permissions';
import type { MessageKey } from '@/lib/i18n/core';

/**
 * The console's navigation. ONE list: every console feature adds its own entries here (its label key lives in its own i18n catalog file). An item is
 * shown only when the caller holds `permission` (the server still enforces it on the page and the API). `group` is the section heading of the sidebar.
 * Keep each entry on its own line so parallel work merges cleanly.
 */
export interface AdminNavItem {
  href: string;
  label: MessageKey;
  /** SVG path (24x24, stroke). */
  icon: string;
  group: 'overview' | 'settings' | 'content' | 'system';
  permission?: Permission;
  /** Active only on this exact path (the overview); otherwise any path below it. */
  exact?: boolean;
}

const I = {
  home: 'M3 10.5 12 3l9 7.5M5 9.5V21h5v-6h4v6h5V9.5',
  sliders: 'M4 7h10m4 0h2M4 17h2m4 0h10M14 4v6m-4 4v6',
  phone: 'M4 5c0 8 6 14 14 14l1.5-3.2-3.5-1.8-2 2C11 15 9 13 8 10l2-2-1.8-3.5L5 4',
  chat: 'M4 5h16v11H9l-5 4V5Z',
  shield: 'M12 3 5 6v5c0 4.5 3 8 7 10 4-2 7-5.5 7-10V6l-7-3Zm-2.5 9 2 2 3.5-4',
  db: 'M5 6c0-1.7 3.1-3 7-3s7 1.3 7 3-3.1 3-7 3-7-1.3-7-3Zm0 0v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3',
  card: 'M3 7h18v12H3zM3 11h18M7 16h3',
  brush: 'M4 20c3 0 4-1.5 4-3a3 3 0 0 1 3-3l8-9-3-3-9 8a3 3 0 0 1-3 3c0 3-1 5-3 7Z',
  cal: 'M4 6h16v14H4zM4 10h16M9 3v4M15 3v4',
  clock: 'M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
  globe: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 0c2.5 2.4 3.5 5.4 3.5 9S14.5 18.6 12 21m0-18C9.5 5.4 8.5 8.4 8.5 12S9.5 18.6 12 21M3 12h18',
  history: 'M3 12a9 9 0 1 0 3-6.7M3 4v5h5M12 8v4l3 2',
  doc: 'M7 3h7l5 5v13H7zM14 3v5h5M10 13h6M10 17h6',
  server: 'M4 5h16v6H4zM4 13h16v6H4zM8 8h.01M8 16h.01',
  move: 'M4 12h13m-4-4 4 4-4 4M20 5v14',
  tenants: 'M3 21V8l9-5 9 5v13M9 21v-6h6v6M8 11h.01M12 11h.01M16 11h.01',
  plans: 'M4 6h16M4 12h16M4 18h10M18 16l2 2 3-4',
  alert: 'M12 4 3 20h18L12 4Zm0 6v5m0 3h.01',
  people: 'M16 20v-1a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v1M9.5 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7ZM21 20v-1a4 4 0 0 0-3-3.9M16 4.2a3.5 3.5 0 0 1 0 6.6',
} as const;

export const ADMIN_NAV: readonly AdminNavItem[] = [
  { href: '/admin', label: 'ac.nav.overview', icon: I.home, group: 'overview', exact: true },
  { href: '/admin/tenants', label: 'at.nav.tenants', icon: I.tenants, group: 'overview', permission: 'tenants.read' },
  { href: '/admin/plans', label: 'at.nav.plans', icon: I.plans, group: 'overview', permission: 'plans.read' },
  { href: '/admin/admins', label: 'at.nav.admins', icon: I.people, group: 'system', permission: 'admins.read' },
  { href: '/admin/providers', label: 'ap.nav.providers', icon: I.sliders, group: 'settings', permission: 'settings.read' },
  { href: '/admin/settings/voice', label: 'ac.nav.voice', icon: I.phone, group: 'settings', permission: 'settings.read' },
  { href: '/admin/settings/messaging', label: 'ac.nav.messaging', icon: I.chat, group: 'settings', permission: 'settings.read' },
  { href: '/admin/settings/signup', label: 'ac.nav.signup', icon: I.shield, group: 'settings', permission: 'settings.read' },
  { href: '/admin/settings/data', label: 'ac.nav.data', icon: I.db, group: 'settings', permission: 'settings.read' },
  { href: '/admin/settings/billing', label: 'ac.nav.billing', icon: I.card, group: 'settings', permission: 'settings.read' },
  { href: '/admin/settings/content', label: 'ac.nav.content', icon: I.brush, group: 'content', permission: 'settings.read' },
  { href: '/admin/legal', label: 'ac.nav.legal', icon: I.doc, group: 'content', permission: 'legal.read' },
  { href: '/admin/settings/scheduling', label: 'ac.nav.scheduling', icon: I.cal, group: 'settings', permission: 'settings.read' },
  { href: '/admin/settings/jobs', label: 'ac.nav.jobs', icon: I.clock, group: 'settings', permission: 'settings.read' },
  { href: '/admin/settings/locales', label: 'ac.nav.locales', icon: I.globe, group: 'content', permission: 'settings.read' },
  { href: '/admin/history', label: 'ac.nav.history', icon: I.history, group: 'system', permission: 'settings.read' },
  { href: '/admin/move', label: 'ac.nav.move', icon: I.move, group: 'system', permission: 'settings.read' },
  { href: '/admin/system', label: 'ac.nav.system', icon: I.server, group: 'system', permission: 'system.read' },
  { href: '/admin/operations', label: 'ao.nav.operations', icon: I.alert, group: 'system', permission: 'jobs.read' },
];

export const ADMIN_NAV_GROUPS: readonly { id: AdminNavItem['group']; label: MessageKey }[] = [
  { id: 'overview', label: 'ac.navGroup.overview' },
  { id: 'settings', label: 'ac.navGroup.settings' },
  { id: 'content', label: 'ac.navGroup.content' },
  { id: 'system', label: 'ac.navGroup.system' },
];

export { I as ADMIN_ICONS };
