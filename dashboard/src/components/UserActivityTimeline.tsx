import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  fetchUserActivityTimeline,
  generateMockUserActivity,
  sortUserActivityChronologically,
} from '../services/userActivityApi';
import type { UserActivityEvent } from '../types/userActivity';
import { formatTimestamp } from '../utils/formatTime';

const ACTION_LABELS: Record<UserActivityEvent['action'], string> = {
  subscription_created: 'Subscription created',
  subscription_updated: 'Subscription updated',
  subscription_cancelled: 'Subscription cancelled',
  notification_preference_changed: 'Preferences changed',
  notification_muted: 'Notification muted',
  notification_unmuted: 'Notification unmuted',
  template_managed: 'Template managed',
  export_requested: 'Export requested',
};

function ActivityItem({ event }: { event: UserActivityEvent }) {
  return (
    <li className="user-activity__item">
      <div className="user-activity__rail" aria-hidden="true">
        <span className="user-activity__dot" />
      </div>
      <article className="user-activity__card" aria-label={event.summary}>
        <div className="user-activity__meta">
          <span className="user-activity__action">{ACTION_LABELS[event.action]}</span>
          <time dateTime={new Date(event.timestamp).toISOString()}>
            {formatTimestamp(event.timestamp)}
          </time>
        </div>
        <p className="user-activity__summary">{event.summary}</p>
        {event.details && <p className="user-activity__details">{event.details}</p>}
      </article>
    </li>
  );
}

export function UserActivityTimeline() {
  const [events, setEvents] = useState<UserActivityEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [usingMock, setUsingMock] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchUserActivityTimeline();
      setEvents(sortUserActivityChronologically(data.events));
      setUsingMock(false);
    } catch {
      setEvents(sortUserActivityChronologically(generateMockUserActivity()));
      setUsingMock(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const chronological = useMemo(() => sortUserActivityChronologically(events), [events]);

  return (
    <section className="user-activity" aria-labelledby="user-activity-title">
      <div className="user-activity__header">
        <div>
          <h2 id="user-activity-title" className="user-activity__title">
            User Activity Timeline
          </h2>
          <p className="user-activity__subtitle">
            Recent actions related to subscriptions and notification management
            {usingMock ? ' (sample data)' : ''}
          </p>
        </div>
        <button type="button" className="user-activity__refresh" onClick={() => void load()}>
          Refresh
        </button>
      </div>

      {loading && chronological.length === 0 && (
        <p className="user-activity__loading" role="status">
          Loading activity timeline…
        </p>
      )}

      {error && (
        <div className="user-activity__error" role="alert">
          {error}
        </div>
      )}

      {!loading && chronological.length === 0 ? (
        <div className="user-activity__empty" role="status">
          <p>No recent activity yet.</p>
          <p>Subscription and notification actions will appear here chronologically.</p>
        </div>
      ) : chronological.length > 0 ? (
        <ol className="user-activity__list" aria-label="User activity events">
          {chronological.map((event) => (
            <ActivityItem key={event.id} event={event} />
          ))}
        </ol>
      ) : null}
    </section>
  );
}
