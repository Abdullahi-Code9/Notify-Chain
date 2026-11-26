# Event-to-Notification Flow: Quick Start Guide

> **Audience**: Developers new to NotifyChain who need a clear mental model of how contract events become notifications.
>
> **Status**: Phase 1 (1%) - Foundational overview with a simple example
>
> **For detailed technical documentation**, see [CONTRIBUTOR_EVENT_LIFECYCLE.md](CONTRIBUTOR_EVENT_LIFECYCLE.md)

## Overview

This guide explains the complete journey of a blockchain event from contract emission to notification delivery in 5 simple steps.

```
Contract Event → Listener Polling → Processing → Storage → Notification Delivery
```

## The 5-Step Journey

### Step 1: Contract Emits Event

A Soroban smart contract emits a typed event when state changes occur.

**Example: Creating an AutoShare Group**

```rust
// File: contract/contracts/hello-world/src/base/events.rs

#[contractevent(data_format = "single-value")]
pub struct AutoshareCreated {
    #[topic]
    pub creator: Address,
    #[topic]
    pub category: NotificationCategory,
    #[topic]
    pub priority: NotificationPriority,
    pub id: BytesN<32>,
}

// When a user creates a group, the contract emits:
env.events().publish(
    (symbol_short!("AutoshareCreated"),),
    AutoshareCreated {
        creator: invoker,
        category: NotificationCategory::Group,
        priority: NotificationPriority::Medium,
        id: group_id,
    },
);
```

**What happens on-chain:**
- Event is recorded in the Stellar ledger
- Event has a unique `event_id` assigned by the network
- Event is associated with a specific `ledger_number`
- Event is permanently stored and queryable via RPC

**Key Files:**
- `contract/contracts/hello-world/src/base/events.rs` - Event definitions
- `contract/contracts/hello-world/src/lib.rs` - Contract logic

### Step 2: Listener Polls for Events

The NotifyChain listener service polls Stellar RPC at regular intervals (default: 30 seconds).

**Configuration Example:**

```bash
# .env
STELLAR_RPC_URL=https://soroban-testnet.stellar.org:443
POLL_INTERVAL_MS=30000
CONTRACT_ADDRESSES=[{"address":"CXXX...","events":["*"]}]
```

**What the listener does:**

1. Calls `server.getEvents()` for each configured contract
2. Requests events from last known cursor (or backfill point on startup)
3. Receives a batch of events from Stellar RPC
4. Advances its cursor to track progress

**Example RPC Response:**

```typescript
{
  events: [
    {
      id: "0001234567890123-0000000001",
      type: "contract",
      ledger: 12345,
      ledgerClosedAt: "2024-01-15T10:30:00Z",
      contractId: "CXXX...",
      topics: [
        { sym: "AutoshareCreated" },      // Event name
        { address: "GXXX..." },            // Creator address
        { u32: 0 },                        // Category: Group
        { u32: 1 }                         // Priority: Medium
      ],
      value: {
        bytes: "abc123..."               // Group ID (BytesN<32>)
      }
    }
  ],
  latestLedger: 12350
}
```

**Key Files:**
- `listener/src/services/event-subscriber.ts` - Polling loop
- `listener/src/config.ts` - Configuration loading
- `listener/src/utils/event-utils.ts` - Event parsing

### Step 3: Event Processing & Validation

The listener validates, deduplicates, and processes each event.

**Processing Flow:**

```typescript
// Simplified processing logic
async function processEvent(event) {
  // 1. Extract event name from topics
  const eventName = getEventName(event); // "AutoshareCreated"
  
  // 2. Check if already processed (deduplication)
  const fingerprint = `${event.contractId}:${event.id}`;
  if (await isAlreadyProcessed(fingerprint)) {
    return; // Skip duplicate
  }
  
  // 3. Validate event structure
  if (!validateEventPayload(event)) {
    return; // Skip invalid event
  }
  
  // 4. Check against allowed events filter
  if (!shouldProcessEvent(event, contractConfig)) {
    return; // Skip filtered event
  }
  
  // 5. Add to event registry (in-memory feed)
  eventRegistry.addFromInput(event);
  
  // 6. Record as processed in database
  await markAsProcessed(fingerprint, event);
  
  // 7. Trigger notification delivery
  await sendNotification(event);
}
```

**Deduplication Table:**

