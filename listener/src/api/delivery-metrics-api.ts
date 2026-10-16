/**
 * Delivery Metrics API  (Issue #482)
 *
 * Exposes notification delivery statistics through a dedicated endpoint so
 * operators can monitor notification performance without connecting directly
 * to the database.
 *
 * Routes (all prefixed /api/notifications/delivery-metrics):
 *
 *   GET /api/notifications/delivery-metrics
 *     Returns a real-time analytics snapshot from the in-memory aggregator.
 *     Optional query params:
 *       ?reset=true   — resets the in-memory window after reading (useful for
 *                       interval-based scraping)
 *
 *   GET /api/notifications/delivery-metrics/history
 *     Returns persisted historical snapshots from the metrics store.
 *     Optional query params:
 *       ?limit=<n>    — max snapshots to return (default 50)
 *       ?since=<iso>  — only snapshots captured on or after this ISO-8601 date
 *
 * Response shape (current snapshot):
 * {
 *   "totalRecorded": 1200,
 *   "windowStart": 1700000000000,
 *   "windowEnd":   1700003600000,
 *   "overall": {
 *     "total": 1200, "success": 1150, "failure": 30,
 *     "retry": 20, "skipped": 0, "successRate": 0.958,
 *     "averageDurationMs": 312
 *   },
 *   "byType":     [...],
 *   "byContract": [...],
 *   "hourlyBuckets": [...],
 *   "errorBreakdown": { "TIMEOUT": 18, "INVALID_RECIPIENT": 12 }
 * }
 */

import http from 'http';
import { sendOk, sendErr, ErrorCode } from '../utils/response';
import logger from '../utils/logger';
import {
  NotificationAnalyticsAggregator,
  getNotificationAnalyticsAggregator,
} from '../services/notification-analytics-aggregator';
import { NotificationMetricsStore } from '../services/notification-metrics-store';

export interface DeliveryMetricsHandlerOptions {
  /** Override the aggregator (useful in tests). */
  analyticsAggregator?: NotificationAnalyticsAggregator | null;
  /** Persisted metrics store for history endpoint. */
  metricsStore?: NotificationMetricsStore | null;
}

/**
 * Handle GET /api/notifications/delivery-metrics
 *
 * Returns the live analytics snapshot and optionally resets the window.
 */
function handleCurrentMetrics(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  options: DeliveryMetricsHandlerOptions,
  meta: { requestId: string; correlationId: string; startTime: number },
): void {
  const aggregator =
    options.analyticsAggregator !== undefined
      ? options.analyticsAggregator
      : getNotificationAnalyticsAggregator();

  if (!aggregator) {
    sendErr(res, 503, 'Delivery metrics unavailable: aggregator not initialised', ErrorCode.SERVICE_UNAVAILABLE);
    return;
  }

  const snapshot = aggregator.snapshot();
  const reset = url.searchParams.get('reset') === 'true';

  logger.info('Handling GET /api/notifications/delivery-metrics', {
    requestId: meta.requestId,
    correlationId: meta.correlationId,
    totalRecorded: snapshot.totalRecorded,
    successRate: snapshot.overall.successRate,
    reset,
    durationMs: Date.now() - meta.startTime,
  });

  sendOk(res, 200, snapshot);

  if (reset) {
    aggregator.reset();
    logger.info('Delivery metrics window reset after read', {
      requestId: meta.requestId,
      correlationId: meta.correlationId,
    });
  }
}

/**
 * Handle GET /api/notifications/delivery-metrics/history
 *
 * Returns persisted metric snapshots ordered newest-first.
 */
function handleMetricsHistory(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  options: DeliveryMetricsHandlerOptions,
  meta: { requestId: string; correlationId: string; startTime: number },
): void {
  if (!options.metricsStore) {
    sendErr(res, 503, 'Metrics history unavailable: store not initialised', ErrorCode.SERVICE_UNAVAILABLE);
    return;
  }

  const limitParam = url.searchParams.get('limit');
  const sinceParam = url.searchParams.get('since');

  const limit = limitParam ? Math.max(1, Math.min(500, parseInt(limitParam, 10) || 50)) : 50;
  const since = sinceParam ? new Date(sinceParam) : undefined;

  if (since && isNaN(since.getTime())) {
    sendErr(res, 400, "Invalid 'since' date — must be ISO-8601", ErrorCode.BAD_REQUEST);
    return;
  }

  logger.info('Handling GET /api/notifications/delivery-metrics/history', {
    requestId: meta.requestId,
    correlationId: meta.correlationId,
    limit,
    since: since?.toISOString(),
  });

  options.metricsStore
    .getHistory(limit, since)
    .then((snapshots) => {
      sendOk(res, 200, { count: snapshots.length, snapshots });
      logger.info('GET /api/notifications/delivery-metrics/history complete', {
        requestId: meta.requestId,
        correlationId: meta.correlationId,
        count: snapshots.length,
        durationMs: Date.now() - meta.startTime,
      });
    })
    .catch((error) => {
      logger.error('Failed to fetch delivery metrics history', {
        error,
        requestId: meta.requestId,
        correlationId: meta.correlationId,
      });
      sendErr(res, 500, (error as Error).message, ErrorCode.INTERNAL_ERROR);
    });
}

/**
 * Route handler — call this from the main events-server request dispatcher.
 *
 * Returns `true` when the request was handled (regardless of status code),
 * `false` when the pathname did not match so the caller can continue routing.
 */
export function handleDeliveryMetricsRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  options: DeliveryMetricsHandlerOptions,
  meta: { requestId: string; correlationId: string; startTime: number },
): boolean {
  if (req.method !== 'GET') return false;

  if (url.pathname === '/api/notifications/delivery-metrics/history') {
    handleMetricsHistory(req, res, url, options, meta);
    return true;
  }

  if (url.pathname === '/api/notifications/delivery-metrics') {
    handleCurrentMetrics(req, res, url, options, meta);
    return true;
  }

  return false;
}
