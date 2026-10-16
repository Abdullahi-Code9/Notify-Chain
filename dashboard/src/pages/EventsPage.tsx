import { useEffect } from 'react';
import { EventFiltersBar } from '../components/EventFiltersBar';
import { EventListPanel } from '../components/EventListPanel';
import { EventsListSkeleton } from '../components/EventsListSkeleton';
import { WalletConnectButton } from '../components/WalletConnectButton';
import { getEventsApiBaseUrl } from '../config/eventsApiUrl';
import { useEventLoadingState } from '../hooks/useEventSelectors';
import { useEventStore } from '../store/eventStore';
import { fetchEvents, isListenerApiTimeoutError } from '../services/eventsApi';
import { generateMockEvents } from '../utils/eventData';
import { restoreWalletSession } from '../services/wallet';

const DEFAULT_EVENT_COUNT = 5000;
const API_URL = `${getEventsApiBaseUrl()}/api/events`;
const POLL_INTERVAL_MS = 15_000;

export function EventsPage() {
  const setEvents = useEventStore((state) => state.setEvents);
  const setLoading = useEventStore((state) => state.setLoading);
  const setError = useEventStore((state) => state.setError);
  const markSyncSuccess = useEventStore((state) => state.markSyncSuccess);
  const markSyncFailure = useEventStore((state) => state.markSyncFailure);
  // Re-fetch whenever lastFetchedAt is reset to 0 (via invalidateEvents()) so
  // that a successful blockchain status-change transaction is reflected on the
  // next render cycle without requiring a full hard refresh.
  const lastFetchedAt = useEventStore((state) => state.lastFetchedAt);
  const { isLoading, error } = useEventLoadingState();

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

    loadEvents();

    const intervalId = setInterval(async () => {
      try {
        const remoteEvents = await fetchEvents(API_URL);
        if (!cancelled) {
          setEvents(remoteEvents);
          markSyncSuccess();
        }
      } catch {
        if (!cancelled) {
          markSyncFailure('Background refresh failed');
        }
      }
    }, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, [lastFetchedAt, markSyncFailure, markSyncSuccess, setEvents, setError, setLoading]);

  return (
    <main className="events-page">
      <header className="events-page__header">
        <div className="events-page__header-row">
          <div>
            <h1>Blockchain Events</h1>
            <p>Optimized rendering for large event datasets.</p>
          </div>
          <WalletConnectButton />
        </div>
      </header>

      <EventFiltersBar />

      <div aria-live="assertive" role="alert">
        {error && <p className="events-page__status events-page__status--warning">{error}</p>}
      </div>

      {isLoading ? <EventsListSkeleton /> : <EventListPanel />}
    </main>
  );
}
