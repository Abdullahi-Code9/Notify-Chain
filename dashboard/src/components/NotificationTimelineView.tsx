import { useState, useCallback } from 'react';
import type {
  NotificationTimeline,
  TimelineEntry,
  TimelineStatus,
} from '../types/timeline';
import { fetchTimeline } from '../services/timelineApi';
import { formatTimestamp } from '../utils/formatTime';
import { EmptyState } from './EmptyState';
import { CopyButton } from './CopyButton';
import { FormField, FormInput } from './FormField';

const STATUS_LABEL: Record<TimelineStatus, string> = {
  PENDING: 'Pending',
  PROCESSING: 'Processing',
  COMPLETED: 'Delivered',
  FAILED: 'Failed',
  RETRY: 'Retrying',
};

const STATUS_CLASS: Record<TimelineStatus, string> = {
  PENDING: 'timeline__dot--pending',
  PROCESSING: 'timeline__dot--processing',
  COMPLETED: 'timeline__dot--completed',
  FAILED: 'timeline__dot--failed',
  RETRY: 'timeline__dot--retry',
};

function TimelineEntryItem({ entry }: { entry: TimelineEntry }) {
  const ts = new Date(entry.executionTime).getTime();

  return (
    <li className="timeline__entry">
      <span
        className={`timeline__dot ${STATUS_CLASS[entry.status] ?? ''}`}
        aria-hidden="true"
      />

      <div className="timeline__entry-body">
        <div className="timeline__entry-header">
          <span className="timeline__entry-label">
            {STATUS_LABEL[entry.status] ?? entry.status}
          </span>

          {entry.attempt > 0 && (
            <span className="timeline__entry-attempt">
              Attempt {entry.attempt}
            </span>
          )}

          <time
            className="timeline__entry-time"
            dateTime={entry.executionTime}
          >
            {formatTimestamp(ts)}
          </time>
        </div>

        {entry.errorMessage && (
          <p className="timeline__entry-error">
            {entry.errorMessage}
          </p>
        )}

        {entry.durationMs != null && (
          <span className="timeline__entry-duration">
            {entry.durationMs} ms
          </span>
        )}
      </div>
    </li>
  );
}

function TimelineSkeleton() {
  return (
    <ul
      className="timeline__list"
      aria-busy="true"
      aria-label="Loading timeline"
    >
      {[1, 2, 3].map((i) => (
        <li key={i} className="timeline__entry">
          <span
            className="timeline__dot timeline__dot--skeleton"
            aria-hidden="true"
          />

          <div className="timeline__entry-body">
            <div
              className="timeline__skeleton-line"
              style={{ width: '60%' }}
            />
            <div
              className="timeline__skeleton-line"
              style={{ width: '40%' }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}

export function NotificationTimelineView() {
  const [inputValue, setInputValue] = useState('');
  const [timeline, setTimeline] =
    useState<NotificationTimeline | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSearch = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();

      const id = parseInt(inputValue.trim(), 10);

      if (isNaN(id) || id <= 0) {
        setError('Please enter a valid notification ID.');
        return;
      }

      setLoading(true);
      setError(null);
      setTimeline(null);

      try {
        const data = await fetchTimeline(id);

        const sorted = [...data.entries].sort(
          (a, b) =>
            new Date(a.executionTime).getTime() -
            new Date(b.executionTime).getTime(),
        );

        setTimeline({
          ...data,
          entries: sorted,
        });
      } catch (err) {
        setError(
          err instanceof Error ? err.message : 'Unknown error',
        );
      } finally {
        setLoading(false);
      }
    },
    [inputValue],
  );

  const overallStatus = timeline?.status;

  return (
    <section
      className="timeline-view"
      aria-labelledby="timeline-heading"
    >
      <h2 id="timeline-heading" className="timeline-view__title">
        Notification Delivery Timeline
      </h2>

      <form
        className="timeline-view__form"
        onSubmit={handleSearch}
        role="search"
      >
        <FormField
          id="timeline-id-input"
          label="Notification ID"
          error={error ? `Notification ID: ${error}` : null}
        >
          <div className="timeline-view__input-row">
            <FormInput
              fieldId="timeline-id-input"
              type="number"
              min="1"
              className="timeline-view__input"
              placeholder="e.g. 42"
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              error={error ? `Notification ID: ${error}` : null}
            />

            <button
              type="submit"
              className="timeline-view__btn"
              disabled={loading}
            >
              {loading ? 'Loading…' : 'View Timeline'}
            </button>
          </div>
        </FormField>
      </form>

      {loading && <TimelineSkeleton />}

      {!loading &&
        timeline &&
        timeline.entries.length === 0 && (
          <EmptyState
            className="empty-state--compact"
            icon="📭"
            title="No history entries"
            description={`No delivery history found for notification #${timeline.notificationId}.`}
          >
            <p className="timeline-view__empty-sub">
              Current status:{' '}
              <strong>
                {overallStatus
                  ? STATUS_LABEL[overallStatus] ?? overallStatus
                  : 'Unknown'}
              </strong>
            </p>
          </EmptyState>
        )}

      {!loading &&
        timeline &&
        timeline.entries.length > 0 && (
          <div className="timeline-view__results">
            <div className="timeline-view__summary">
              <span>
                Notification{' '}
                <strong>#{timeline.notificationId}</strong>
              </span>

              <CopyButton
                value={String(timeline.notificationId)}
                label="notification ID"
                size="xs"
              />

              <span
                className={`timeline__dot ${
                  overallStatus
                    ? STATUS_CLASS[overallStatus] ?? ''
                    : ''
                } timeline__dot--inline`}
                aria-hidden="true"
              />

              <span>
                <strong>
                  {overallStatus
                    ? STATUS_LABEL[overallStatus] ?? overallStatus
                    : 'Unknown'}
                </strong>
              </span>

              <span className="timeline-view__summary-retries">
                Retries: {timeline.retryCount} / {timeline.maxRetries}
              </span>
            </div>

            <ol
              className="timeline__list"
              aria-label="Notification history"
            >
              {timeline.entries.map((entry, idx) => (
                <TimelineEntryItem
                  key={idx}
                  entry={entry}
                />
              ))}
            </ol>

            {timeline.nextRetryAt && (
              <p className="timeline-view__next-retry">
                Next retry scheduled:{' '}
                <time dateTime={timeline.nextRetryAt}>
                  {formatTimestamp(
                    new Date(timeline.nextRetryAt).getTime(),
                  )}
                </time>
              </p>
            )}

            {timeline.lastError &&
              overallStatus === 'FAILED' && (
                <p className="timeline-view__last-error">
                  Last error: {timeline.lastError}
                </p>
              )}
          </div>
        )}

      {!loading && !timeline && !error && (
        <EmptyState
          size="inline"
          message="Enter a notification ID above to view its delivery history."
        />
      )}
    </section>
  );
}