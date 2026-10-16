import type { ScheduleStatsResponse } from '../types/notificationHealth';
import type { NotificationSummaryMetrics } from '../types/notificationSummary';

/**
 * Map the listener's schedule statistics onto the three delivery buckets
 * surfaced by the summary cards.
 *
 * - `completed`                                  → delivered
 * - `pending + processing + overdue`             → pending  (overdue jobs are
 *   still awaiting delivery, just delayed)
 * - `failed`                                     → failed
 *
 * This keeps the three buckets exhaustive: `delivered + pending + failed`
 * always equals the sum of all schedule statistics, so the delivered rate is
 * always grounded in a real total.
 */
export function computeNotificationSummary(
  stats: ScheduleStatsResponse,
): NotificationSummaryMetrics {
  const delivered = stats.completed;
  const pending = stats.pending + stats.processing + stats.overdue;
  const failed = stats.failed;
  const total = delivered + pending + failed;
  const deliveredRate = total === 0 ? 0 : (delivered / total) * 100;

  return {
    delivered,
    pending,
    failed,
    total,
    deliveredRate,
  };
}

/**
 * Deterministic mock summary used when the listener API is unavailable
 * (local development / offline). Values are static so rendered output is
 * stable across refreshes and test snapshots. The delivered rate is derived
 * the same way as `computeNotificationSummary` so display output matches the
 * real path exactly.
 */
export function generateMockNotificationSummary(): NotificationSummaryMetrics {
  const delivered = 1842;
  const pending = 217;
  const failed = 83;
  const total = delivered + pending + failed;

  return {
    delivered,
    pending,
    failed,
    total,
    deliveredRate: total === 0 ? 0 : (delivered / total) * 100,
  };
}
