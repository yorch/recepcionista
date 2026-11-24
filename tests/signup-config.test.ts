import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { signupAvailability, signupConfigWarning, turnstileFullyConfigured } from '../src/lib/signup-config';
import { I18nProvider } from '../src/lib/i18n/client';
import { en } from '../src/lib/i18n/en';
import { SignupForm } from '../src/components/auth/signup-form';

const prod = (extra: Record<string, string> = {}) => ({ NODE_ENV: 'production', ...extra }) as unknown as NodeJS.ProcessEnv;
const PAIR = { TURNSTILE_SECRET_KEY: 's', NEXT_PUBLIC_TURNSTILE_SITE_KEY: 'k' };

describe('signup availability (captcha required in production)', () => {
  test('outside production signup is open without any captcha', () => {
    expect(signupAvailability({ NODE_ENV: 'development' } as unknown as NodeJS.ProcessEnv)).toEqual({ open: true, captcha: 'not_required' });
    expect(signupAvailability({} as NodeJS.ProcessEnv).open).toBe(true);
    expect(signupConfigWarning({ NODE_ENV: 'test' } as unknown as NodeJS.ProcessEnv)).toBeNull();
  });
  test('production without the pair is closed', () => {
    expect(signupAvailability(prod())).toEqual({ open: false, reason: 'captcha_not_configured' });
    expect(signupAvailability(prod({ TURNSTILE_SECRET_KEY: 's' })).open).toBe(false); // secret alone
    expect(signupAvailability(prod({ NEXT_PUBLIC_TURNSTILE_SITE_KEY: 'k' })).open).toBe(false); // site key alone
    expect(signupAvailability(prod({ TURNSTILE_SECRET_KEY: '  ', NEXT_PUBLIC_TURNSTILE_SITE_KEY: 'k' })).open).toBe(false);
    expect(signupConfigWarning(prod())).toMatch(/DISABLED/);
  });
  test('production with the full pair is open (turnstile)', () => {
    expect(turnstileFullyConfigured(prod(PAIR))).toBe(true);
    expect(signupAvailability(prod(PAIR))).toEqual({ open: true, captcha: 'turnstile' });
    expect(signupConfigWarning(prod(PAIR))).toBeNull();
  });
  test('explicit opt-out opens it, loudly; only the exact value "true" counts', () => {
    expect(signupAvailability(prod({ SIGNUP_ALLOW_WITHOUT_CAPTCHA: 'true' }))).toEqual({ open: true, captcha: 'waived' });
    expect(signupConfigWarning(prod({ SIGNUP_ALLOW_WITHOUT_CAPTCHA: 'true' }))).toMatch(/WITHOUT a captcha/);
    for (const v of ['1', 'yes', 'TRUE', 'false', '']) expect(signupAvailability(prod({ SIGNUP_ALLOW_WITHOUT_CAPTCHA: v })).open).toBe(false);
  });
  test('the pair wins over the opt-out (no warning)', () => {
    expect(signupAvailability(prod({ ...PAIR, SIGNUP_ALLOW_WITHOUT_CAPTCHA: 'true' }))).toEqual({ open: true, captcha: 'turnstile' });
  });
});

describe('/signup page when disabled', () => {
  test('hides the form and explains invite-only', () => {
    const html = renderToStaticMarkup(createElement(I18nProvider, { locale: 'en', messages: en } as never, createElement(SignupForm, { turnstileSiteKey: null, disabled: true })));
    expect(html).toContain('invite-only');
    expect(html).toContain('data-testid="signup-disabled"');
    expect(html).not.toContain('name="password"');
    expect(html).not.toContain('<form');
  });
  test('enabled renders the form', () => {
    const html = renderToStaticMarkup(createElement(I18nProvider, { locale: 'en', messages: en } as never, createElement(SignupForm, { turnstileSiteKey: null })));
    expect(html).toContain('name="password"');
  });
});
