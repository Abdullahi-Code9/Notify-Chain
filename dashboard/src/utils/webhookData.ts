import type {
  WebhookDelivery,
  WebhookDeliveryStatus,
  WebhookErrorCategory,
  WebhookFilters,
  WebhookMetricBucket,
  WebhookStatusCode,
  WebhookSummaryMetrics,
} from '../types/webhook';

// ─── Mock data generation ──────────────────────────────────────────────────

const EVENT_TYPES = ['transfer', 'mint', 'burn', 'swap', 'stake', 'unstake', 'vote'];
const TARGET_URLS = [
  'https://api.example.com/webhooks/notify',
  'https://hooks.slack.com/services/T000/B000/xxxx',
  'https://discord.com/api/webhooks/000/yyyy',
  'https://my-app.vercel.app/api/chain-events',
  'https://alerts.internal.io/soroban',
];

const SUCCESS_CODES: WebhookStatusCode[] = [200, 201, 204];
const CLIENT_ERROR_CODES: WebhookStatusCode[] = [400, 401, 403, 404, 408, 409, 422, 429];
const SERVER_ERROR_CODES: WebhookStatusCode[] = [500, 502, 503, 504];

const ERROR_PAYLOADS: Record<number, string> = {
  400: '{"error":"Bad Request","message":"Malformed event payload"}',
  401: '{"error":"Unauthorized","message":"Invalid or missing API key"}',
  403: '{"error":"Forbidden","message":"IP address not allowlisted"}',
  404: '{"error":"Not Found","message":"Webhook endpoint not registered"}',
  408: '{"error":"Request Timeout","message":"Upstream timed out after 10s"}',
  409: '{"error":"Conflict","message":"Duplicate event ID detected"}',
  422: '{"error":"Unprocessable Entity","message":"Event schema validation failed"}',
  429: '{"error":"Too Many Requests","message":"Rate limit exceeded; retry after 60s"}',
  500: '{"error":"Internal Server Error","message":"Unexpected exception in handler"}',
  502: '{"error":"Bad Gateway","message":"Upstream service returned invalid response"}',
  503: '{"error":"Service Unavailable","message":"Target service is under maintenance"}',
  504: '{"error":"Gateway Timeout","message":"Connection to upstream timed out"}',
};

function seededRandom(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) & 0xffffffff;
    return (s >>> 0) / 0xffffffff;
  };
}

/**
 * Generates a deterministic set of mock webhook deliveries over the past `hours` hours.
 * A fixed seed ensures the data is stable across re-renders.
 */
export function generateMockWebhookDeliveries(
  count: number = 400,
  hours: number = 24,
  seed: number = 42,
): WebhookDelivery[] {
  const rand = seededRandom(seed);
  const now = Date.now();
  const windowMs = hours * 60 * 60 * 1000;
  const deliveries: WebhookDelivery[] = [];

  for (let i = 0; i < count; i++) {
    const offsetMs = rand() * windowMs;
    const attemptedAt = now - offsetMs;

    const eventType = EVENT_TYPES[Math.floor(rand() * EVENT_TYPES.length)];
    const targetUrl = TARGET_URLS[Math.floor(rand() * TARGET_URLS.length)];
    const attemptNumber = rand() < 0.85 ? 1 : Math.floor(rand() * 3) + 2;

    // ~78% success rate to make the dashboard interesting
    const outcome = rand();
    let status: WebhookDeliveryStatus;
    let httpStatus: WebhookStatusCode | null;
    let errorPayload: string | null = null;
    let latencyMs: number | null;

    if (outcome < 0.78) {
      // Success
      status = 'success';
      httpStatus = SUCCESS_CODES[Math.floor(rand() * SUCCESS_CODES.length)];
      latencyMs = Math.round(80 + rand() * 520); // 80–600 ms
    } else if (outcome < 0.88) {
      // 4xx client error
      status = 'failed';
      httpStatus = CLIENT_ERROR_CODES[Math.floor(rand() * CLIENT_ERROR_CODES.length)];
      errorPayload = ERROR_PAYLOADS[httpStatus] ?? null;
      latencyMs = Math.round(50 + rand() * 200);
    } else if (outcome < 0.96) {
      // 5xx server error
      status = 'failed';
      httpStatus = SERVER_ERROR_CODES[Math.floor(rand() * SERVER_ERROR_CODES.length)];
      errorPayload = ERROR_PAYLOADS[httpStatus] ?? null;
      latencyMs = Math.round(200 + rand() * 800);
    } else {
      // Network / timeout
      status = 'failed';
      httpStatus = null;
      errorPayload = '{"error":"Network Error","message":"ECONNREFUSED — target host unreachable"}';
      latencyMs = null;
    }

    deliveries.push({
      id: `wh-${i.toString().padStart(5, '0')}-${Math.floor(rand() * 0xffff).toString(16)}`,
      eventType,
      targetUrl,
      httpStatus,
      errorPayload,
      status,
      latencyMs,
      attemptedAt,
      attemptNumber,
    });
  }

  // Sort chronologically descending (most recent first)
  return deliveries.sort((a, b) => b.attemptedAt - a.attemptedAt);
}

// ─── Metric computation ────────────────────────────────────────────────────

