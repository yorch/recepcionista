'use client';
import { useEffect, type RefObject } from 'react';

const FOCUSABLE = 'a[href], button:not([disabled]), select, input:not([disabled]), textarea, [tabindex]:not([tabindex="-1"])';

/**
 * Escape closes and Tab stays inside the dialog. Handled in the CAPTURE phase on window so the panel underneath (document-level listeners)
 * never sees the key. Same behaviour as the reschedule dialog.
 */
export function useDialogKeys(rootRef: RefObject<HTMLElement | null>, onClose: () => void): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); return; }
      const root = rootRef.current;
      if (e.key !== 'Tab' || !root) return;
      const items = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null);
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (!root.contains(active)) { e.preventDefault(); e.stopPropagation(); first.focus(); }
      else if (e.shiftKey && active === first) { e.preventDefault(); e.stopPropagation(); last.focus(); }
      else if (!e.shiftKey && active === last) { e.preventDefault(); e.stopPropagation(); first.focus(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [rootRef, onClose]);
}
