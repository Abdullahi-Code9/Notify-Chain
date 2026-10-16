# ADR-0003: Notification Delivery Architecture

## Metadata

- **Status**: Accepted
- **Date**: 2026-09-30
- **Authors**: @lynndabel
- **Related Issues**: N/A
- **Supersedes**: N/A
- **Superseded By**: N/A

## Context

NotifyChain delivers events to multiple downstream targets: Discord webhooks, HTTP endpoints, and scheduled notifications. The notification delivery system must handle:

1. **Reliability**: Notifications should be delivered at-least-once, even during failures
2. **Retry Logic**: Transient failures (network issues, rate limits) should be retried
3. **Rate Limiting**: Respect downstream service rate limits (e.g., Discord's 10 req/sec)
4. **Scheduling**: Support delayed notifications with expiration and revocation
5. **Multi-Instance**: Support horizontal scaling without duplicate deliveries
6. **Observability**: Track delivery status, failures, and retry attempts

The initial implementation had basic retry logic but lacked a robust scheduling mechanism and multi-instance coordination.

## Decision

We implement a dual-path notification delivery system with in-memory retry for immediate delivery and database-backed scheduling for delayed notifications.

### Architecture Overview

```
                    ┌─────────────────┐
                    │  Event Source   │
                    │ (Deduplicated)  │
                    └────────┬────────┘
                             │
                             ▼
              ┌──────────────────────────────┐
              │  Notification Dispatcher      │
              └──────────────┬───────────────┘
                             │
              ┌──────────────┴───────────────┐
              ▼                              ▼
    ┌──────────────────┐          ┌──────────────────┐
    │  Immediate Path  │          │  Scheduled Path  │
    └──────────────────┘          └──────────────────┘
              │                              │
              ▼                              ▼
    ┌──────────────────┐          ┌──────────────────┐
    │ In-Memory Retry  │          │  SQLite Storage  │
    │     Queue        │          │  (notifications) │
    └────────┬─────────┘          └────────┬─────────┘
             │                              │
             ▼                              ▼
    ┌──────────────────┐          ┌──────────────────┐
    │ Discord / HTTP   │          │  Background      │
    │   Targets        │          │  Scheduler       │
    └──────────────────┘          └────────┬─────────┘
                                             │
                                             ▼
                                  ┌──────────────────┐
                                  │ Discord / HTTP   │
                                  │   Targets        │
                                  └──────────────────┘
```

### Path 1: Immediate Delivery (In-Memory Retry Queue)

**Purpose**: Fast delivery of real-time notifications with retry logic.

**Implementation**: `NotificationRetryQueue` in `listener/src/services/notification-retry-queue.ts`

**Features**:
- In-memory queue for pending retries
- Exponential backoff: `delay = base * multiplier^attempt`
- Configurable max retries (default: 5)
- Jitter to prevent thundering herd
- Processed at configurable interval (default: 5s)

**Retry Strategy**:
```
Attempt 1: Immediate
Attempt 2: 5 seconds (base * 2^1)
Attempt 3: 25 seconds (base * 2^2)
Attempt 4: 125 seconds (base * 2^3)
Attempt 5: 625 seconds (base * 2^4)
After 5: Permanent failure, log error
```

**Configuration**:
```env
RETRY_BASE_DELAY_MS=5000
RETRY_MAX_RETRIES=5
RETRY_MULTIPLIER=2
RETRY_MAX_DELAY_MS=3600000
RETRY_JITTER=true
RETRY_QUEUE_PROCESS_INTERVAL_MS=5000
```

### Path 2: Scheduled Delivery (Database-Backed)

**Purpose**: Delayed notifications with at-least-once delivery across restarts and multi-instance deployments.

**Implementation**: `RetryScheduler` in `listener/src/services/retry-scheduler.ts`

**Database Schema**:
```sql
CREATE TABLE scheduled_notifications (
  id TEXT PRIMARY KEY,
  creator TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_by TEXT,
  revoked_at INTEGER,
  scheduled_for INTEGER,
  delivered BOOLEAN DEFAULT 0,
  delivered_at TIMESTAMP,
  status TEXT DEFAULT 'PENDING',
  processor_id TEXT,
  lock_expires_at TIMESTAMP,
  INDEX idx_expires (expires_at),
  INDEX idx_scheduled (scheduled_for),
  INDEX idx_status (status)
);
```

**States**:
- `PENDING`: Waiting for scheduled time
- `PROCESSING`: Being processed by a scheduler instance
- `COMPLETED`: Successfully delivered
- `FAILED`: Permanent failure after max retries

**Atomic Lock Acquisition**:
```sql
UPDATE scheduled_notifications
   SET status = 'PROCESSING',
       processor_id = ?,
       lock_expires_at = datetime('now', '+60 seconds')
 WHERE id = ?
   AND status = 'PENDING'
```

The `WHERE status = 'PENDING'` predicate ensures only one instance can acquire the lock.

**Stale Lock Recovery**:
- On each tick, check for locks where `lock_expires_at < now`
- Reset to `PENDING` if lock expired
- Allows other instances to pick up abandoned work

**Configuration**:
```env
RETRY_SCHEDULER_ENABLED=true
RETRY_SCHEDULER_POLL_INTERVAL_MS=15000
RETRY_SCHEDULER_LOCK_TIMEOUT_MS=60000
RETRY_SCHEDULER_PROCESSOR_ID=
RETRY_SCHEDULER_BATCH_SIZE=10
```

### Notification Targets

#### Discord Webhooks

**Implementation**: `DiscordNotificationService` in `listener/src/services/discord-notification.ts`

**Features**:
- Formats events as Discord embeds
- Respects Discord rate limits (10 req/sec per webhook)
- Retry with exponential backoff
- Configurable retry count and backoff

**Rate Limiting**:
- Built-in Discord rate limit: 10 requests/second per webhook
- Our retry queue respects this with delays

#### HTTP Targets

**Implementation**: Webhook sender in `listener/src/services/webhook-sender.ts`

**Features**:
- POST events as JSON
- Configurable headers and auth
- Timeout support (default: 5s)
- Retry with exponential backoff
- HMAC signature support for payload integrity

### Expiration and Revocation

**On-Chain Support**:
- Contracts can schedule notifications with TTL
- Contracts can revoke notifications before expiration
- Contracts can extend notification expiration

**Off-Chain Enforcement**:
- Scheduler checks `expires_at` before delivery
- Revoked notifications are skipped
- Expired notifications emit `NotificationExpired` event

## Consequences

### Positive

- **Reliability**: Dual-path system ensures both immediate and scheduled notifications are delivered reliably
- **Scalability**: Database-backed scheduling supports multi-instance deployments
- **Flexibility**: Supports both real-time and delayed notifications
- **Observability**: Each path has metrics and logging for monitoring
- **Graceful Degradation**: In-memory queue survives transient failures; database survives restarts

### Negative

- **Complexity**: Dual-path system increases operational complexity
- **Database Load**: Scheduled notifications require database writes and queries
- **Latency**: Scheduled notifications have polling interval latency (default: 15s)
- **Memory**: In-memory retry queue consumes memory proportional to pending retries

### Risks

- **Duplicate Delivery**: Multi-instance deployments could deliver same notification twice
  - **Mitigation**: Atomic lock acquisition with `WHERE status = 'PENDING'` predicate
- **Stale Locks**: Crashed instance could leave locks stuck
  - **Mitigation**: Stale lock recovery on each scheduler tick
- **Queue Exhaustion**: In-memory retry queue could overflow during extended outages
  - **Mitigation**: Configurable max size; consider migrating to database for high-volume scenarios
- **Rate Limit Violations**: Could exceed downstream service rate limits
  - **Mitigation**: Built-in rate limiting for Discord; configurable delays for HTTP

## Alternatives Considered

| Alternative | Description | Rejected Because |
|-------------|-------------|------------------|
| Single Path (In-Memory Only) | All notifications use in-memory queue | Lost on restart; no support for delayed notifications |
| Single Path (Database Only) | All notifications use database | Higher latency; unnecessary for real-time notifications |
| Message Queue (RabbitMQ/Kafka) | Use external message broker | Adds infrastructure dependency; overkill for current scale |
| Push-Based Scheduler | Use cron or external scheduler | Less control; harder to coordinate across instances |
| No Retry Logic | Fire-and-forget delivery | Unacceptable reliability for production use |

## Implementation

### Core Components

- **NotificationRetryQueue**: `listener/src/services/notification-retry-queue.ts`
  - In-memory retry queue for immediate delivery
  - Exponential backoff with jitter
  - Processed at configurable interval

- **RetryScheduler**: `listener/src/services/retry-scheduler.ts`
  - Database-backed scheduler for delayed notifications
  - Atomic lock acquisition
  - Stale lock recovery
  - Batch processing

- **DiscordNotificationService**: `listener/src/services/discord-notification.ts`
  - Discord webhook delivery
  - Embed formatting
  - Rate limit handling

- **WebhookSender**: `listener/src/services/webhook-sender.ts`
  - HTTP webhook delivery
  - HMAC signature support
  - Timeout handling

### Configuration Summary

```env
# Immediate Retry Queue
RETRY_BASE_DELAY_MS=5000
RETRY_MAX_RETRIES=5
RETRY_MULTIPLIER=2
RETRY_MAX_DELAY_MS=3600000
RETRY_JITTER=true
RETRY_QUEUE_PROCESS_INTERVAL_MS=5000

# Scheduled Notifications
RETRY_SCHEDULER_ENABLED=true
RETRY_SCHEDULER_POLL_INTERVAL_MS=15000
RETRY_SCHEDULER_LOCK_TIMEOUT_MS=60000
RETRY_SCHEDULER_PROCESSOR_ID=
RETRY_SCHEDULER_BATCH_SIZE=10

# Discord
DISCORD_WEBHOOK_URL=
DISCORD_WEBHOOK_ID=
DISCORD_RETRY_COUNT=3
DISCORD_BACKOFF_BASE_SECONDS=5

# Webhook Security
WEBHOOK_SECRETS=[{"id":"default","secret":"whsec_..."}]
PAYLOAD_INTEGRITY_SECRET=
```

### Monitoring

**Key Metrics**:
- In-memory retry queue depth
- Scheduled notifications pending count
- Delivery success rate per target
- Retry attempt distribution
- Lock contention (scheduler)
- Stale lock recovery count

**Alerting**:
- Alert if retry queue depth exceeds threshold
- Alert if scheduled notifications backlog grows
- Alert if delivery success rate drops below 95%
- Alert if stale lock recovery count increases

## References

- [Notification Failure Recovery](../../NOTIFICATION_FAILURE_RECOVERY.md)
- [Scheduled Notifications Delivery](../../SCHEDULED-NOTIFICATIONS-DELIVERY.md)
- [Notification Lifecycle](../../NOTIFICATION_LIFECYCLE.md)
- [Backend Architecture](../../BACKEND_ARCHITECTURE.md)

---

## Notes

- The dual-path architecture balances latency (in-memory) with durability (database)
- Atomic lock acquisition is critical for multi-instance deployments
- Consider implementing dead letter queue for permanently failed notifications
- Future enhancement: Add support for additional targets (Slack, email, SMS)
