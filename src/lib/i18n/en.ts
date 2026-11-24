/** English catalog = the merge of every area in ./catalog (each area keeps en and es side by side). Keys are the source of truth for MessageKey. GENERATED LIST: add an area file + one line here. */
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

export const en = {
  ...auth.en,
  ...billing.en,
  ...bookings.en,
  ...common.en,
  ...dash.en,
  ...email.en,
  ...errors.en,
  ...knowledge.en,
  ...misc.en,
  ...onboarding.en,
  ...publicPages.en,
  ...security.en,
  ...settings.en,
  ...shell.en,
};
