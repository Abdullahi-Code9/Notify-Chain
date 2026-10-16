# Metrics API Documentation

## Overview
This document describes the metrics APIs available for monitoring notification system health and performance. **Critical:** Different endpoints serve different use cases - using the wrong endpoint can lead to inflated or incorrect metrics.

## API Endpoints

### 1. `/api/schedule/stats` - Notification-Level Statistics & Queue Metrics
**Use Case:** Current system status and queue health monitoring

**Returns:**
```json
{
  "pending": 15,                  // Notifications waiting to be processed (legacy key)
  "processing": 3,                // Currently being processed (legacy key)
  "completed": 1234,              // Successfully delivered (legacy key)
  "failed": 45,                   // Permanently failed (legacy key)
  "overdue": 2,                   // Past due date but still pending
  "deadLetterQueue": 5,           // Notifications moved to dead-letter queue
  "pendingNotifications": 15,     // Operational metric: waiting to be delivered (#797)
  "processingNotifications": 3,   // Operational metric: currently in flight (#797)
  "successfulDeliveries": 1234,   // Operational metric: delivered successfully (#797)
  "failedDeliveries": 45,         // Operational metric: permanently failed (#797)
  "retryAttempts": 35             // Operational metric: total retries executed (#797)
}
```

**Characteristics:**
- ✅ Fast cached query
- ✅ Real-time queue status
- ✅ One count per notification
- ✅ Full retry attempt visibility
- ✅ Backward compatible with legacy consumer keys

**Best For:**
- System health dashboards
- Alerting on queue backlogs
- Capacity planning

---

### 2. `/api/schedule/queue/metrics` - Operational Metrics for Notification Queue Activity (#797)
**Use Case:** Real-time operational visibility into notification queue dynamics, throughput, and error rates

**Aliases:**
- `GET /api/schedule/queue/metrics`
- `GET /api/schedule/queue-metrics`
- `GET /api/notifications/queue-metrics`

**Returns:**
```json
{
  "success": true,
  "data": {
    "pendingNotifications": 15,
    "processingNotifications": 3,
    "successfulDeliveries": 1234,
    "failedDeliveries": 45,
    "retryAttempts": 35
  }
}
```

**Metric Definitions and Meanings:**

| Metric Name | Type | Description | Operational Significance |
|-------------|------|-------------|--------------------------|
| `pendingNotifications` | `Gauge (Integer)` | Number of notifications waiting in queue to be delivered. Includes newly scheduled notifications and retried jobs waiting for their backoff delay. | **Backlog Indicator:** A sustained increase indicates worker capacity saturation or worker starvation. |
| `processingNotifications` | `Gauge (Integer)` | Number of notifications currently in flight and actively being processed by worker instances holding a valid distributed lock. | **Concurrency Indicator:** Should align with active worker concurrency limits. Unchanging counts may indicate stalled workers. |
| `successfulDeliveries` | `Counter (Integer)` | Cumulative count of notifications that have been successfully delivered to their destination recipient (terminal `COMPLETED` state). | **Throughput Indicator:** Measures successful pipeline progress over time. |
| `failedDeliveries` | `Counter (Integer)` | Cumulative count of notifications that permanently failed delivery (terminal `FAILED` state) after exhausting retries or hitting permanent errors (e.g. 4xx). | **Error Indicator:** Spikes indicate downstream recipient outages, invalid URLs, or configuration errors. |
| `retryAttempts` | `Counter (Integer)` | Total number of delivery retry attempts executed across all notifications. Incremented every time a transient error schedules a retry cycle. | **Instability / Cost Indicator:** High retry-to-delivery ratios indicate downstream rate-limiting (429) or transient provider errors (5xx). |

**Observability Integration:**
- **Health Report:** The same metrics are surfaced automatically in `GET /api/notifications/health` under `queue.operationalMetrics`.
- **Prometheus/Alerting Recommendation:**
  ```promql
  # High queue backlog alert
  alert: NotificationQueueBacklogHigh
  expr: notification_queue_pending_notifications > 500
  for: 5m
  labels:
    severity: warning
  annotations:
    summary: "Notification queue backlog is high ({{ $value }} pending)"

  # Elevated failure rate alert
  alert: NotificationDeliveryFailureSpike
  expr: rate(notification_queue_failed_deliveries[5m]) > 5
  for: 2m
  labels:
    severity: critical
  annotations:
    summary: "Spike in permanent notification delivery failures"
  ```

---

### 3. `/api/schedule/execution-metrics` - Execution-Level Metrics (Deduplicated)
**Use Case:** Accurate delivery metrics and retry analysis

⚠️ **CRITICAL:** This endpoint uses proper deduplication logic to prevent double-counting of retried notifications.

**Returns:**
```json
{
  "totalNotifications": 100,
  "successfulFirstAttempt": 70,
  "successfulAfterRetry": 20,
  "permanentFailures": 10,
  "totalRetryAttempts": 35,
  "averageRetriesPerNotification": 0.35,
  "averageSuccessDurationMs": 845.5,
  "averageFailureDurationMs": 2341.2
}
```

