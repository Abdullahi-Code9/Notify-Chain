/**
 * Types and formatters for the notification delivery summary cards.
 *
 * The summary buckets every tracked notification into one of three delivery
 * outcomes — delivered, pending, or failed — derived from the listener's
 * schedule statistics (`GET /api/schedule/stats`).
 */

export interface NotificationSummaryMetrics {
  /** Successfully delivered notifications (completed processing). */
  delivered: number;
  /**
   * Notifications awaiting delivery or currently in flight, including overdue
   * jobs (an overdue job is still awaiting delivery, just delayed).
   */
  pending: number;
  /** Notifications that failed or were cancelled (terminal non-delivery). */
  failed: number;
  /** Total notifications covered by the summary. */
  total: number;
  /** Share of delivered notifications (0–100), rounded to 1 decimal place. */
  deliveredRate: number;
}

/** Format an integer count for display with locale-aware grouping. */
export function formatCount(value: number): string {
  return value.toLocaleString();
}

/** Format a 0–100 success rate as a percentage string, e.g. `85.9%`. */
export function formatDeliveredRate(rate: number): string {
  return `${rate.toFixed(1)}%`;
}
