import { useState, useEffect, useCallback } from 'react';
import { fetchActivityFeed, generateMockActivityEvents } from '../services/activityApi';
import type { ActivityEvent, ActivityType } from '../types/activity';
import { formatRelativeTimestamp, formatTimestamp, parseToDate } from '../utils/formatTime';
import { PaginationControls } from './PaginationControls';
import { useWalletAccountSync } from '../hooks/useWalletAccountSync';
import { EmptyState } from './EmptyState';

// Helper to get icon/color based on activity type
const getActivityTypeStyle = (type: ActivityType) => {
  const styles: Record<ActivityType, { color: string; icon: string; bg: string }> = {
    notification_sent: {
      color: '#34d399',
      icon: '✓',
      bg: 'rgba(52, 211, 153, 0.12)',
    },
    notification_failed: {
      color: '#f87171',
      icon: '✕',
      bg: 'rgba(248, 113, 113, 0.12)',
    },
    notification_retried: {
      color: '#f4b400',
      icon: '↻',
      bg: 'rgba(244, 180, 0, 0.12)',
    },
    contract_event_received: {
      color: '#60a5fa',
      icon: '📡',
      bg: 'rgba(96, 165, 250, 0.12)',
    },
    preference_updated: {
      color: '#a78bfa',
      icon: '⚙',
      bg: 'rgba(167, 139, 250, 0.12)',
    },
    template_created: {
      color: '#38bdf8',
      icon: '📄',
      bg: 'rgba(56, 189, 248, 0.12)',
    },
    template_updated: {
      color: '#22d3ee',
      icon: '📝',
      bg: 'rgba(34, 211, 238, 0.12)',
    },
    webhook_received: {
      color: '#fb923c',
      icon: '🔗',
      bg: 'rgba(251, 146, 60, 0.12)',
    },
  };

  return styles[type] || styles['contract_event_received'];
};

// Individual activity event card
const ActivityEventCard = ({ event }: { event: ActivityEvent }) => {
  const style = getActivityTypeStyle(event.type);
  const timestamp = parseToDate(event.timestamp);

  return (
    <div
      className={`activity-event ${!event.read ? 'activity-event--unread' : ''}`}
      role="article"
      aria-label={event.message}
    >
      <div
        className="activity-event__icon"
        style={{ backgroundColor: style.bg, color: style.color }}
        aria-hidden="true"
      >
        {style.icon}
      </div>

      <div className="activity-event__content">
        <div className="activity-event__header">
          <span
            className="activity-event__type"
            style={{ color: style.color }}
          >
            {event.type.replace(/_/g, ' ')}
          </span>

          <time
            className="activity-event__time"
            dateTime={timestamp?.toISOString()}
            title={formatTimestamp(event.timestamp)}
          >
            {formatRelativeTimestamp(event.timestamp)}
          </time>
        </div>

        <p className="activity-event__message">{event.message}</p>

        {Object.keys(event.metadata).length > 0 && (
          <div className="activity-event__metadata">
            {Object.entries(event.metadata).map(
              ([key, value]) =>
                value !== undefined &&
                value !== null && (
                  <span
                    key={key}
                    className="activity-event__metadata-item"
                  >
                    <span className="activity-event__metadata-key">
                      {key}:
                    </span>

                    <span className="activity-event__metadata-value">
                      {String(value)}
                    </span>
                  </span>
                ),
            )}
          </div>
        )}
      </div>

      {!event.read && (
        <div
          className="activity-event__unread-indicator"
          aria-hidden="true"
        />
      )}
    </div>
  );
};

// Skeleton loader for activity events
const ActivitySkeleton = () => (
  <div className="activity-event activity-event--skeleton">
    <div className="activity-event__icon activity-event__icon--skeleton" />

    <div className="activity-event__content activity-event__content--skeleton">
      <div
        className="activity-event__skeleton-line"
        style={{ width: '40%' }}
      />

      <div
        className="activity-event__skeleton-line"
        style={{ width: '70%' }}
      />

      <div
        className="activity-event__skeleton-line"
        style={{ width: '50%' }}
      />
    </div>
  </div>
);

// All mock events are generated once and held in module scope so pagination
// works consistently across page changes without regenerating on every render.
const ALL_MOCK_EVENTS = generateMockActivityEvents(100);