```sql
CREATE TABLE processed_events (
  fingerprint TEXT NOT NULL UNIQUE,  -- contract_address:event_id
  event_id TEXT NOT NULL,
  contract_address TEXT NOT NULL,
  ledger_number INTEGER NOT NULL,
  processed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  status VARCHAR(20) DEFAULT 'PROCESSED'
);
```

**Key Files:**
- `listener/src/services/event-deduplication-service.ts` - Deduplication
- `listener/src/store/event-registry.ts` - In-memory event storage
- `listener/src/database/schema.sql` - Database schema

### Step 4: Notification Decision

The system determines whether and how to send a notification.

**Decision Tree:**

```
Is Discord configured for this contract? 
├─ Yes: Check user preferences
│  ├─ Enabled → Send Discord notification
│  └─ Disabled → No notification
└─ No: Skip notification
```

**User Preferences Example:**

```typescript
// Stored in preference_store table
{
  userId: "GXXX...",
  contractAddress: "CXXX...",
  discord: {
    enabled: true,
    webhookUrl: "https://discord.com/api/webhooks/..."
  }
}
```

**Key Files:**
- `listener/src/store/preference-store.ts` - User preferences
- `listener/src/services/discord-notification.ts` - Discord logic

### Step 5: Notification Delivery

The notification is formatted and delivered to the configured channel.

**Discord Message Example:**

```markdown
🔔 **New AutoShare Group Created**

**Event**: AutoshareCreated
**Contract**: CXXX...abc
**Creator**: GXXX...xyz
**Category**: Group
**Priority**: Medium
**Group ID**: abc123...
**Ledger**: 12345
**Time**: 2024-01-15 10:30:00 UTC

[View on Stellar Explorer](https://stellar.expert/explorer/testnet/...)
```

**Delivery Process:**

1. **Format**: Convert event data to human-readable message
2. **Sanitize**: Remove sensitive data, truncate long values
3. **Deduplicate**: Skip if same event sent recently (60s window)
4. **Send**: HTTP POST to Discord webhook
5. **Retry**: Retry up to 3 times on failure
6. **Record**: Log delivery status in execution log

**Key Files:**
- `listener/src/services/discord-notification.ts` - Message formatting
- `listener/src/services/webhook-sender.ts` - HTTP delivery
- `listener/src/services/notification-retry-queue.ts` - Retry logic

## Complete Flow Example

Let's trace a complete event from start to finish:

### On-Chain (Step 1)
```
Time: 10:30:00
Action: User calls create_autoshare()
Result: Contract emits AutoshareCreated event
Ledger: 12345
```

### Listener Polling (Step 2)
```
Time: 10:30:15 (15 seconds later, next poll)
Action: Listener polls Stellar RPC
Result: Receives AutoshareCreated event
Event ID: 0001234567890123-0000000001
```

### Processing (Step 3)
```
Time: 10:30:15.100
Action: Process event
Steps:
  ✓ Parse event name: "AutoshareCreated"
  ✓ Check dedup: Not seen before
  ✓ Validate: Structure valid
  ✓ Check filter: Matches allowlist
  ✓ Add to registry: Event visible in API
  ✓ Mark processed: Saved to DB
```

### Notification Decision (Step 4)
```
Time: 10:30:15.200
Check: Discord enabled for user GXXX...?
Result: Yes, webhookUrl configured
Decision: Send Discord notification
```

### Delivery (Step 5)
```
Time: 10:30:15.300
Action: Send to Discord webhook
Result: 200 OK
Status: Delivered successfully
```

**Total Latency: ~15 seconds** (from contract emission to notification delivery)

## Key Components Summary

| Component | Responsibility | Technology |
|-----------|---------------|------------|
| **Smart Contract** | Emit typed events on state changes | Rust/Soroban |
| **Stellar Ledger** | Store events permanently | Stellar Network |
| **EventSubscriber** | Poll RPC for new events | Node.js/TypeScript |
| **EventDeduplicationService** | Prevent duplicate processing | SQLite |
| **EventRegistry** | Provide event feed API | In-memory |
| **PreferenceStore** | Store user notification preferences | SQLite |
| **DiscordNotificationService** | Format and send Discord messages | Node.js/TypeScript |
| **WebhookSender** | HTTP transport for notifications | Node.js/fetch |

## Configuration Quick Reference

### Minimal .env for Event Notifications

