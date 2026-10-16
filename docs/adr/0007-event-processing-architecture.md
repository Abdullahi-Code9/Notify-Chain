# ADR-0002: Event Processing Pipeline Architecture

## Metadata

- **Status**: Accepted
- **Date**: 2026-09-30
- **Authors**: @lynndabel
- **Related Issues**: N/A
- **Supersedes**: N/A
- **Superseded By**: N/A

## Context

NotifyChain's core function is to process events emitted by Stellar Soroban smart contracts and make them available to downstream consumers. The event processing pipeline must handle:

1. **High Volume**: Potentially thousands of events per second during peak network activity
2. **Reliability**: No events should be lost, even during service restarts or network issues
3. **Deduplication**: Blockchain reorganizations (reorgs) can cause events to be re-emitted
4. **Real-time Delivery**: Events should be available via API and push notifications with minimal latency
5. **Scalability**: The system should handle multiple contracts and multiple listener instances

The initial implementation used a simple in-memory deduplication cache, which was insufficient for handling reorgs and service restarts.

## Decision

We implement a multi-layer event processing pipeline with persistent deduplication:

### Architecture Layers

```
Stellar RPC
    │
    ▼
┌─────────────────────────────────────────┐
│  EventSubscriber                       │
│  - Polls RPC at configured interval    │
│  - Tracks cursor per contract          │
│  - Detects reorgs via ledger numbers   │
└────────────┬────────────────────────────┘
             │
             ▼
┌─────────────────────────────────────────┐
│  Persistent Deduplication Layer         │
│  - EventDeduplicationService           │
│  - SQLite: processed_events table      │
│  - SQLite: polling_cursors table       │
│  - Survives restarts & reorgs           │
└────────────┬────────────────────────────┘
             │
             ▼
┌─────────────────────────────────────────┐
│  In-Memory Deduplication Layer         │
│  - NotificationDeduplicator (LRU)       │
│  - Event Registry                      │
│  - Short-term cache (60s window)       │
└────────────┬────────────────────────────┘
             │
             ▼
┌─────────────────────────────────────────┐
│  Event Processing Queue                 │
│  - Concurrent processing                │
│  - Retry with backoff                  │
│  - Error handling                      │
└────────────┬────────────────────────────┘
             │
        ┌────┴────┐
        ▼         ▼
┌──────────────┐  ┌──────────────┐
│ Notification │  │ REST API     │
│ Dispatcher   │  │ /api/events  │
└──────────────┘  └──────────────┘
```

### Layer 1: Persistent Deduplication

**Purpose**: Provide durable deduplication that survives service restarts and reorgs.

**Implementation**: `EventDeduplicationService` in `listener/src/services/event-deduplication-service.ts`

