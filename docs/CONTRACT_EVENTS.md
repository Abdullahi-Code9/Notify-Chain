# 📡 Soroban Smart Contract Event Catalog

This document defines the comprehensive event taxonomy emitted by the NotifyChain Soroban smart contracts (Issue #714).

---

## 1. Event Category & Priority Topics

All events publish indexed `NotificationCategory` and `NotificationPriority` topics for off-chain listener filtering:

* **Category**: `Group (0)`, `Admin (1)`, `Financial (2)`, `Notification (3)`, `System (4)`
* **Priority**: `Low (0)`, `Medium (1)`, `High (2)`, `Critical (3)`

---

## 2. Event Taxonomy

### `AutoshareCreated`
Emitted when a new AutoShare group is created.
* **Topics**: `creator: Address`, `category: NotificationCategory`, `priority: NotificationPriority`
* **Data**: `id: BytesN<32>`

### `AutoshareUpdated`
Emitted when an AutoShare group's member list or parameters are modified.
* **Topics**: `updater: Address`, `category: NotificationCategory`, `priority: NotificationPriority`
* **Data**: `id: BytesN<32>`

### `GroupDeactivated`
Emitted when an AutoShare group is deactivated.
* **Topics**: `creator: Address`, `category: NotificationCategory`, `priority: NotificationPriority`
* **Data**: `id: BytesN<32>`

### `GroupActivated`
Emitted when an AutoShare group is re-activated.
* **Topics**: `creator: Address`, `category: NotificationCategory`, `priority: NotificationPriority`
* **Data**: `id: BytesN<32>`

### `CategoryRegistered`
Emitted when a new notification category is registered.
* **Topics**: `admin: Address`, `category: NotificationCategory`, `priority: NotificationPriority`
* **Data**: `category_id: u32`

### `ChannelPreferenceUpdated`
Emitted when user notification channel preferences are updated.
* **Topics**: `user: Address`, `category: NotificationCategory`, `priority: NotificationPriority`
* **Data**: `channel_id: BytesN<32>`

### `ContractPaused`
Emitted when an administrator pauses the contract.
* **Topics**: `admin: Address`, `category: NotificationCategory`, `priority: NotificationPriority`
* **Data**: `paused_at: u64`

### `ContractUnpaused`
Emitted when an administrator unpauses the contract.
* **Topics**: `admin: Address`, `category: NotificationCategory`, `priority: NotificationPriority`
* **Data**: `unpaused_at: u64`

### `AdminTransferred`
Emitted when administrative ownership is transferred.
* **Topics**: `old_admin: Address`, `new_admin: Address`, `category: NotificationCategory`, `priority: NotificationPriority`
* **Data**: `timestamp: u64`

### `AuthorizationFailure`
Emitted upon unauthorized invocation attempts.
* **Topics**: `caller: Address`, `category: NotificationCategory`, `priority: NotificationPriority`
* **Data**: `action: String`

### `Withdrawal`
Emitted when protocol funds are withdrawn.
* **Topics**: `recipient: Address`, `category: NotificationCategory`, `priority: NotificationPriority`
* **Data**: `amount: i128`

### `NotificationScheduled`
Emitted when a notification is queued for delivery.
* **Topics**: `sender: Address`, `category: NotificationCategory`, `priority: NotificationPriority`
* **Data**: `notification_id: BytesN<32>`

### `NotificationExpired`
Emitted when a notification exceeds its TTL without acknowledgment.
* **Topics**: `category: NotificationCategory`, `priority: NotificationPriority`
* **Data**: `notification_id: BytesN<32>`

### `ScheduledNotificationCancelled`
Emitted when a scheduled notification is cancelled prior to delivery.
* **Topics**: `sender: Address`, `category: NotificationCategory`, `priority: NotificationPriority`
* **Data**: `notification_id: BytesN<32>`

### `NotificationDelivered`
Emitted when a notification is successfully received by off-chain endpoints.
* **Topics**: `recipient: Address`, `category: NotificationCategory`, `priority: NotificationPriority`
* **Data**: `notification_id: BytesN<32>`

### `NotificationRecalled`
Emitted when a pending notification is recalled by sender.
* **Topics**: `sender: Address`, `category: NotificationCategory`, `priority: NotificationPriority`
* **Data**: `notification_id: BytesN<32>`

### `NotificationRevoked`
Emitted when a delivered or pending notification is revoked.
* **Topics**: `revoker: Address`, `category: NotificationCategory`, `priority: NotificationPriority`
* **Data**: `notification_id: BytesN<32>`

### `NotificationExtended`
Emitted when a notification lifetime is extended.
* **Topics**: `updater: Address`, `category: NotificationCategory`, `priority: NotificationPriority`
* **Data**: `notification_id: BytesN<32>`

### `NotificationAcknowledged`
Emitted when a recipient acknowledges receipt.
* **Topics**: `recipient: Address`, `category: NotificationCategory`, `priority: NotificationPriority`
* **Data**: `notification_id: BytesN<32>`

### `SubscriptionCancelled`
Emitted when a channel subscription is cancelled.
* **Topics**: `subscriber: Address`, `category: NotificationCategory`, `priority: NotificationPriority`
* **Data**: `channel_id: BytesN<32>`

### `BatchNotificationsCreated`
Emitted when a batch of notifications is dispatched.
* **Topics**: `sender: Address`, `category: NotificationCategory`, `priority: NotificationPriority`
* **Data**: `count: u32`

### `BatchProcessingCompleted`
Emitted when batch event processing finishes.
* **Topics**: `category: NotificationCategory`, `priority: NotificationPriority`
* **Data**: `processed_count: u32`

### `AuditRecordAppended`
Emitted when an immutable audit trail entry is logged.
* **Topics**: `notification_id: BytesN<32>`, `action: AuditAction`, `category: NotificationCategory`, `priority: NotificationPriority`
* **Data**: `seq: u64`, `actor: Address`

### `OwnershipTransferInitiated`
Emitted when contract ownership transfer is queued.
* **Topics**: `current_owner: Address`, `pending_owner: Address`
* **Data**: `timestamp: u64`

### `OwnershipTransferred`
Emitted when contract ownership transfer is completed.
* **Topics**: `new_owner: Address`
* **Data**: `timestamp: u64`

### `ReputationUpdated`
Emitted when an account reputation score is updated.
* **Topics**: `account: Address`
* **Data**: `new_score: i128`

### `NotificationLimitsConfigured`
Emitted when global rate limits are configured.
* **Topics**: `admin: Address`
* **Data**: `limit: u32`

### `ReputationTierChanged`
Emitted when user reputation tier advances.
* **Topics**: `account: Address`
* **Data**: `tier: u32`

### `SchemaVersionSet`
Emitted when protocol schema version is updated.
* **Topics**: `version: u32`
* **Data**: `timestamp: u64`

### `NotificationAccessed`
Emitted upon reading secured notification content.
* **Topics**: `notification_id: BytesN<32>`, `accessor: Address`, `category: NotificationCategory`, `priority: NotificationPriority`
* **Data**: `accessed_at: u64`

### `ChannelMetadataUpdated`
Emitted when channel metadata is modified.
* **Topics**: `channel_id: BytesN<32>`
* **Data**: `metadata_uri: String`

### `NotificationArchived`
Emitted when historical notifications are archived.
* **Topics**: `category: NotificationCategory`
* **Data**: `count: u32`

### `TemplateRegistered`
Emitted when a notification template is created.
* **Topics**: `template_id: BytesN<32>`
* **Data**: `name: String`

### `TemplateUpdated`
Emitted when a notification template is updated.
* **Topics**: `template_id: BytesN<32>`
* **Data**: `name: String`

---

## 3. Drift Validation

Run the documentation drift validation script:

```bash
python3 scripts/validate-contract-events.py
```

## 4. Naming and Topic Conventions

- Declare event structs with unique `PascalCase` names. Soroban exposes the generated event name in `snake_case`.
- Use `snake_case` for event fields.
- Mark indexed fields with `#[topic]` and place all indexed fields before unindexed data fields.
- Declare no more than four indexed fields per event.
- When both `category` and `priority` are indexed, keep them as the final two topics in that order.

Run the naming and topic convention tests and validator:

```bash
python3 -m unittest discover -s scripts -p 'test_contract_event_conventions.py'
python3 scripts/check_contract_event_conventions.py
```
