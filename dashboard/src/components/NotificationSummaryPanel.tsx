import { useNotificationSummary } from '../hooks/useNotificationSummary';
import { NotificationSummaryCards } from './NotificationSummaryCards';
import { formatTimestampShort } from '../utils/formatTime';

const DEFAULT_POLL_INTERVAL_MS = 5000;

export interface NotificationSummaryPanelProps {
  /** Listener API base URL (origin) to read schedule statistics from. */
  apiUrl: string;
  /** Override the background refresh interval. */
  pollIntervalMs?: number;
}

/**
 * Self-contained notification delivery summary panel.
 *
 * Polls the listener's schedule statistics and renders three KPI cards
 * (Delivered, Pending, Failed) via `NotificationSummaryCards`. Shows a loading
 * skeleton on first fetch, an error/Mock-data banner when the API is
 * unreachable, and a live "last updated" timestamp so consumers can see the
 * summary updating dynamically.
 */
export function NotificationSummaryPanel({
  apiUrl,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
}: NotificationSummaryPanelProps) {
  const { summary, isLoading, error, isMockData, lastRefreshedAt, refresh } =
    useNotificationSummary(apiUrl, pollIntervalMs);

  return (
    <section className="notification-summary-panel" aria-labelledby="notif-summary-title">
      <div className="notification-summary-panel__header">
        <div>
          <p className="notification-summary-panel__eyebrow">Overview</p>
          <h2 id="notif-summary-title" className="notification-summary-panel__title">
            Notification Delivery Summary
          </h2>
        </div>

        <div className="notification-summary-panel__meta">
          <span className="notification-summary-panel__updated">
            {isLoading
              ? 'Updating…'
              : `Updated ${formatTimestampShort(lastRefreshedAt ?? Date.now())}`}
          </span>
          <button
            type="button"
            className="notification-summary-panel__refresh"
            onClick={() => void refresh()}
            aria-label="Refresh notification summary"
            disabled={isLoading}
          >
            {isLoading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </div>

      {error && (
        <p className="notification-summary-panel__banner" role="alert">
          {isMockData
            ? 'Listener API unavailable — showing sample data.'
            : `Unable to load notification summary: ${error}`}
        </p>
      )}

      <NotificationSummaryCards summary={summary} isLoading={isLoading} />
    </section>
  );
}