**Field Definitions:**
- `totalNotifications`: Total completed or failed notifications (one per notification ID)
- `successfulFirstAttempt`: Delivered successfully on first try (0 retries)
- `successfulAfterRetry`: Delivered successfully after 1+ retries
- `permanentFailures`: Failed permanently after exhausting retries
- `totalRetryAttempts`: Sum of retry counts across all notifications
- `averageRetriesPerNotification`: `totalRetryAttempts / totalNotifications`
- `averageSuccessDurationMs`: Average duration of final successful attempts
- `averageFailureDurationMs`: Average duration of final failed attempts

**Deduplication Logic:**
The query selects **exactly one row per notification** by joining the `scheduled_notifications` table with the **final execution attempt** from `notification_execution_log`:

```sql
SELECT MAX(execution_attempt) FROM notification_execution_log 
WHERE scheduled_notification_id = ?
```

This ensures a notification with 2 retries + 1 success counts as **1 success**, not 3 events.

**Best For:**
- ✅ Delivery success rate dashboards
- ✅ Reliability metrics (SLA tracking)
- ✅ Performance monitoring (duration analysis)
- ✅ Retry overhead calculation
- ✅ **ANY metric that should count notifications, not attempts**

**Example Calculations:**
```javascript
// Success rate (including retries)
const successRate = (metrics.successfulFirstAttempt + metrics.successfulAfterRetry) / metrics.totalNotifications;
// Example: (70 + 20) / 100 = 0.90 (90% success rate)

// First-attempt success rate
const firstAttemptRate = metrics.successfulFirstAttempt / metrics.totalNotifications;
// Example: 70 / 100 = 0.70 (70% succeed immediately)

// Retry effectiveness
const retrySuccessRate = metrics.successfulAfterRetry / (metrics.successfulAfterRetry + metrics.permanentFailures);
// Example: 20 / (20 + 10) = 0.667 (66.7% of retried notifications eventually succeed)
```

---

### 4. `/api/schedule/retry-distribution` - Retry Breakdown
**Use Case:** Understanding retry patterns and optimization

**Returns:**
```json
[
  { "retryCount": 0, "successCount": 70, "failureCount": 0 },
  { "retryCount": 1, "successCount": 15, "failureCount": 2 },
  { "retryCount": 2, "successCount": 5, "failureCount": 3 },
  { "retryCount": 3, "successCount": 0, "failureCount": 5 }
]
```

**Interpretation:**
- `retryCount`: Number of retries before final outcome
- `successCount`: Notifications that succeeded after N retries
- `failureCount`: Notifications that failed after N retries

**Example Analysis:**
```
Retry 0: 70 successes → 70% work immediately
Retry 1: 15 successes → 15% need 1 retry
Retry 2: 5 successes → 5% need 2 retries
Retry 3: 0 successes → No successes after 3 retries

Total failures by retry count:
- 2 failed after 1 retry
- 3 failed after 2 retries
- 5 failed after 3 retries
```

**Best For:**
- Optimizing retry policies (max retries, backoff timing)
- Identifying transient vs. permanent errors
- Cost analysis (retry overhead)

---

## Migration Guide: Fixing Double-Counted Metrics

### Before (Incorrect)
```javascript
// ❌ WRONG: Counting all execution log entries
const response = await fetch('/api/events');
const events = response.events;

// This counts every retry attempt as a separate success
const successCount = events.filter(e => e.status === 'SUCCESS').length;
// Result: 90 successes (but includes 20 retried attempts, inflated!)
```

### After (Correct)
```javascript
// ✅ CORRECT: Using deduplicated execution metrics
const response = await fetch('/api/schedule/execution-metrics');
const metrics = response.json();

const successCount = metrics.successfulFirstAttempt + metrics.successfulAfterRetry;
// Result: 70 + 20 = 90 successes (accurate, deduplicated)
```

### Dashboard Integration Examples

#### Prometheus/Grafana
```promql
# Success rate gauge
notification_success_rate = 
  (notification_successful_first + notification_successful_retry) / 
  notification_total

# Retry overhead
notification_retry_overhead_pct = 
  (notification_total_retries / notification_total) * 100
```

#### Datadog
```javascript
// Custom metric
api.get('/api/schedule/execution-metrics', (metrics) => {
  statsd.gauge('notifications.success_rate', 
    (metrics.successfulFirstAttempt + metrics.successfulAfterRetry) / metrics.totalNotifications
  );
  statsd.gauge('notifications.avg_retries', metrics.averageRetriesPerNotification);
});
```

#### CloudWatch
```javascript
// Put custom metrics
const metrics = await fetch('/api/schedule/execution-metrics').then(r => r.json());

await cloudwatch.putMetricData({
  Namespace: 'NotificationSystem',
  MetricData: [
    {
      MetricName: 'TotalSuccesses',
      Value: metrics.successfulFirstAttempt + metrics.successfulAfterRetry,
      Unit: 'Count'
    },
    {
      MetricName: 'PermanentFailures',
      Value: metrics.permanentFailures,
      Unit: 'Count'
    }
  ]
});
```

