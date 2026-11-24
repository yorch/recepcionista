'use client';
import { useT } from '@/lib/i18n/client';

/** "Skip to content": focuses the page's <main> landmark (works on every page without needing ids). */
export function SkipLink() {
  const t = useT();
  return (
    <a
      href="#main-content"
      className="skip-link"
      onClick={(e) => {
        const main = document.querySelector<HTMLElement>('main');
        if (!main) return;
        e.preventDefault();
        if (!main.hasAttribute('tabindex')) main.setAttribute('tabindex', '-1');
        main.focus({ preventScroll: false });
        main.scrollIntoView({ block: 'start' });
      }}
    >
      {t('skip.toContent')}
    </a>
  );
}
