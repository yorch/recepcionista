'use client';
import { useCallback, useEffect, useRef, useState } from 'react';

/** Copy text to the clipboard (with a textarea fallback for non-secure contexts). `copied` resets after 2s. */
export function useCopy() {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const copy = useCallback(async (text: string): Promise<boolean> => {
    let okCopy = false;
    try {
      await navigator.clipboard.writeText(text);
      okCopy = true;
    } catch {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        okCopy = document.execCommand('copy');
        document.body.removeChild(ta);
      } catch {
        okCopy = false;
      }
    }
    setCopied(okCopy);
    if (timer.current) clearTimeout(timer.current);
    if (okCopy) timer.current = setTimeout(() => setCopied(false), 2000);
    return okCopy;
  }, []);

  return { copied, copy };
}
