import { useCallback, useEffect, useRef, useState } from 'react';
import type { NotificationSummaryMetrics } from '../types/notificationSummary';
import {
  fetchNotificationSummary,
  generateMockNotificationSummary,
} from '../services/notificationSummaryApi';

const DEFAULT_POLL_INTERVAL_MS = 5000;

export interface UseNotificationSummaryResult {
  summary: NotificationSummaryMetrics | null;
  isLoading: boolean;
  error: string | null;
  /** Whether the current summary is generated mock data (API unavailable). */
  isMockData: boolean;
  /** Epoch-ms timestamp of the most recent successful (or fallback) refresh. */
  lastRefreshedAt: number | null;
  refresh: () => void;
}

/**
 * Self-contained data hook for the notification delivery summary.
 *
 * Loads the summary once on mount and polls at a configurable interval so the
 * summary cards update dynamically. When the listener API is unreachable the
 * hook falls back to deterministic mock data so the UI never shows a hard
 * empty state — the user is informed via the returned `error`/`isMockData`.
 */
export function useNotificationSummary(
  apiUrl: string,
  pollIntervalMs: number = DEFAULT_POLL_INTERVAL_MS,
): UseNotificationSummaryResult {
  const [summary, setSummary] = useState<NotificationSummaryMetrics | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isMockData, setIsMockData] = useState(false);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<number | null>(null);

  const abortRef = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setIsLoading(true);
    setError(null);

    try {
      const data = await fetchNotificationSummary(apiUrl);
      if (controller.signal.aborted) return;
      setSummary(data);
      setIsMockData(false);
      setLastRefreshedAt(Date.now());
    } catch (err) {
      if (controller.signal.aborted) return;
      setError(err instanceof Error ? err.message : String(err));
      setSummary(generateMockNotificationSummary());
      setIsMockData(true);
      setLastRefreshedAt(Date.now());
    } finally {
      if (!controller.signal.aborted) {
        setIsLoading(false);
      }
    }
  }, [apiUrl]);

  useEffect(() => {
    refresh();

    const intervalId = setInterval(refresh, pollIntervalMs);

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void refresh();
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      abortRef.current?.abort();
      clearInterval(intervalId);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [refresh, pollIntervalMs]);

  return { summary, isLoading, error, isMockData, lastRefreshedAt, refresh };
}
