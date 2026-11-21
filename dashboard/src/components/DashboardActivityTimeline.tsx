import type { BlockchainEvent } from '../types/event';
import { formatTimestamp } from '../utils/formatTime';
import { EmptyState } from './EmptyState';

const MAX_TIMELINE_EVENTS = 50;

type ActivityStatus = 'successful' | 'pending' | 'failed';

function getActivityStatus(event: BlockchainEvent): ActivityStatus {
  const eventName = (event.eventName ?? event.type).toLowerCase();
  if (eventName.includes('fail')) return 'failed';
  if (
    event.notificationStatus === 'active' ||
    eventName.includes('scheduled') ||
    eventName.includes('processing') ||
    eventName.includes('retry') ||
    eventName.includes('pending')
  ) {
    return 'pending';
  }
  return 'successful';
}

function statusLabel(status: ActivityStatus): string {
  switch (status) {
    case 'pending':
      return 'Pending';
    case 'failed':
      return 'Failed';
    case 'successful':
      return 'Successful';
  }
}

function eventHref(event: BlockchainEvent): string {
  const url = new URL(window.location.href);
  url.searchParams.set('eventId', event.eventId);
  url.hash = 'explorer';
  return `${url.pathname}${url.search}${url.hash}`;
}

interface DashboardActivityTimelineProps {
  events: BlockchainEvent[];
  isLoading: boolean;
  error: string | null;
  onRetry: () => void;
  onSelectEvent: (event: BlockchainEvent) => void;
}

export function DashboardActivityTimeline({
  events,
  isLoading,
  error,
  onRetry,
  onSelectEvent,
}: DashboardActivityTimelineProps) {
  const chronological = [...events]
    .sort((a, b) => a.receivedAt - b.receivedAt)
    .slice(-MAX_TIMELINE_EVENTS);

  return (
    <section className="dashboard-activity" aria-labelledby="dashboard-activity-title">
      <header className="dashboard-activity__header">
        <div>
          <h2 id="dashboard-activity-title">Dashboard Activity Timeline</h2>
          <p>Event detection and notification lifecycle milestones, in chronological order.</p>
        </div>
        {error && (
          <button type="button" className="event-explorer__retry-button" onClick={onRetry}>
            Retry
          </button>
        )}
      </header>

      {error && (
        <p className="dashboard-activity__error" role="alert">
          Activity data is unavailable: {error}
        </p>
      )}

      {isLoading && chronological.length === 0 ? (
        <div className="dashboard-activity__skeleton" role="status" aria-busy="true">
          <span />
          <span />
          <span />
          <span />
        </div>
      ) : chronological.length === 0 ? (
        <EmptyState
          size="compact"
          icon="🕒"
          title={error ? 'Timeline unavailable' : 'No activity yet'}
          message={
            error
              ? 'The timeline could not be loaded. Retry to request the latest activity.'
              : 'Detected events and notification milestones will appear here.'
          }
          action={error ? { label: 'Retry timeline', onClick: onRetry } : undefined}
        />
      ) : (
        <ol className="dashboard-activity__list" aria-label="Dashboard activity">
          {chronological.map((event) => {
            const status = getActivityStatus(event);
            const date = new Date(event.receivedAt);
            const eventName = event.eventName ?? event.type;

            return (
              <li className="dashboard-activity__item" key={event.eventId}>
                <span
                  className={`dashboard-activity__status dashboard-activity__status--${status}`}
                  aria-label={statusLabel(status)}
                />
                <div className="dashboard-activity__content">
                  <div className="dashboard-activity__meta">
                    <span>Event detected</span>
                    <span
                      className={`dashboard-activity__badge dashboard-activity__badge--${status}`}
                    >
                      {statusLabel(status)}
                    </span>
                    <time dateTime={Number.isNaN(date.getTime()) ? undefined : date.toISOString()}>
                      {formatTimestamp(event.receivedAt)}
                    </time>
                  </div>
                  <a
                    className="dashboard-activity__event-link"
                    href={eventHref(event)}
                    onClick={(clickEvent) => {
                      if (clickEvent.button === 0 && !clickEvent.metaKey && !clickEvent.ctrlKey) {
                        clickEvent.preventDefault();
                        onSelectEvent(event);
                      }
                    }}
                  >
                    {eventName}
                  </a>
                  <p className="dashboard-activity__details">
                    Ledger {event.ledger.toLocaleString()}
                    {event.txHash && <span> · Transaction {event.txHash}</span>}
                    {event.notificationStatus && (
                      <span> · Notification {event.notificationStatus}</span>
                    )}
                  </p>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