/** Compute aggregate KPI summary from a list of deliveries. */
export function computeSummaryMetrics(deliveries: WebhookDelivery[]): WebhookSummaryMetrics {
  if (deliveries.length === 0) {
    return {
      totalAttempts: 0,
      successCount: 0,
      failedCount: 0,
      successRate: 0,
      avgLatencyMs: null,
      p95LatencyMs: null,
    };
  }

  const successCount = deliveries.filter((d) => d.status === 'success').length;
  const failedCount = deliveries.filter((d) => d.status === 'failed').length;
  const totalAttempts = deliveries.length;

  // Use integer-safe arithmetic: multiply before dividing to avoid float drift
  const successRate = Math.round((successCount / totalAttempts) * 10000) / 100;

  const successLatencies = deliveries
    .filter((d) => d.status === 'success' && d.latencyMs !== null)
    .map((d) => d.latencyMs as number)
    .sort((a, b) => a - b);

  let avgLatencyMs: number | null = null;
  let p95LatencyMs: number | null = null;

  if (successLatencies.length > 0) {
    const sum = successLatencies.reduce((acc, v) => acc + v, 0);
    avgLatencyMs = Math.round(sum / successLatencies.length);
    const p95Index = Math.ceil(successLatencies.length * 0.95) - 1;
    p95LatencyMs = successLatencies[Math.max(0, p95Index)];
  }

  return { totalAttempts, successCount, failedCount, successRate, avgLatencyMs, p95LatencyMs };
}

/**
 * Bucket deliveries into time slots for the chart.
 * Each bucket is one hour wide for ≤24h ranges, or 6 hours for 7d.
 */
export function bucketDeliveriesByTime(
  deliveries: WebhookDelivery[],
  rangeHours: number,
): WebhookMetricBucket[] {
  const bucketHours = rangeHours <= 24 ? 1 : 6;
  const bucketMs = bucketHours * 60 * 60 * 1000;
  const now = Date.now();
  const numBuckets = Math.ceil(rangeHours / bucketHours);

  const buckets: WebhookMetricBucket[] = Array.from({ length: numBuckets }, (_, i) => {
    const bucketEnd = now - i * bucketMs;
    const bucketStart = bucketEnd - bucketMs;
    const d = new Date(bucketStart);

    let displayLabel: string;
    if (bucketHours === 1) {
      displayLabel = d.toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      });
    } else {
      displayLabel =
        d.toLocaleDateString([], { month: 'short', day: 'numeric' }) +
        ' ' +
        d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
    }

    return {
      label: d.toISOString().slice(0, 13),
      displayLabel,
      successCount: 0,
      failedCount: 0,
      totalCount: 0,
      avgLatencyMs: null,
    };
  }).reverse(); // oldest first for left-to-right chart rendering

  // Assign each delivery to its bucket
  for (const delivery of deliveries) {
    const bucketIndex = Math.floor((now - delivery.attemptedAt) / bucketMs);
    const idx = numBuckets - 1 - bucketIndex; // map to 0-indexed oldest-first
    if (idx < 0 || idx >= numBuckets) continue;

    const bucket = buckets[idx];
    bucket.totalCount++;
    if (delivery.status === 'success') {
      bucket.successCount++;
    } else {
      bucket.failedCount++;
    }
  }

  // Compute per-bucket average latency
  for (let i = 0; i < numBuckets; i++) {
    const bucketIndex = numBuckets - 1 - i;
    const bucketEnd = now - bucketIndex * bucketMs;
    const bucketStart = bucketEnd - bucketMs;
    const latencies = deliveries
      .filter(
        (d) =>
          d.status === 'success' &&
          d.latencyMs !== null &&
          d.attemptedAt >= bucketStart &&
          d.attemptedAt < bucketEnd,
      )
      .map((d) => d.latencyMs as number);

    if (latencies.length > 0) {
      buckets[i].avgLatencyMs = Math.round(
        latencies.reduce((acc, v) => acc + v, 0) / latencies.length,
      );
    }
  }

  return buckets;
}

/** Derive the error category from a delivery. */
export function getErrorCategory(delivery: WebhookDelivery): WebhookErrorCategory | null {
  if (delivery.status === 'success') return null;
  if (delivery.httpStatus === null) return 'network';
  if (delivery.httpStatus === 408 || delivery.httpStatus === 504) return 'timeout';
  if (delivery.httpStatus >= 400 && delivery.httpStatus < 500) return '4xx';
  return '5xx';
}

/** Apply filters to a flat list of deliveries. */
export function filterDeliveries(
  deliveries: WebhookDelivery[],
  filters: WebhookFilters,
): WebhookDelivery[] {
  const rangeHoursMap: Record<string, number> = { '1h': 1, '6h': 6, '24h': 24, '7d': 168 };
  const rangeHours = rangeHoursMap[filters.dateRange] ?? 24;
  const cutoffMs = Date.now() - rangeHours * 60 * 60 * 1000;

  return deliveries.filter((d) => {
    if (d.attemptedAt < cutoffMs) return false;
    if (filters.eventType !== 'all' && d.eventType !== filters.eventType) return false;
    if (filters.statusFilter !== 'all') {
      if (filters.statusFilter === 'success' && d.status !== 'success') return false;
      if (filters.statusFilter === 'failed' && d.status !== 'failed') return false;
    }
    if (filters.errorCategory !== 'all') {
      const cat = getErrorCategory(d);
      if (cat !== filters.errorCategory) return false;
    }
    return true;
  });
}

/** Get all unique event types from a list of deliveries. */
export function getEventTypeOptions(deliveries: WebhookDelivery[]): string[] {
  return Array.from(new Set(deliveries.map((d) => d.eventType))).sort();
}
