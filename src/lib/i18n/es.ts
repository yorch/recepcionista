/** Spanish catalog (neutral Latin-American Spanish, "usted"). Must carry exactly the keys and placeholders of ./en (tests/i18n-parity.test.ts). */
import { auth } from './catalog/auth';
import { billing } from './catalog/billing';
import { bookings } from './catalog/bookings';
import { common } from './catalog/common';
import { dash } from './catalog/dash';
import { email } from './catalog/email';
import { errors } from './catalog/errors';
import { knowledge } from './catalog/knowledge';
import { misc } from './catalog/misc';
import { onboarding } from './catalog/onboarding';
import { publicPages } from './catalog/publicPages';
import { security } from './catalog/security';
import { settings } from './catalog/settings';
import { shell } from './catalog/shell';
import type { en } from './en';

export const es: Record<keyof typeof en, string> = {
  ...auth.es,
  ...billing.es,
  ...bookings.es,
  ...common.es,
  ...dash.es,
  ...email.es,
  ...errors.es,
  ...knowledge.es,
  ...misc.es,
  ...onboarding.es,
  ...publicPages.es,
  ...security.es,
  ...settings.es,
  ...shell.es,
};