---

## Common Mistakes to Avoid

### ❌ Mistake #1: Counting Execution Logs Directly
```sql
-- WRONG: Counts all attempts, not final outcomes
SELECT COUNT(*) FROM notification_execution_log WHERE status = 'SUCCESS';
-- Result: 110 (includes 20 retries)
```

### ✅ Correct Approach
```sql
-- Use the API or the deduplication query
SELECT COUNT(*) FROM scheduled_notifications WHERE status = 'COMPLETED';
-- Result: 90 (deduplicated)
```

### ❌ Mistake #2: Mixing Metrics from Different Endpoints
```javascript
// WRONG: Mixing notification counts with execution counts
const pending = await fetch('/api/schedule/stats').pending;
const execMetrics = await fetch('/api/schedule/execution-metrics');
const total = pending + execMetrics.totalNotifications; // ← Inconsistent!
```

### ✅ Correct Approach
```javascript
// Use stats endpoint for queue health
const queueHealth = await fetch('/api/schedule/stats');
const currentBacklog = queueHealth.pending + queueHealth.processing;

// Use execution metrics for delivery performance (separate concern)
const deliveryMetrics = await fetch('/api/schedule/execution-metrics');
const successRate = (deliveryMetrics.successfulFirstAttempt + deliveryMetrics.successfulAfterRetry) / 
                     deliveryMetrics.totalNotifications;
```

### ❌ Mistake #3: Not Accounting for In-Progress Notifications
```javascript
// WRONG: Comparing pending vs completed without considering processing
if (stats.completed < expectedCount) {
  alert('Missing notifications!');
}
```

### ✅ Correct Approach
```javascript
// Account for all states
const totalProcessed = stats.completed + stats.failed;
const totalInFlight = stats.pending + stats.processing;
const totalScheduled = totalProcessed + totalInFlight;

if (totalScheduled < expectedCount) {
  alert('Missing notifications!');
}
```

---

## Testing Your Integration

### Validation Scenario
Create test data with known retry patterns:

```bash
# Create 1 notification that fails twice then succeeds
curl -X POST http://localhost:3000/api/schedule -d '{
  "payload": {"message": "Test"},
  "targetRecipient": "test-webhook",
  "executeAt": "2026-06-20T12:00:00Z",
  "maxRetries": 3
}'

# After it runs (fails, retries, succeeds):
curl http://localhost:3000/api/schedule/execution-metrics

# Expected result:
# {
#   "totalNotifications": 1,
#   "successfulAfterRetry": 1,    ← Exactly 1, not 3
#   "totalRetryAttempts": 2
# }
```

**If you see:**
- `totalNotifications: 3` → ❌ You're counting attempts, not notifications
- `successfulAfterRetry: 3` → ❌ You're not using the deduplication endpoint
- `successfulAfterRetry: 1` → ✅ Correct!

---

## Performance Considerations

### Execution Metrics Query
- **Complexity:** O(n) with subquery per row (SQLite limitation)
- **Typical latency:** <100ms for 10k completed notifications
- **Indexes used:** `scheduled_notifications.status`, `notification_execution_log.scheduled_notification_id`
- **Recommendation:** Cache results for 30-60 seconds in high-traffic dashboards

### Optimization Tips
```javascript
// Good: Cache for dashboard refresh interval
let cachedMetrics = null;
let cacheTime = 0;
const CACHE_TTL = 30000; // 30 seconds

async function getExecutionMetrics() {
  if (Date.now() - cacheTime < CACHE_TTL) {
    return cachedMetrics;
  }
  cachedMetrics = await fetch('/api/schedule/execution-metrics').then(r => r.json());
  cacheTime = Date.now();
  return cachedMetrics;
}
```

---

## Questions & Troubleshooting

### Q: My success count is higher than expected. What's wrong?
**A:** You're likely counting execution log entries instead of final notification outcomes. Use `/api/schedule/execution-metrics` instead of raw log queries.

### Q: Should I use /api/schedule/stats or /api/schedule/execution-metrics?
**A:** 
- **Stats** → Current queue status (pending/processing/completed/failed)
- **Execution Metrics** → Historical delivery performance with retry analysis

### Q: How do I track retry overhead for cost analysis?
**A:** Use `totalRetryAttempts / totalNotifications` from execution metrics. Each retry attempt consumes resources (API calls, network, compute time).

### Q: Can I get metrics for a specific time range?
**A:** Not currently supported. The API returns lifetime aggregates. For time-series analysis, poll the endpoint periodically and calculate deltas.

---

## Additional Resources
- [Root Cause Analysis](./ROOT_CAUSE_ANALYSIS.md) - Detailed explanation of the double-counting bug
- [Regression Tests](./listener/src/services/execution-metrics.test.ts) - Example test scenarios
- [Database Schema](./listener/src/database/schema.sql) - Table structures and indexes
