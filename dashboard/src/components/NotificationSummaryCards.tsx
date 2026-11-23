import { memo } from 'react';
import type { NotificationSummaryMetrics } from '../types/notificationSummary';
import { formatCount, formatDeliveredRate } from '../types/notificationSummary';
import { useLocaleFormat } from '../utils/formatting';

interface NotificationSummaryCardsProps {
  summary: NotificationSummaryMetrics | null;
  /** When true, skeleton placeholders are rendered in place of real values. */
  isLoading: boolean;
}

type CardAccent = 'green' | 'yellow' | 'red';

interface MetricCardProps {
  label: string;
  value: string;
  /** Raw, unformatted value preserved for copying and machine-readable exports. */
  rawValue?: string;
  subValue?: string;
  /** Raw, unformatted sub value preserved for copying and machine-readable exports. */
  rawSubValue?: string;
  accent: CardAccent;
  isLoading: boolean;
}

function MetricCard({
  label,
  value,
  rawValue,
  subValue,
  rawSubValue,
  accent,
  isLoading,
}: MetricCardProps) {
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
          <span className="notification-summary__card-number" data-raw={rawValue}>
            {value}
          </span>
          {subValue && (
            <span className="notification-summary__card-sub" data-raw={rawSubValue}>
              {subValue}
            </span>
          )}
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
  const { formatNumber } = useLocaleFormat();

  const delivered = summary?.delivered ?? 0;
  const pending = summary?.pending ?? 0;
  const failed = summary?.failed ?? 0;
  const deliveredRate = summary?.deliveredRate ?? 0;

  const deliveredStr = isLoading ? '—' : formatNumber(delivered);
  const pendingStr = isLoading ? '—' : formatNumber(pending);
  const failedStr = isLoading ? '—' : formatNumber(failed);
  const rateStr = isLoading ? undefined : formatDeliveredRate(deliveredRate);

  return (
    <dl className="notification-summary" aria-label="Notification delivery summary">
      <MetricCard
        label="Delivered"
        value={deliveredStr}
        rawValue={String(delivered)}
        subValue={rateStr ? `Deliver rate: ${rateStr}` : undefined}
        rawSubValue={rateStr ? String(deliveredRate) : undefined}
        accent="green"
        isLoading={isLoading}
      />
      <MetricCard
        label="Pending"
        value={pendingStr}
        rawValue={String(pending)}
        accent="yellow"
        isLoading={isLoading}
      />
      <MetricCard
        label="Failed"
        value={failedStr}
        rawValue={String(failed)}
        accent="red"
        isLoading={isLoading}
      />
    </dl>
  );
});
