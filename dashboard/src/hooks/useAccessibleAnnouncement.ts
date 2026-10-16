/**
 * useAccessibleAnnouncement — accessible live-region announcements for dashboard operations
 *
 * Provides concise, meaningful announcements for loading, success, and failure states
 * that are detectable by assistive technologies.  Uses the existing ToastContext's
 * aria-live regions with deduplication to avoid excessive rerenders.
 *
 * Announcements are:
 * - concise and meaningful
 * - associated with the operation being performed
 * - exposed to screen readers via aria-live
 * - non-disruptive (polite by default, assertive for failures)
 * - non-repetitive (internal deduplication)
 */

import { useCallback, useRef, useState } from 'react';
import { useToast } from './ToastContext';

/**
 * Announce a loading state beginning.  Emits a polite announcement that an
 * operation has started, so screen readers announce the change without
 * interrupting the user.
 */
export function useAccessibleAnnouncement() {
  const { showInfo, showError } = useToast();
  const announcedRef = useRef<Set<string>>(new Set());

  const announce = useCallback(
    (message: string, variant: 'info' | 'success' | 'error' = 'info') => {
      // Deduplicate: don't re-announce the same message within the same cycle
      if (announcedRef.current.has(message)) {
        return;
      }
      announcedRef.current.add(message);

      // Clean up after a short timeout so the same message can be re-announced
      // after a subsequent operation cycle (e.g. after a page reload or re-mount)
      setTimeout(() => {
        announcedRef.current.delete(message);
      }, 5000);

      if (variant === 'error') {
        showError(message);
      } else if (variant === 'success') {
        showInfo(message);
      } else {
        showInfo(message);
      }
    },
    [showError, showInfo],
  );

  const announceLoading = useCallback(
    (operation: string) => announce(`Loading ${operation}...`, 'info'),
    [announce],
  );

  const announceSuccess = useCallback(
    (operation: string) => announce(`Completed ${operation}.`, 'success'),
    [announce],
  );

  const announceFailure = useCallback(
    (operation: string, error?: string) => {
      const message = error
        ? `Failed to complete ${operation}: ${error}`
        : `Failed to complete ${operation}.`;
      announce(message, 'error');
    },
    [announce],
  );

  return {
    announceLoading,
    announceSuccess,
    announceFailure,
    resetAnnounced: useCallback(() => {
      announcedRef.current.clear();
    }, []),
  };
}