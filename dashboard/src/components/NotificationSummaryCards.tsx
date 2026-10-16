import { memo } from 'react';
import type { NotificationSummaryMetrics } from '../types/notificationSummary';
import { formatCount, formatDeliveredRate } from '../types/notificationSummary';

interface NotificationSummaryCardsProps {
  summary: NotificationSummaryMetrics | null;
  /** When true, skeleton placeholders are rendered in place of real values. */
  isLoading: boolean;
}

type CardAccent = 'green' | 'yellow' | 'red';

interface MetricCardProps {
  label: string;
  value: string;
  subValue?: string;
  accent: CardAccent;
  isLoading: boolean;
}

function MetricCard({ label, value, subValue, accent, isLoading }: MetricCardProps) {
  return (
    <div
      className={`notification-summary__card notification-summary__card--${accent}`}
      aria-busy={isLoading}
    >
      <dt className="notification-summary__card-label">{label}</dt>
      {isLoading ? (
        <dd className="notification-summary__card-value">
          <span className="notification-summary__skeleton" aria-hidden="true" />
        </dd>
      ) : (
        <dd className="notification-summary__card-value">
          <span className="notification-summary__card-number">{value}</span>
          {subValue && <span className="notification-summary__card-sub">{subValue}</span>}
        </dd>
      )}
    </div>
  );
}

/**
 * Presentational summary cards for notification delivery status.
 *
 * Renders three KPIs — Delivered, Pending, and Failed — backed by the
 * `NotificationSummaryMetrics` returned from `computeNotificationSummary`.
 * While `isLoading` is true (initial fetch or refresh), each card renders a
 * shimmering skeleton placeholder so the layout is stable.
 *
 * The component is pure: pass the data and a loading flag in and it renders.
 */
export const NotificationSummaryCards = memo(function NotificationSummaryCards({
  summary,
  isLoading,
}: NotificationSummaryCardsProps) {
  const deliveredStr = isLoading ? '—' : formatCount(summary?.delivered ?? 0);
  const pendingStr = isLoading ? '—' : formatCount(summary?.pending ?? 0);
  const failedStr = isLoading ? '—' : formatCount(summary?.failed ?? 0);
  const rateStr = isLoading ? undefined : formatDeliveredRate(summary?.deliveredRate ?? 0);

  return (
    <dl className="notification-summary" aria-label="Notification delivery summary">
      <MetricCard
        label="Delivered"
        value={deliveredStr}
        subValue={rateStr ? `Deliver rate: ${rateStr}` : undefined}
        accent="green"
        isLoading={isLoading}
      />
      <MetricCard label="Pending" value={pendingStr} accent="yellow" isLoading={isLoading} />
      <MetricCard label="Failed" value={failedStr} accent="red" isLoading={isLoading} />
    </dl>
  );
});
