# Smart Contract Event Reference Guide

> **Audience**: contributors, integrators, and backend/listener developers.
>
> This guide documents every event emitted by the NotifyChain smart contracts,
> explains their parameters and data types, provides practical examples, and
> offers usage recommendations for indexers and listeners.

> **Event schema version:** every event documented here is schema **v1**
> (unsuffixed name). Breaking changes ship as `<name>_v<N>` events; query
> `get_event_schema_version()` for the current version. See
> [docs/EVENT_SCHEMA_VERSIONING.md](docs/EVENT_SCHEMA_VERSIONING.md) for the
> versioning rules and compatibility guarantees (#1122).

---

## Table of Contents

1. [Overview](#overview)
2. [How Events Are Structured](#how-events-are-structured)
3. [Shared Types](#shared-types)
4. [AutoShare Contract Events](#autoshare-contract-events)
   - [AutoshareCreated](#autosharecreated)
   - [AutoshareUpdated](#autoshareupdated)
   - [GroupDeactivated](#groupdeactivated)
   - [GroupActivated](#groupactivated)
   - [ContractPaused](#contractpaused)
   - [ContractUnpaused](#contractunpaused)
   - [AdminTransferred](#admintransferred)
   - [Withdrawal](#withdrawal)
   - [AuthorizationFailure](#authorizationfailure)
   - [CategoryRegistered](#categoryregistered)
5. [Notification Lifecycle Events](#notification-lifecycle-events)
   - [NotificationScheduled](#notificationscheduled)
   - [NotificationExpired](#notificationexpired)
   - [ScheduledNotificationCancelled](#schedulednotificationcancelled)
   - [NotificationRevoked](#notificationrevoked)
   - [NotificationExtended](#notificationextended)
   - [BatchNotificationsCreated](#batchnotificationscreated)
   - [BatchProcessingCompleted](#batchprocessingcompleted)
6. [Audit Log Events](#audit-log-events)
   - [AuditRecordAppended](#auditrecordappended)
7. [Access Log Events](#access-log-events)
   - [NotificationAccessed](#notificationaccessed)
8. [Schema Version Events](#schema-version-events)
   - [SchemaVersionSet](#schemaversionset)
9. [Reputation Events](#reputation-events)
   - [ReputationUpdated](#reputationupdated)
   - [ReputationTierChanged](#reputationtierchanged)
   - [NotificationLimitsConfigured](#notificationlimitsconfigured)
10. [TaskBounty Contract Events](#taskbounty-contract-events)
    - [TaskCreated](#taskcreated)
    - [WorkSubmitted](#worksubmitted)
    - [SubmissionApproved](#submissionapproved)
    - [SubmissionRejected](#submissionrejected)
    - [TaskCancelled](#taskcancelled)
    - [DisputeRaised](#disputeraised)
11. [Indexer and Listener Recommendations](#indexer-and-listener-recommendations)

---

## Overview

NotifyChain contracts emit **typed events** for every meaningful state change.
Off-chain components (listener service, dashboard, third-party indexers) consume
these events to trigger notifications, build audit trails, and display real-time
activity.

Events are published via the Stellar Soroban event system. Each event has:

- **Topics** – indexed fields that can be matched without decoding the full payload.
- **Data** – the event body (non-indexed fields serialised as XDR).

---

## How Events Are Structured

Every AutoShare contract event follows a consistent topic layout:

```
Topic 0:  event name  (Symbol, added automatically by the Soroban runtime)
Topic 1+: primary business key(s)  (e.g. creator Address, notification_id)
Topic N-1: NotificationCategory  (u32 enum)
Topic N:   NotificationPriority  (u32 enum, on events that carry it)
Data:      remaining fields
```

> **Backward compatibility note**: `NotificationCategory` and `NotificationPriority`
> were added as the last topics of every event. Existing listeners that only read
> the event name (topic 0) and the original topics are unaffected — the extra
> trailing topics are ignored by consumers that don't look for them.

---

## Shared Types

### `NotificationCategory` (u32)

| Value | Variant | Description |
|-------|---------|-------------|
| `0` | `Group` | AutoShare group lifecycle events |
| `1` | `Admin` | Administrative/system actions |
| `2` | `Financial` | Fund movement (withdrawals) |
| `3` | `Notification` | Scheduled notification operations |

### `NotificationPriority` (u32)

| Value | Variant | Description |
|-------|---------|-------------|
| `0` | `Low` | Informational; no action required |
| `1` | `Medium` | Standard operational event |
| `2` | `High` | Review promptly |
| `3` | `Critical` | Security-relevant or funds-moving; immediate attention |

### `AuditAction` (u32)

| Value | Variant | Description |
|-------|---------|-------------|
| `0` | `Created` | Notification scheduled on-chain |
| `1` | `DeliveryAttempt` | Delivery attempt made |
| `2` | `DeliveryFailed` | Delivery attempt failed |
| `3` | `Acknowledged` | Recipient acknowledged |
| `4` | `Cancelled` | Cancelled before expiry |
| `5` | `Expired` | Expired naturally |

---

## AutoShare Contract Events

### AutoshareCreated

Emitted when a new AutoShare group is created.

| Field | Type | Indexed | Description |
|-------|------|---------|-------------|
| `creator` | `Address` | ✅ topic | Creator of the group |
| `category` | `NotificationCategory` | ✅ topic | Always `Group` (0) |
| `priority` | `NotificationPriority` | ✅ topic | Always `Low` (0) |
| `id` | `BytesN<32>` | data | Unique group identifier |

**Example** (decoded XDR topics/data):
```json
{
  "topics": ["AutoshareCreated", "GABC...creator", 0, 0],
  "data": "aabb...groupId32bytes"
}
```

**Usage**: index by `creator` and `id` to build a group registry.

---

### AutoshareUpdated

Emitted when a group's member list is updated.

| Field | Type | Indexed | Description |
|-------|------|---------|-------------|
| `updater` | `Address` | ✅ topic | Address that triggered the update |
| `category` | `NotificationCategory` | ✅ topic | Always `Group` (0) |
| `priority` | `NotificationPriority` | ✅ topic | Always `Low` (0) |
| `id` | `BytesN<32>` | data | Group identifier |

---

### GroupDeactivated

Emitted when a group is deactivated by its creator.

| Field | Type | Indexed | Description |
|-------|------|---------|-------------|
| `creator` | `Address` | ✅ topic | Group creator |
| `category` | `NotificationCategory` | ✅ topic | Always `Group` (0) |
| `priority` | `NotificationPriority` | ✅ topic | Always `Low` (0) |
| `id` | `BytesN<32>` | data | Group identifier |

---

### GroupActivated

Emitted when a previously deactivated group is reactivated.

| Field | Type | Indexed | Description |
|-------|------|---------|-------------|
| `creator` | `Address` | ✅ topic | Group creator |
| `category` | `NotificationCategory` | ✅ topic | Always `Group` (0) |
| `priority` | `NotificationPriority` | ✅ topic | Always `Low` (0) |
| `id` | `BytesN<32>` | data | Group identifier |

---

### ContractPaused

Emitted when the contract is paused by the admin. All mutating calls are rejected while paused.

| Field | Type | Indexed | Description |
|-------|------|---------|-------------|
| `admin` | `Address` | ✅ topic | Admin who paused the contract |
| `category` | `NotificationCategory` | ✅ topic | Always `Admin` (1) |
| `priority` | `NotificationPriority` | ✅ topic | Always `High` (2) |

---

### ContractUnpaused

Emitted when the contract is resumed.

| Field | Type | Indexed | Description |
|-------|------|---------|-------------|
| `admin` | `Address` | ✅ topic | Admin who unpaused the contract |
| `category` | `NotificationCategory` | ✅ topic | Always `Admin` (1) |
| `priority` | `NotificationPriority` | ✅ topic | Always `Medium` (1) |

---

### AdminTransferred

Emitted when admin rights are transferred to a new address.

| Field | Type | Indexed | Description |
|-------|------|---------|-------------|
| `old_admin` | `Address` | ✅ topic | Previous admin |
| `category` | `NotificationCategory` | ✅ topic | Always `Admin` (1) |
| `priority` | `NotificationPriority` | ✅ topic | Always `Critical` (3) |
| `new_admin` | `Address` | data | Incoming admin |

**Usage**: trigger an immediate alert — admin transfers are security-critical.

---

### Withdrawal

Emitted when the admin withdraws collected usage fees.

| Field | Type | Indexed | Description |
|-------|------|---------|-------------|
| `token` | `Address` | ✅ topic | Token contract address |
| `recipient` | `Address` | ✅ topic | Recipient of the funds |
| `category` | `NotificationCategory` | ✅ topic | Always `Financial` (2) |
| `priority` | `NotificationPriority` | ✅ topic | Always `Critical` (3) |
| `amount` | `i128` | data | Amount transferred (in token smallest unit) |

---

### AuthorizationFailure

Emitted when the contract detects an unauthorized call attempt.

| Field | Type | Indexed | Description |
|-------|------|---------|-------------|
| `caller` | `Address` | ✅ topic | Address that attempted the action |
| `category` | `NotificationCategory` | ✅ topic | Always `Admin` (1) |
| `priority` | `NotificationPriority` | ✅ topic | Always `Critical` (3) |
| `action` | `String` | data | Name of the attempted action |

---

### CategoryRegistered

Emitted when a notification category is registered on-chain.

| Field | Type | Indexed | Description |
|-------|------|---------|-------------|
| `admin` | `Address` | ✅ topic | Admin who registered the category |
| `category` | `NotificationCategory` | ✅ topic | Category being registered |
| `priority` | `NotificationPriority` | ✅ topic | Always `Low` (0) |

---

## Notification Lifecycle Events

> These are **on-chain** schedule/expire/cancel signals. For the full off-chain
> delivery pipeline (listener → Discord → ack/retry/archive), see
> [NOTIFICATION_LIFECYCLE.md](NOTIFICATION_LIFECYCLE.md).

### NotificationScheduled

Emitted when a notification is scheduled on-chain with a bounded lifetime.

| Field | Type | Indexed | Description |
|-------|------|---------|-------------|
| `creator` | `Address` | ✅ topic | Address that scheduled the notification |
| `category` | `NotificationCategory` | ✅ topic | Always `Notification` (3) |
| `priority` | `NotificationPriority` | ✅ topic | Always `Low` (0) |
| `notification_id` | `BytesN<32>` | data | Unique notification identifier |

**Example**:
```json
{
  "topics": ["NotificationScheduled", "GABC...creator", 3, 0],
  "data": "aabb...notificationId32bytes"
}
```

**Usage**: record in your listener's store with `(notification_id, creator, scheduled_at)`.

---

### NotificationExpired

Emitted when a scheduled notification's lifetime elapses.

| Field | Type | Indexed | Description |
|-------|------|---------|-------------|
| `notification_id` | `BytesN<32>` | ✅ topic | Notification that expired |
| `category` | `NotificationCategory` | ✅ topic | Always `Notification` (3) |
| `priority` | `NotificationPriority` | ✅ topic | Always `Low` (0) |
| `expires_at` | `u64` | data | Ledger timestamp (seconds) when it expired |

---

### ScheduledNotificationCancelled

Emitted when a scheduled notification is cancelled before expiry.

| Field | Type | Indexed | Description |
|-------|------|---------|-------------|
| `caller` | `Address` | ✅ topic | Who cancelled it |
| `category` | `NotificationCategory` | ✅ topic | Always `Notification` (3) |
| `priority` | `NotificationPriority` | ✅ topic | Always `Medium` (1) |
| `notification_id` | `BytesN<32>` | data | Cancelled notification's identifier |

---

### NotificationRevoked

Emitted when a notification is revoked by an authorized sender.

| Field | Type | Indexed | Description |
|-------|------|---------|-------------|
| `notification_id` | `BytesN<32>` | ✅ topic | Revoked notification |
| `revoked_by` | `Address` | ✅ topic | Who initiated the revocation |
| `category` | `NotificationCategory` | ✅ topic | Always `Notification` (3) |
| `priority` | `NotificationPriority` | ✅ topic | Always `High` (2) |
| `revoked_at` | `u64` | data | Ledger timestamp (seconds) of revocation |

---

### NotificationExtended

Emitted when a notification's expiry is extended.

| Field | Type | Indexed | Description |
|-------|------|---------|-------------|
| `notification_id` | `BytesN<32>` | ✅ topic | Extended notification |
| `caller` | `Address` | ✅ topic | Who extended it |
| `category` | `NotificationCategory` | ✅ topic | Always `Notification` (3) |
| `priority` | `NotificationPriority` | ✅ topic | Always `Low` (0) |
| `new_expires_at` | `u64` | data | New ledger timestamp (seconds) for expiry |

---

### BatchNotificationsCreated

Emitted after a batch of notifications is scheduled in one transaction. One
`NotificationScheduled` event is also emitted for each individual notification.

| Field | Type | Indexed | Description |
|-------|------|---------|-------------|
| `creator` | `Address` | ✅ topic | Address that submitted the batch |
| `category` | `NotificationCategory` | ✅ topic | Always `Notification` (3) |
| `priority` | `NotificationPriority` | ✅ topic | Always `Low` (0) |
| `count` | `u32` | data | Number of notifications in the batch |
| `ids` | `Vec<BytesN<32>>` | data | All notification identifiers |

**Usage**: use `count` to verify you received exactly that many `NotificationScheduled` events in the same transaction.

---

### BatchProcessingCompleted

Emitted when an off-chain batch of notifications finishes processing.

| Field | Type | Indexed | Description |
|-------|------|---------|-------------|
| `batch_id` | `BytesN<32>` | ✅ topic | Batch identifier |
| `processed_count` | `u32` | data | Number of notifications processed |

---

## Audit Log Events

### AuditRecordAppended

Emitted whenever a new audit record is appended to the on-chain log.

| Field | Type | Indexed | Description |
|-------|------|---------|-------------|
| `notification_id` | `BytesN<32>` | ✅ topic | Notification the record belongs to |
| `action` | `AuditAction` | ✅ topic | Lifecycle stage (see shared types) |
| `category` | `NotificationCategory` | ✅ topic | Always `Notification` (3) |
| `seq` | `u64` | data | Monotonically increasing sequence number |
| `actor` | `Address` | data | Who triggered the action |
| `timestamp` | `u64` | data | Ledger timestamp (seconds) |

**Usage**: key off `(notification_id, action)` to reconstruct the full lifecycle
of a notification. The `seq` field provides a stable total order across all records.

**Example**:
```json
{
  "topics": ["AuditRecordAppended", "aabb...notificationId", 1, 3],
  "data": { "seq": 5, "actor": "GABC...", "timestamp": 1720000000 }
}
```

---

## Access Log Events

### NotificationAccessed

Emitted whenever a protected notification record is accessed (read). Enables
compliance and traceability for off-chain auditors.

| Field | Type | Indexed | Description |
|-------|------|---------|-------------|
| `notification_id` | `BytesN<32>` | ✅ topic | Notification that was accessed |
| `accessor` | `Address` | ✅ topic | Address that accessed the record |
| `category` | `NotificationCategory` | ✅ topic | Always `Notification` (3) |
| `accessed_at` | `u64` | data | Ledger timestamp (seconds) of access |

**Usage**: index by `notification_id` to build a per-notification access trail.
Access records are immutable — once emitted they cannot be modified.

**Example**:
```json
{
  "topics": ["NotificationAccessed", "aabb...notificationId", "GABC...accessor", 3],
  "data": { "accessed_at": 1720000100 }
}
```

---

## Schema Version Events

### SchemaVersionSet

Emitted when the on-chain notification schema version is set or upgraded by the admin.
Off-chain consumers should check this event to gate their parsing logic.

| Field | Type | Indexed | Description |
|-------|------|---------|-------------|
| `admin` | `Address` | ✅ topic | Admin who set the version |
| `category` | `NotificationCategory` | ✅ topic | Always `Admin` (1) |
| `priority` | `NotificationPriority` | ✅ topic | Always `Medium` (1) |
| `schema_version` | `u32` | data | New schema version number |
| `previous_version` | `u32` | data | Previous version (0 if first set) |

**Usage**: listeners should reject event payloads whose `schema_version` is
outside their supported range. Use `is_version_supported()` on-chain or
compare against your listener's `SUPPORTED_SCHEMA_VERSIONS` constant.

**Example**:
```json
{
  "topics": ["SchemaVersionSet", "GABC...admin", 1, 1],
  "data": { "schema_version": 1, "previous_version": 0 }
}
```

---

## Reputation Events

### ReputationUpdated

Emitted when a sender's reputation score changes after a delivery outcome.

| Field | Type | Indexed | Description |
|-------|------|---------|-------------|
| `sender` | `Address` | ✅ topic | Sender whose score was updated |
| `new_score` | `i64` | data | Updated reputation score |
| `successful_count` | `u32` | data | Cumulative successful deliveries |
| `failed_count` | `u32` | data | Cumulative failed deliveries |

---

### ReputationTierChanged

Emitted when a sender's reputation tier changes (e.g., Bronze → Silver).

| Field | Type | Indexed | Description |
|-------|------|---------|-------------|
| `sender` | `Address` | ✅ topic | Sender |
| `category` | `NotificationCategory` | ✅ topic | Always `Notification` (3) |
| `priority` | `NotificationPriority` | ✅ topic | Always `Low` (0) |
| `old_tier` | `u32` | data | Previous tier (0=Unverified … 4=Platinum) |
| `new_tier` | `u32` | data | New tier |
| `reputation_score` | `i64` | data | Score at the time of tier change |

---

### NotificationLimitsConfigured

Emitted when the admin sets protocol-level notification limits.

| Field | Type | Indexed | Description |
|-------|------|---------|-------------|
| `admin` | `Address` | ✅ topic | Admin who configured the limits |
| `category` | `NotificationCategory` | ✅ topic | Always `Admin` (1) |
| `priority` | `NotificationPriority` | ✅ topic | Always `Medium` (1) |
| `max_payload_size` | `u32` | data | Maximum notification payload in bytes |
| `max_expiration_seconds` | `u64` | data | Maximum TTL in seconds |
| `min_expiration_seconds` | `u64` | data | Minimum TTL in seconds |
| `max_batch_size` | `u32` | data | Maximum notifications per batch |

---

## TaskBounty Contract Events

The TaskBounty contract (`Documents/Task Bounty/`) uses a simpler event format
(two-element topic tuple + data tuple) without `NotificationCategory` topics.

### TaskCreated

Emitted when a new bounty task is created.

| Topics | `(symbol "task", symbol "created")` |
|--------|--------------------------------------|
| Data | `(task_id: u64, poster: Address, title: String, reward: i128, deadline: u64)` |

---

### WorkSubmitted

Emitted when a contributor submits work for a task.

| Topics | `(symbol "work", symbol "submit")` |
|--------|-------------------------------------|
| Data | `(task_id: u64, submission_id: u64, contributor: Address, work_url: String)` |

---

### SubmissionApproved

Emitted when a poster approves a submission and the reward is transferred.

| Topics | `(symbol "sub", symbol "approved")` |
|--------|--------------------------------------|
| Data | `(task_id: u64, submission_id: u64, contributor: Address, reward: i128)` |

---

### SubmissionRejected

Emitted when a poster rejects a submission.

| Topics | `(symbol "sub", symbol "rejected")` |
|--------|--------------------------------------|
| Data | `(task_id: u64, submission_id: u64, contributor: Address)` |

---

### TaskCancelled

Emitted when a task is cancelled by its poster.

| Topics | `(symbol "task", symbol "cancel")` |
|--------|-------------------------------------|
| Data | `(task_id: u64, poster: Address)` |

---

### DisputeRaised

Emitted when a dispute is raised against a submission.

| Topics | `(symbol "dispute", symbol "raised")` |
|--------|----------------------------------------|
| Data | `(task_id: u64, submission_id: u64, raiser: Address, reason: String)` |

---

## Indexer and Listener Recommendations

### Subscribing selectively

Use the `category` topic (second-to-last for most events) to filter event streams
without decoding the full payload:

```
category == 2  →  Financial events only  (Withdrawal)
category == 3  →  Critical == only (AdminTransferred, Withdrawal, AuthorizationFailure)
```

### Handling schema versions

1. On startup, call `get_schema_version()` to read the current version.
2. Subscribe to `SchemaVersionSet` events and refresh your version gate whenever it fires.
3. Drop any event whose decoded `schema_version` field is outside your supported range and emit a warning log.

### Building an audit trail

- Subscribe to `AuditRecordAppended` events and persist each record keyed by `(notification_id, seq)`.
- The `seq` field is monotonically increasing across *all* notifications — use it for total ordering.
- Audit records are immutable on-chain; do not allow updates in your off-chain store.

### Access log compliance

- Subscribe to `NotificationAccessed` events and persist `(notification_id, accessor, accessed_at)`.
- These records are compliance artefacts — treat them as append-only.

### Deduplication

The listener service deduplicates events by `(contract_address, event_id)`. If
you build a custom indexer, apply the same fingerprint to avoid double-counting
`AuditRecordAppended` and `NotificationScheduled` events, which are high-volume.

### Reconnect and replay

The Stellar RPC `getEvents` endpoint supports cursor-based pagination. Store the
last processed `event_id` (or ledger cursor) and resume from that point after a
reconnect to avoid gaps in your event stream.

### Priority-based alerting

Map `NotificationPriority` to your alerting system:

| Priority | Action |
|----------|--------|
| `Low` (0) | Log only |
| `Medium` (1) | Dashboard update |
| `High` (2) | Notify on-call (non-urgent) |
| `Critical` (3) | Page on-call immediately |

## Operation correlation (issue #1194)

The contract publishes an additional `operation_correlated` event alongside the
existing lifecycle events for a notification. Its indexed topics are the
correlation id, category, and priority; its data is the operation name.

Correlation semantics:

- The identifier is the unique 32-byte notification id, so every transition
  for that notification (scheduled, cancelled, delivered, recalled, revoked,
  expired, acknowledged) shares one id.
- Different notifications always have different identifiers.
- The event is additive: the original events and their topic/data layout are
  unchanged, so existing consumers keep working. Consumers that need tracing
  can group by `correlation_id` and sort by operation or ledger sequence.
