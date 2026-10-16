/**
 * Types for the Webhook Delivery Performance Dashboard.
 */

export type WebhookStatusCode =
  | 200
  | 201
  | 204
  | 400
  | 401
  | 403
  | 404
  | 408
  | 409
  | 422
  | 429
  | 500
  | 502
  | 503
  | 504;

export type WebhookDeliveryStatus = 'success' | 'failed' | 'pending' | 'retrying';

export type WebhookErrorCategory = '4xx' | '5xx' | 'timeout' | 'network';

export interface WebhookDelivery {
  id: string;
  /** The webhook event type (e.g. "transfer", "mint", "burn") */
  eventType: string;
  /** Target endpoint URL */
  targetUrl: string;
  /** HTTP status code returned by the target (null if no response) */
  httpStatus: WebhookStatusCode | null;
  /** Raw error payload or message, if any */
  errorPayload: string | null;
  /** Delivery outcome */
  status: WebhookDeliveryStatus;
  /** Round-trip latency in milliseconds (null if failed before response) */
  latencyMs: number | null;
  /** Unix timestamp (ms) when the delivery attempt was made */
  attemptedAt: number;
  /** Which attempt number (1 = first, 2+ = retry) */
  attemptNumber: number;
}

export interface WebhookMetricBucket {
  /** ISO date-hour string, e.g. "2026-06-26T14" */
  label: string;
  /** Human-friendly label for display */
  displayLabel: string;
  successCount: number;
  failedCount: number;
  totalCount: number;
  /** Average latency for successful deliveries in this bucket (ms) */
  avgLatencyMs: number | null;
}

export interface WebhookSummaryMetrics {
  totalAttempts: number;
  successCount: number;
  failedCount: number;
  /** Overall success rate as a percentage (0-100), rounded to 2 decimal places */
  successRate: number;
  /** Average latency across all successful deliveries (ms), or null if none */
  avgLatencyMs: number | null;
  /** P95 latency across successful deliveries (ms), or null if none */
  p95LatencyMs: number | null;
}

export type WebhookDateRange = '1h' | '6h' | '24h' | '7d';

export interface WebhookFilters {
  dateRange: WebhookDateRange;
  /** "all" | specific event type string */
  eventType: string;
  /** "all" | "4xx" | "5xx" | "timeout" | "network" */
  errorCategory: string;
  /** "all" | "success" | "failed" */
  statusFilter: string;
}
