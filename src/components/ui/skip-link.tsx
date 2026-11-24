'use client';

/** "Skip to content": focuses the page's <main> landmark (works on every page without needing ids). */
export function SkipLink() {
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
      Skip to main content
    </a>
  );
}
