import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { WebhookDelivery, WebhookFilters } from '../types/webhook';
import {
  bucketDeliveriesByTime,
  computeSummaryMetrics,
  filterDeliveries,
  getEventTypeOptions,
} from '../utils/webhookData';
import { fetchWebhookDeliveries, getMockWebhookDeliveries } from '../services/webhookApi';

const POLL_INTERVAL_MS = 30_000;

const RANGE_HOURS_MAP: Record<string, number> = {
  '1h': 1,
  '6h': 6,
  '24h': 24,
  '7d': 168,
};

const DEFAULT_FILTERS: WebhookFilters = {
  dateRange: '24h',
  eventType: 'all',
  errorCategory: 'all',
  statusFilter: 'all',
};

export interface UseWebhookDashboardResult {
  isLoading: boolean;
  error: string | null;
  isMockData: boolean;
  filters: WebhookFilters;
  setFilters: (patch: Partial<WebhookFilters>) => void;
  /** All deliveries currently visible after filtering */
  filteredDeliveries: WebhookDelivery[];
  /** Failed deliveries only (used for the failed deliveries table) */
  failedDeliveries: WebhookDelivery[];
  summary: ReturnType<typeof computeSummaryMetrics>;
  chartBuckets: ReturnType<typeof bucketDeliveriesByTime>;
  eventTypeOptions: string[];
  refresh: () => void;
  lastRefreshedAt: number | null;
}

export function useWebhookDashboard(): UseWebhookDashboardResult {
  const [allDeliveries, setAllDeliveries] = useState<WebhookDelivery[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isMockData, setIsMockData] = useState(false);
  const [filters, setFiltersState] = useState<WebhookFilters>(DEFAULT_FILTERS);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<number | null>(null);

  // Track mounted state to prevent state updates after unmount
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    if (!mountedRef.current) return;
    setIsLoading(true);
    setError(null);

    try {
      const response = await fetchWebhookDeliveries();
      if (!mountedRef.current) return;
      setAllDeliveries(response.deliveries);
      setIsMockData(false);
      setLastRefreshedAt(Date.now());
    } catch {
      if (!mountedRef.current) return;
      const mock = getMockWebhookDeliveries();
      setAllDeliveries(mock.deliveries);
      setIsMockData(true);
      setError('Webhook API unavailable — showing generated demo data.');
      setLastRefreshedAt(Date.now());
    } finally {
      if (mountedRef.current) {
        setIsLoading(false);
      }
    }
  }, []);

  // Initial load + polling
  useEffect(() => {
    load();
    const intervalId = setInterval(load, POLL_INTERVAL_MS);
    return () => clearInterval(intervalId);
  }, [load]);

  const setFilters = useCallback((patch: Partial<WebhookFilters>) => {
    setFiltersState((prev) => ({ ...prev, ...patch }));
  }, []);

  // Derived data — only recomputed when allDeliveries or filters change
  const filteredDeliveries = useMemo(
    () => filterDeliveries(allDeliveries, filters),
    [allDeliveries, filters],
  );

  const failedDeliveries = useMemo(
    () => filteredDeliveries.filter((d) => d.status === 'failed'),
    [filteredDeliveries],
  );

  const summary = useMemo(() => computeSummaryMetrics(filteredDeliveries), [filteredDeliveries]);

  const chartBuckets = useMemo(
    () => bucketDeliveriesByTime(filteredDeliveries, RANGE_HOURS_MAP[filters.dateRange] ?? 24),
    [filteredDeliveries, filters.dateRange],
  );

  const eventTypeOptions = useMemo(() => getEventTypeOptions(allDeliveries), [allDeliveries]);

  return {
    isLoading,
    error,
    isMockData,
    filters,
    setFilters,
    filteredDeliveries,
    failedDeliveries,
    summary,
    chartBuckets,
    eventTypeOptions,
    refresh: load,
    lastRefreshedAt,
  };
}
