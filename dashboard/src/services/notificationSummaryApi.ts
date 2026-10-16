import type { NotificationSummaryMetrics } from '../types/notificationSummary';
import {
  computeNotificationSummary,
  generateMockNotificationSummary,
} from '../utils/notificationSummaryData';
import { fetchScheduleStats } from './notificationHealthApi';

export { generateMockNotificationSummary };

/**
 * Fetch notification delivery summary counts from the listener's schedule
 * statistics endpoint (`GET /api/schedule/stats`).
 *
 * Reuses the existing schedule-stats client so the summary stays consistent
 * with the Notification Health panel. Throws on non-ok responses so callers
 * can fall back to mock data.
 */
export async function fetchNotificationSummary(
  apiUrl: string,
): Promise<NotificationSummaryMetrics> {
  const stats = await fetchScheduleStats(apiUrl);
  return computeNotificationSummary(stats);
}
