import { useState, useCallback, useRef } from 'react';
import { copyTextToClipboard } from '../utils/clipboard';

/**
 * Returns a `copy` function and a boolean `copied` state that resets after
 * `resetMs` milliseconds (default 1800).
 */
export function useCopyId(resetMs = 1800) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const copy = useCallback(
    async (text: string): Promise<boolean> => {
      const ok = await copyTextToClipboard(text);
      if (ok) {
        setCopied(true);
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => setCopied(false), resetMs);
      }
      return ok;
    },
    [resetMs],
  );

  return { copy, copied };
}