// Main ActivityFeed component
export function ActivityFeed() {
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [total, setTotal] = useState(0);
  const [realTimeEnabled, setRealTimeEnabled] = useState(true);

  // Real-time events are prepended; track them separately so pagination totals
  // stay accurate without mixing them into the paginated data.
  const [liveEvents, setLiveEvents] = useState<ActivityEvent[]>([]);

  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  // Load a specific page of events
  const loadEvents = useCallback(
    async (pageNum: number, size: number) => {
      setLoading(true);
      setError(null);

      try {
        try {
          const data = await fetchActivityFeed(pageNum, size);

          setEvents(data.events);
          setTotal(data.total);
        } catch {
          // Fallback to stable mock data
          const start = (pageNum - 1) * size;
          const end = start + size;

          setEvents(ALL_MOCK_EVENTS.slice(start, end));
          setTotal(ALL_MOCK_EVENTS.length);
        }
      } catch {
        setError('Failed to load activity feed');
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  // Reload whenever page or pageSize changes
  useEffect(() => {
    loadEvents(page, pageSize);
  }, [loadEvents, page, pageSize]);

  // Real-time update simulation — prepends a new event every 15 seconds
  useEffect(() => {
    if (!realTimeEnabled) return;

    const interval = setInterval(() => {
      const [newEvent] = generateMockActivityEvents(1);

      setLiveEvents((prev) => [newEvent, ...prev]);
      setTotal((prev) => prev + 1);
    }, 15000);

    return () => clearInterval(interval);
  }, [realTimeEnabled]);

  const handlePageChange = (newPage: number) => {
    setPage(newPage);

    // Clear live events on navigation so the count stays consistent
    setLiveEvents([]);
  };

  const handleLimitChange = (newLimit: number) => {
    setPageSize(newLimit);
    setPage(1);
    setLiveEvents([]);
  };

  // Clear stale activity and re-fetch from page 1 whenever the connected
  // wallet address changes (switch or disconnect). This is the fix for issue #175.
  useWalletAccountSync(() => {
    setEvents([]);
    setLiveEvents([]);
    setTotal(0);
    setPage(1);

    loadEvents(1, pageSize);
  });

  // Events shown: live prepended events (only on page 1) + paginated events
  const displayedEvents =
    page === 1 ? [...liveEvents, ...events] : events;

  return (
    <section
      className="activity-feed"
      aria-labelledby="activity-feed-title"
    >
      <div className="activity-feed__header">
        <div>
          <h2
            id="activity-feed-title"
            className="activity-feed__title"
          >
            Activity Feed
          </h2>

          <p className="activity-feed__subtitle">
            Recent actions and system events ({total.toLocaleString()} total)
          </p>
        </div>

        <button
          type="button"
          className={`activity-feed__toggle-realtime ${
            realTimeEnabled
              ? 'activity-feed__toggle-realtime--active'
              : ''
          }`}
          onClick={() => setRealTimeEnabled(!realTimeEnabled)}
          aria-pressed={realTimeEnabled}
          aria-label={
            realTimeEnabled
              ? 'Pause live activity updates'
              : 'Resume live activity updates'
          }
        >
          {realTimeEnabled ? '🔴 Live' : '⏸ Paused'}
        </button>
      </div>

      {error && (
        <div className="activity-feed__error" role="alert">
          <p>{error}</p>

          <button
            type="button"
            className="activity-feed__retry"
            onClick={() => loadEvents(page, pageSize)}
          >
            Retry
          </button>
        </div>
      )}

      <div
        className="activity-feed__list"
        role="list"
        aria-label="Activity events"
      >
        {loading && events.length === 0 ? (
          Array.from({ length: 5 }).map((_, i) => (
            <ActivitySkeleton key={i} />
          ))
        ) : displayedEvents.length === 0 ? (
          <EmptyState
            size="compact"
            title="No activity yet"
            message="System events, notification deliveries, and contract activity will appear here as they occur."
            className="empty-state--compact"
          />
        ) : (
          displayedEvents.map((event) => (
            <ActivityEventCard key={event.id} event={event} />
          ))
        )}
      </div>

      <PaginationControls
        page={page}
        pageCount={pageCount}
        limit={pageSize}
        totalCount={total}
        onPageChange={handlePageChange}
        onLimitChange={handleLimitChange}
      />
    </section>
  );
}