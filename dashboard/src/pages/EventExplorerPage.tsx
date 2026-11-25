import { useCallback, useEffect, useMemo, useState } from 'react';
import { EventFiltersBar } from '../components/EventFiltersBar';
import { NotificationSearchBar } from '../components/NotificationSearchBar';
import { WalletConnectButton } from '../components/WalletConnectButton';
import { EventExplorerTable } from '../components/EventExplorerTable';
import { EventExplorerSkeleton } from '../components/EventExplorerSkeleton';
import { PaginationControls } from '../components/PaginationControls';
import { NotificationDetailsDrawer } from '../components/NotificationDetailsDrawer';
import { IndexingHealthPanel } from '../components/IndexingHealthPanel';
import { NotificationHealthPanel } from '../components/NotificationHealthPanel';
import { NotificationSummaryPanel } from '../components/NotificationSummaryPanel';
import { EmptyState } from '../components/EmptyState';
import {
  useEventFilters,
  useEventLoadingState,
  useFilteredEvents,
} from '../hooks/useEventSelectors';
import { useEventStore } from '../store/eventStore';
import {
  fetchEvents,
  fetchStatus,
  isListenerApiTimeoutError,
  type ContractStatus,
} from '../services/eventsApi';
import { openEventStream, toEventStreamUrl } from '../services/eventStream';
import { resolveIndexingHealthUrl } from '../services/indexingHealthApi';
import { resolveNotificationHealthUrl } from '../services/notificationHealthApi';
import { generateMockEvents } from '../utils/eventData';
import { restoreWalletSession } from '../services/wallet';
import type { BlockchainEvent } from '../types/event';
import { useWalletAccountSync } from '../hooks/useWalletAccountSync';
import { parseSelectedEventId } from '../utils/eventUrlState';

const DEFAULT_EVENT_COUNT = 5000;
const DEFAULT_LIMIT = 12;
const EVENT_ID_PARAM = 'eventId';
const API_URL = import.meta.env.VITE_EVENTS_API_URL ?? 'http://localhost:8787/api/events';
const STREAM_URL = toEventStreamUrl(API_URL);
const POLL_INTERVAL_MS = 15_000;
const LISTENER_BASE_URL = API_URL.replace('/api/events', '');
const INDEXING_HEALTH_URL =
  import.meta.env.VITE_INDEXING_HEALTH_URL ?? resolveIndexingHealthUrl(API_URL);
const NOTIFICATION_HEALTH_URL =
  import.meta.env.VITE_NOTIFICATION_HEALTH_URL ?? resolveNotificationHealthUrl(API_URL);

const ACTIVITY_RANGE_LABELS: Record<EventActivityRange, string> = {
  '1h': 'the last hour',
  '6h': 'the last 6 hours',
  '24h': 'the last 24 hours',
  '7d': 'the last 7 days',
};

function parsePageParam(search: string) {
  const params = new URLSearchParams(search);
  const value = Number(params.get('page'));
  return Number.isInteger(value) && value > 0 ? value : 1;
}

function parseLimitParam(search: string) {
  const params = new URLSearchParams(search);
  const value = Number(params.get('limit'));
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_LIMIT;
}

function replaceSelectedEventInUrl(eventId: string | null) {
  const url = new URL(window.location.href);
  if (eventId) {
    url.searchParams.set(EVENT_ID_PARAM, eventId);
  } else {
    url.searchParams.delete(EVENT_ID_PARAM);
  }
  window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
}