**Database Schema**:
```sql
CREATE TABLE processed_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  contract_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  ledger_sequence INTEGER NOT NULL,
  is_reorg_duplicate BOOLEAN DEFAULT 0,
  processed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_event_id (event_id),
  INDEX idx_contract_ledger (contract_id, ledger_sequence)
);

CREATE TABLE polling_cursors (
  contract_id TEXT PRIMARY KEY,
  last_ledger INTEGER NOT NULL,
  reorg_detection_count INTEGER DEFAULT 0,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

**Reorg Detection Algorithm**:
1. Each polling cycle, compare current event's ledger with stored cursor
2. If `current_ledger < last_ledger` → reorg detected
3. Increment `reorg_detection_count`
4. When same event re-appears after reorg, mark as `is_reorg_duplicate = true`
5. Skip notification dispatch for reorg duplicates

### Layer 2: In-Memory Deduplication

**Purpose**: Fast cache for recently seen events to avoid database hits.

**Implementation**: `NotificationDeduplicator` in `listener/src/services/notification-deduplicator.ts`

**Algorithm**: LRU cache with configurable window (default 60 seconds)

**Key**: `sha256(contractId + eventId + eventType + ledger)`

### Layer 3: Event Processing Queue

**Purpose**: Decouple event ingestion from processing to handle spikes.

**Implementation**: `EventProcessingQueue` in `listener/src/services/event-processing-queue.ts`

**Features**:
- Configurable concurrency limit
- Retry with exponential backoff
- Error handling and logging
- Metrics tracking

### Cursor Management

**Purpose**: Track polling position to resume after restarts.

**Storage**: `polling_cursors` table with:
- `contract_id`: Contract being monitored
- `last_ledger`: Last successfully processed ledger
- `reorg_detection_count`: Number of reorgs detected

**Backfill Safety**:
- On cold start (no cursor), limit backfill to prevent replaying entire chain history
- Configurable via `BACKFILL_MAX_LEDGERS` (default: 10,000)
- Set to 0 to disable and replay from genesis

## Consequences

### Positive

- **Reliability**: Persistent deduplication ensures no events are lost or duplicated across restarts
- **Reorg Handling**: Explicit reorg detection prevents duplicate notifications during chain reorganizations
- **Performance**: Two-layer deduplication balances durability (DB) with speed (memory)
- **Observability**: Reorg detection count provides visibility into chain stability
- **Recoverability**: Cursor persistence allows resumption from last known position

### Negative

- **Complexity**: Two-layer deduplication increases system complexity
- **Database Load**: Every event requires a database write for persistent deduplication
- **Storage Growth**: `processed_events` table grows indefinitely without cleanup
- **Latency**: Database writes add latency to event processing pipeline

### Risks

- **Database Contention**: High event volume could cause database lock contention
  - **Mitigation**: Use connection pooling, consider PostgreSQL for high-volume deployments
- **Storage Exhaustion**: Unbounded growth of `processed_events` table
  - **Mitigation**: Implement retention policy and periodic cleanup (see `CLEANUP_INTERVAL_MS`)
- **Cursor Corruption**: Incorrect cursor could cause event gaps or duplicates
  - **Mitigation**: Validate cursor on startup, provide manual reset mechanism
- **Reorg False Positives**: Network latency could trigger false reorg detection
  - **Mitigation**: Use ledger sequence from RPC response, not local clock

## Alternatives Considered

| Alternative | Description | Rejected Because |
|-------------|-------------|------------------|
| In-Memory Only | Single LRU cache for deduplication | Lost on restart; cannot handle reorgs |
| Event ID Only | Dedup by event ID only | Cannot detect reorg duplicates without ledger comparison |
| Blockchain Reorg API | Use Stellar's reorg detection API | Not available; must implement manually |
| Event Sourcing | Store all events in append-only log | Overkill; we only need deduplication, not full event sourcing |
| No Deduplication | Trust RPC to not send duplicates | Reorgs inherently cause duplicates; would send duplicate notifications |

## Implementation

### Core Components

- **EventSubscriber**: `listener/src/services/event-subscriber.ts`
  - Polls RPC at `POLL_INTERVAL_MS` interval
  - Maintains cursor per contract
  - Detects reorgs via ledger comparison
  - Integrates RPC rate limiter

- **EventDeduplicationService**: `listener/src/services/event-deduplication-service.ts`
  - Checks `processed_events` table
  - Marks reorg duplicates
  - Updates `polling_cursors`
  - Provides metrics for monitoring

- **NotificationDeduplicator**: `listener/src/services/notification-deduplicator.ts`
  - In-memory LRU cache
  - Configurable window via `NOTIFICATION_DEDUPLICATION_WINDOW_MS`
  - Complements persistent layer

- **EventProcessingQueue**: `listener/src/services/event-processing-queue.ts`
  - Concurrent processing via `EVENT_QUEUE_MAX_CONCURRENCY`
  - Retry with backoff
  - Error handling

### Configuration

```env
# Polling
POLL_INTERVAL_MS=30000
EVENT_BATCH_SIZE=100

# Backfill Safety
BACKFILL_MAX_LEDGERS=10000

# Deduplication
NOTIFICATION_DEDUPLICATION_WINDOW_MS=60000
NOTIFICATION_DEDUPLICATION_MAX_SIZE=10000

# Event Queue
EVENT_QUEUE_MAX_CONCURRENCY=1
EVENT_QUEUE_MAX_RETRIES=3
EVENT_QUEUE_BASE_DELAY_MS=2000

# Cleanup
CLEANUP_INTERVAL_MS=3600000
PROCESSED_EVENT_RETENTION_MS=2592000000
```

### Monitoring

**Key Metrics**:
- `reorg_detection_count` per contract
- `processed_events` table size
- Deduplication hit rate (memory vs DB)
- Event processing latency
- Queue depth

**Alerting**:
- Alert if `reorg_detection_count` increases rapidly (chain instability)
- Alert if `processed_events` table grows beyond expected retention
- Alert if event processing latency exceeds threshold

## References

- [Reorg Deduplication Monitoring](../../REORG-DEDUPLICATION-MONITORING.md)
- [Architecture Overview](../../ARCHITECTURE_OVERVIEW.md)
- [Backend Architecture](../../BACKEND_ARCHITECTURE.md)
- [API Sequence Diagrams](../../API_SEQUENCE_DIAGRAMS.md)

---

## Notes

- The two-layer deduplication strategy is critical for production reliability
- Reorg detection is based on ledger sequence comparison, not timestamps
- Consider implementing event archiving to move old events to cold storage
- Future enhancement: Add support for event replay from specific ledger for debugging