```bash
# Network
STELLAR_RPC_URL=https://soroban-testnet.stellar.org:443
STELLAR_NETWORK=testnet
STELLAR_NETWORK_PASSPHRASE=Test SDF Network ; September 2015

# Contracts to monitor
CONTRACT_ADDRESSES=[{"address":"YOUR_CONTRACT_ID","events":["*"]}]

# Polling
POLL_INTERVAL_MS=30000

# Discord (optional)
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/YOUR/WEBHOOK
DISCORD_WEBHOOK_ID=YOUR_WEBHOOK_ID

# Database
DATABASE_PATH=./data/notifications.db

# API
EVENTS_API_PORT=8787
```

## Common Failure Points

| Failure Point | Symptom | Troubleshooting |
|--------------|---------|-----------------|
| **RPC Unavailable** | No events received | Check `STELLAR_RPC_URL`, network connectivity |
| **Wrong Contract ID** | Events not appearing | Verify `CONTRACT_ADDRESSES` matches deployed contract |
| **Event Filtered Out** | Specific events missing | Check `events` array in contract config |
| **Dedup False Positive** | Event processed once then skipped | Check `processed_events` table |
| **Discord 404** | Notifications not sent | Verify `DISCORD_WEBHOOK_URL` is correct |
| **Database Locked** | Processing stalls | Check SQLite concurrency, file permissions |

## Next Steps

This guide covers the foundational 1% of event-to-notification documentation:
- ✅ High-level flow overview
- ✅ Simple end-to-end example
- ✅ Key components identified
- ✅ Basic troubleshooting

### Future Enhancements (Remaining 99%)

**Phase 2: Detailed Component Documentation (20%)**
- In-depth EventSubscriber implementation details
- Cursor management and reorg handling
- Event queue concurrency patterns
- Deduplication algorithms

**Phase 3: Advanced Delivery Patterns (20%)**
- Scheduled notifications (durable)
- Multi-channel delivery (Email, SMS, Webhook)
- Retry strategies and backoff
- Dead letter queue handling

**Phase 4: Contract Integration Guide (20%)**
- How to design contract events
- Best practices for event structure
- Event versioning strategies
- Testing contract events

**Phase 5: Monitoring & Debugging (20%)**
- Observability setup
- Log analysis
- Performance profiling
- Troubleshooting workflows

**Phase 6: Advanced Topics (19%)**
- Event batching and digests
- Rate limiting strategies
- Security considerations
- Scaling patterns

## Related Documentation

- **[CONTRIBUTOR_EVENT_LIFECYCLE.md](CONTRIBUTOR_EVENT_LIFECYCLE.md)** - Detailed technical lifecycle guide
- **[CONTRACT_EVENT_REFERENCE.md](CONTRACT_EVENT_REFERENCE.md)** - Complete event catalog
- **[BACKEND_ARCHITECTURE.md](BACKEND_ARCHITECTURE.md)** - Full architecture overview
- **[SYSTEM_ARCHITECTURE.md](SYSTEM_ARCHITECTURE.md)** - System-wide design
- **[FAILURE_RECOVERY_RUNBOOK.md](FAILURE_RECOVERY_RUNBOOK.md)** - Production troubleshooting

## Quick Links

### Code References
- Event Polling: [`listener/src/services/event-subscriber.ts`](listener/src/services/event-subscriber.ts)
- Event Processing: [`listener/src/index.ts`](listener/src/index.ts)
- Discord Delivery: [`listener/src/services/discord-notification.ts`](listener/src/services/discord-notification.ts)
- Contract Events: [`contract/contracts/hello-world/src/base/events.rs`](contract/contracts/hello-world/src/base/events.rs)

### Test Examples
- E2E Lifecycle Test: [`listener/src/__tests__/notification-delivery-lifecycle.e2e.test.ts`](listener/src/__tests__/notification-delivery-lifecycle.e2e.test.ts)
- Event Subscriber Test: [`listener/src/services/event-subscriber.test.ts`](listener/src/services/event-subscriber.test.ts)

## Glossary

| Term | Definition |
|------|------------|
| **Event** | A typed data structure emitted by a smart contract |
| **Ledger** | A block in the Stellar blockchain |
| **RPC** | Remote Procedure Call - API for querying Stellar |
| **Cursor** | Bookmark tracking last processed ledger/event |
| **Fingerprint** | Unique identifier for event: `contract:event_id` |
| **Deduplication** | Preventing the same event from being processed twice |
| **Webhook** | HTTP endpoint for receiving notifications |
| **Topic** | Indexed event field (searchable) |
| **Value** | Event data payload (not indexed) |

---

**Last Updated**: 2024-01-15  
**Version**: 1.0.0 (Phase 1 - 1% Complete)  
**Maintained By**: NotifyChain Contributors
