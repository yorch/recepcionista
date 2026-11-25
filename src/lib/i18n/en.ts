/** English catalog = the merge of every area in ./catalog (each area keeps en and es side by side). Keys are the source of truth for MessageKey. GENERATED LIST: add an area file + one line here. */
import { auth } from './catalog/auth';
import { billing } from './catalog/billing';
import { bookings } from './catalog/bookings';
import { bookingTools } from './catalog/bookingTools';
import { common } from './catalog/common';
import { dash } from './catalog/dash';
import { email } from './catalog/email';
import { errors } from './catalog/errors';
import { knowledge } from './catalog/knowledge';
import { messages } from './catalog/messages';
import { misc } from './catalog/misc';
import { onboarding } from './catalog/onboarding';
import { platformD } from './catalog/platformD';
import { publicPages } from './catalog/publicPages';
import { security } from './catalog/security';
import { settings } from './catalog/settings';
import { shell } from './catalog/shell';
import { voiceLine } from './catalog/voiceLine';

export const en = {
  ...auth.en,
  ...billing.en,
  ...bookings.en,
  ...bookingTools.en,
  ...common.en,
  ...dash.en,
  ...email.en,
  ...errors.en,
  ...knowledge.en,
  ...messages.en,
  ...misc.en,
  ...onboarding.en,
  ...platformD.en,
  ...publicPages.en,
  ...security.en,
  ...settings.en,
  ...shell.en,
  ...voiceLine.en,
};