export function EventExplorerPage() {
  const initialSearch = typeof window !== 'undefined' ? window.location.search : '';
  const [page, setPage] = useState(() => parsePageParam(initialSearch));
  const [limit, setLimit] = useState(() => parseLimitParam(initialSearch));
  const [selectedNotification, setSelectedNotification] = useState<BlockchainEvent | null>(null);
  const [contractStatuses, setContractStatuses] = useState<ContractStatus[]>([]);
  const [activityRange, setActivityRange] =
    useState<EventActivityRange>(DEFAULT_EVENT_ACTIVITY_RANGE);

  const events = useEventStore((state) => state.events);
  const setEvents = useEventStore((state) => state.setEvents);
  const appendEvents = useEventStore((state) => state.appendEvents);
  const setLoading = useEventStore((state) => state.setLoading);
  const setError = useEventStore((state) => state.setError);
  const markSyncSuccess = useEventStore((state) => state.markSyncSuccess);
  const markSyncFailure = useEventStore((state) => state.markSyncFailure);
  const setSearch = useEventStore((state) => state.setSearch);
  const setContractFilter = useEventStore((state) => state.setContractFilter);
  const setEventTypeFilter = useEventStore((state) => state.setEventTypeFilter);
  const setStatusFilter = useEventStore((state) => state.setStatusFilter);
  const setDateFrom = useEventStore((state) => state.setDateFrom);
  const setDateTo = useEventStore((state) => state.setDateTo);
  // Re-fetch whenever lastFetchedAt is reset to 0 (via invalidateEvents()) so
  // that a successful blockchain status-change transaction is reflected on the
  // next render cycle without requiring a full hard refresh.
  const lastFetchedAt = useEventStore((state) => state.lastFetchedAt);
  const { isLoading, error } = useEventLoadingState();
  const filters = useEventFilters();
  const filteredEvents = useFilteredEvents();

  useEffect(() => {
    restoreWalletSession();
  }, []);

  useEffect(() => {
    // Guard: skip the re-fetch if we already have fresh data from this session.
    // lastFetchedAt === 0 means either first load or an explicit cache
    // invalidation (e.g. after a blockchain transaction mutated notification state).
    if (lastFetchedAt !== 0) {
      return;
    }

    let cancelled = false;

    async function loadEvents() {
      setLoading(true);
      setError(null);

      try {
        const remoteEvents = await fetchEvents(API_URL);
        if (!cancelled) {
          setEvents(remoteEvents);
          markSyncSuccess();
        }
      } catch (error) {
        if (!cancelled) {
          setEvents(generateMockEvents(DEFAULT_EVENT_COUNT));
          setError('Listener API unavailable — showing mock events for demo.');
          markSyncFailure('Initial sync failed');
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    async function loadStatus() {
      try {
        const status = await fetchStatus(LISTENER_BASE_URL);
        if (!cancelled) {
          setContractStatuses(status.contracts);
        }
      } catch {
        // Ignore status fetch errors, just don't show status
      }
    }

    loadEvents();
    loadStatus();

    // Poll for status updates so delivered/failed notifications are reflected
    // without requiring a manual page refresh.
    const intervalId = setInterval(async () => {
      setIsRefreshing(true);
      setRefreshError(null);
      try {
        const remoteEvents = await fetchEvents(API_URL);
        if (!cancelled) {
          setEvents(remoteEvents);
          markSyncSuccess();
        }
      } catch {
        if (!cancelled) {
          setRefreshError('Background refresh failed');
          markSyncFailure('Background refresh failed');
        }
      } finally {
        if (!cancelled) {
          setIsRefreshing(false);
        }
      }
    }, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      if (intervalId) clearInterval(intervalId);
      closeStream?.();
    };
  }, [appendEvents, setEvents, markSyncSuccess, markSyncFailure]);

  // Clear stale events and re-fetch whenever the connected wallet address
  // changes (switch or disconnect). This is the fix for issue #175.
  useWalletAccountSync(() => {
    setEvents([]);
    setError(null);
    setPage(1);

    setLoading(true);
    fetchEvents(API_URL)
      .then((remoteEvents) => {
        setEvents(remoteEvents);
        markSyncSuccess();
      })
      .catch((error) => {
        setEvents(generateMockEvents(DEFAULT_EVENT_COUNT));
        setError('Listener API unavailable — showing mock events for demo.');
        markSyncFailure('Wallet refresh failed');
      })
      .finally(() => {
        setLoading(false);
      });
  });

  const pageCount = useMemo(
    () => Math.max(1, Math.ceil(filteredEvents.length / limit)),
    [filteredEvents.length, limit],
  );

  useEffect(() => {
    if (page > pageCount) {
      setPage(pageCount);
    }
  }, [pageCount, page]);

  useEffect(() => {
    setPage(1);
  }, [
    filters.search,
    filters.contractAddress,
    filters.eventType,
    filters.status,
    filters.dateFrom,
    filters.dateTo,
  ]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const params = new URLSearchParams(window.location.search);
    params.set('page', String(page));
    params.set('limit', String(limit));

    window.history.replaceState({}, '', `${window.location.pathname}?${params.toString()}`);
  }, [page, limit]);

  useEffect(() => {
    if (lastFetchedAt === 0) {
      return;
    }

    const eventId = parseSelectedEventId(window.location.search);
    if (!eventId) {
      setSelectedNotification(null);
      return;
    }

    const event = events.find((candidate) => candidate.eventId === eventId) ?? null;
    setSelectedNotification(event);
    if (!event) {
      replaceSelectedEventInUrl(null);
    }
  }, [events, lastFetchedAt]);

  useEffect(() => {
    const handlePopState = () => {
      const eventId = parseSelectedEventId(window.location.search);
      setSelectedNotification(
        eventId ? (events.find((event) => event.eventId === eventId) ?? null) : null,
      );
    };

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [events]);

  const currentPageEvents = useMemo(() => {
    const startIndex = (page - 1) * limit;
    return filteredEvents.slice(startIndex, startIndex + limit);
  }, [filteredEvents, page, limit]);

  // Event activity buckets (#982). Computed from the same filtered dataset the
  // table renders so chart values reconcile with the underlying events.
  const eventActivity = useMemo(
    () => computeEventActivity(filteredEvents, activityRange),
    [filteredEvents, activityRange],
  );

  const fromIndex = filteredEvents.length === 0 ? 0 : (page - 1) * limit + 1;
  const toIndex = Math.min(filteredEvents.length, page * limit);

  const handleClearFilters = useCallback(() => {
    setSearch('');
    setContractFilter('');
    setEventTypeFilter('');
    setStatusFilter('all');
    setDateFrom('');
    setDateTo('');
    setPage(1);
  }, [setSearch, setContractFilter, setEventTypeFilter, setStatusFilter, setDateFrom, setDateTo]);

  const handleRetry = useCallback(async () => {
    setIsRefreshing(true);
    setRefreshError(null);

    try {
      const remoteEvents = await fetchEvents(API_URL);
      setEvents(remoteEvents);
      markSyncSuccess();
      setError(null);
    } catch {
      setRefreshError('Manual refresh failed');
      markSyncFailure('Manual refresh failed');
    } finally {
      setIsRefreshing(false);
    }
  }, [markSyncFailure, markSyncSuccess, setError, setEvents]);

  const handleSelectEvent = useCallback((event: BlockchainEvent) => {
    setSelectedNotification(event);
    replaceSelectedEventInUrl(event.eventId);
  }, []);

  const handleContractClick = useCallback((contractAddress: string) => {
    window.location.hash = `contract-detail?address=${contractAddress}`;
  }, []);

  const handleCloseDrawer = useCallback(() => {
    setSelectedNotification(null);
    replaceSelectedEventInUrl(null);
  }, []);

  return (
    <main className="event-explorer-page">
      <header className="event-explorer__header">
        <div>
          <p className="event-explorer__eyebrow">Event Explorer</p>
          <h1>Smart Contract Event Log</h1>
          <p className="event-explorer__lead">
            Browse Soroban contract events across registered contracts with filters, pagination, and
            copy-to-clipboard contract metadata.
          </p>
        </div>
        <WalletConnectButton />
      </header>

      {contractStatuses.length > 0 && (
        <section className="contract-statuses">
          <h2 className="contract-statuses__title">Contract Status</h2>
          <div className="contract-statuses__list">
            {contractStatuses.map((contract) => (
              <div key={contract.address} className="contract-status-card">
                <div className="contract-status-card__address">{contract.address}</div>
                <div
                  className={`contract-status-card__badge ${contract.paused ? 'contract-status-card__badge--paused' : 'contract-status-card__badge--active'}`}
                >
                  {contract.paused ? 'PAUSED' : 'ACTIVE'}
                </div>
                {contract.error && (
                  <div className="contract-status-card__error">Error: {contract.error}</div>
                )}
              </div>
            ))}
          </div>
        </section>
      )}
      <IndexingHealthPanel healthUrl={INDEXING_HEALTH_URL} />
      <NotificationHealthPanel healthUrl={NOTIFICATION_HEALTH_URL} />
      <NotificationSummaryPanel apiUrl={NOTIFICATION_HEALTH_URL} />

      <EventFiltersBar />
      <NotificationSearchBar />

      {error && !filteredEvents.length && (
      <section className="event-activity" aria-labelledby="event-activity-heading">
        <div className="event-activity__header">
          <h2 id="event-activity-heading">Event Activity</h2>
          <div className="event-activity__range" role="group" aria-label="Activity time range">
            {EVENT_ACTIVITY_RANGES.map((range) => (
              <button
                key={range}
                type="button"
                className={`event-activity__range-button${
                  range === activityRange ? ' event-activity__range-button--active' : ''
                }`}
                aria-pressed={range === activityRange}
                onClick={() => setActivityRange(range)}
              >
                {range}
              </button>
            ))}
          </div>
        </div>

        <EventActivityChart
          buckets={eventActivity.buckets}
          isLoading={isLoading}
          rangeLabel={ACTIVITY_RANGE_LABELS[activityRange]}
        />
      </section>

      {error && (
        <section className="event-explorer__error-banner" role="alert">
          <div>
            <strong>Error:</strong> {error}
          </div>
          <button type="button" className="event-explorer__retry-button" onClick={handleRetry}>
            Retry
          </button>
        </section>
      )}

      {refreshError && filteredEvents.length > 0 && (
        <section
          className="event-explorer__error-banner event-explorer__error-banner--refresh"
          role="alert"
        >
          <div>
            <strong>Refresh Error:</strong> {refreshError} — existing events are still displayed.
          </div>
          <button type="button" className="event-explorer__retry-button" onClick={handleRetry}>
            Retry Refresh
          </button>
        </section>
      )}

      <div className="event-explorer__status-row">
        <p className="event-explorer__summary">
          Showing {fromIndex.toLocaleString()}–{toIndex.toLocaleString()} of{' '}
          {filteredEvents.length.toLocaleString()} events
        </p>
        {(isLoading || isRefreshing) && (
          <p className="event-explorer__loading-note">
            {isRefreshing ? 'Refreshing events…' : 'Loading events…'}
          </p>
        )}
      </div>

      {isLoading && filteredEvents.length === 0 ? (
        <EventExplorerSkeleton rows={Math.min(limit, 8)} />
      ) : currentPageEvents.length > 0 ? (
        <EventExplorerTable
          events={currentPageEvents}
          onSelectEvent={handleSelectEvent}
          contractStatuses={contractStatuses}
          onContractClick={handleContractClick}
        />
      ) : (
        <EmptyState
          size="compact"
          icon="🔍"
          title="No events found"
          message="Update the search, event type, or contract filter to uncover matching Soroban contract events."
          action={{ label: 'Clear filters', onClick: handleClearFilters }}
        />
      )}

      <PaginationControls
        page={page}
        pageCount={pageCount}
        limit={limit}
        totalCount={filteredEvents.length}
        onPageChange={setPage}
        onLimitChange={setLimit}
      />

      <NotificationDetailsDrawer
        isOpen={Boolean(selectedNotification)}
        notification={selectedNotification}
        onClose={handleCloseDrawer}
      />
    </main>
  );
}
