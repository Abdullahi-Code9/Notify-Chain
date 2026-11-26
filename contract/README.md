# AutoShare Contract

AutoShare lives under `contracts/hello-world` (directory name kept for historical Soroban scaffold layout).

## Project Structure

This package uses the recommended structure for a Soroban project:
```text
.
├── contracts
│   └── hello-world
│       ├── src
│       │   ├── lib.rs
│       │   └── test.rs
│       └── Cargo.toml
├── Cargo.toml
└── README.md
```

- New Soroban contracts can be put in `contracts`, each in their own directory. There is already a `hello-world` contract in there to get you started.
- If you initialized this project with any other example contracts via `--with-example`, those contracts will be in the `contracts` directory as well.
- Contracts should have their own `Cargo.toml` files that rely on the top-level `Cargo.toml` workspace for their dependencies.
- Frontend libraries can be added to the top-level directory as well. If you initialized this project with a frontend template via `--frontend-template` you will have those files already included.
---

## ABI Reference — AutoShareContract

### Notification Category

Every event carries a `NotificationCategory` as its last indexed topic so off-chain consumers can subscribe to or filter whole categories without decoding the payload.

| Variant        | Value | Description                                             |
|----------------|-------|---------------------------------------------------------|
| `Group`        | 0     | AutoShare group lifecycle (created, updated, toggled)   |
| `Admin`        | 1     | Administrative actions (pause, unpause, admin transfer) |
| `Financial`    | 2     | Fund movements (withdrawals)                            |
| `Notification` | 3     | Scheduled notification operations (cancellation)        |

---

### Events

#### `scheduled_notification_cancelled`

Emitted whenever `cancel_notification` is called successfully.

**Topics** (in order):

| Index | Type                   | Description                                        |
|-------|------------------------|----------------------------------------------------|
| 0     | `Symbol`               | Event name: `"scheduled_notification_cancelled"`   |
| 1     | `Address`              | Address of the caller that triggered cancellation  |
| 2     | `NotificationCategory` | Always `Notification` (discriminant value `3`)     |

**Data** (`data_format = "single-value"`):

| Field              | Type         | Description                                       |
|--------------------|--------------|---------------------------------------------------|
| `notification_id`  | `BytesN<32>` | Unique identifier of the cancelled notification   |

**Example** (XDR topics decoded):
```
topics[0] = Symbol("scheduled_notification_cancelled")
topics[1] = Address("G...")       // caller
topics[2] = u32(3)                // NotificationCategory::Notification
data       = Bytes(32)            // notification_id
```

---

### Functions

#### `cancel_notification(notification_id: BytesN<32>, caller: Address)`

Cancels a scheduled notification and emits a `ScheduledNotificationCancelled` event on-chain.

- **Authentication**: `caller` must authorize the invocation (`caller.require_auth()`).
- **Paused check**: returns `ContractPaused` (error code 11) when the contract is paused.
- **State**: the contract does not maintain an internal registry of scheduled notifications; the `notification_id` is recorded solely in the emitted event.

**Parameters:**

| Name               | Type         | Description                              |
|--------------------|--------------|------------------------------------------|
| `notification_id`  | `BytesN<32>` | Identifier of the notification to cancel |
| `caller`           | `Address`    | Address authorizing the cancellation     |

**Errors:**

| Code | Variant          | Condition                          |
|------|------------------|------------------------------------|
| 11   | `ContractPaused` | Contract is currently paused       |

---

## Input Size Limits

Every entry point that accepts a variable-length input validates its size **at
the very top of the function** — strictly *before* any storage write, TTL
extension, or event emission — and returns a descriptive error on failure. All
bounds are declared as named `pub const`s in
`contracts/hello-world/src/base/constants.rs`, which is the single source of
truth (off-chain clients should mirror these values).

Byte-length limits are measured in **bytes** (Soroban `String::len` returns the
UTF-8 byte length, not the character count).

| Constant                        | Bound  | Entry point / field                            |
|---------------------------------|--------|------------------------------------------------|
| `MAX_NAME_LEN`                  | 100 B  | `create` — AutoShare group name                |
| `MAX_MEMBER_COUNT`              | 50     | `update_members` — member list length          |
| `MAX_BATCH_SIZE`                | 50     | `batch_schedule_notifications` — entries       |
| `MAX_BATCH_SUBSCRIBE`           | 50     | `batch_subscribe` — channel ids                |
| `MAX_CHANNEL_NAME_LEN`          | 100 B  | `create_channel` — channel name                |
| `MAX_CHANNEL_DESCRIPTION_LEN`   | 256 B  | `update_channel_metadata` — description        |
| `MAX_CHANNEL_CUSTOM_FIELDS`     | 20     | `update_channel_metadata` — custom fields      |
| `MAX_TEMPLATE_NAME_LEN`         | 100 B  | `register_template` / `update_template` — name |
| `MAX_EVENT_PAYLOAD_LEN`         | 4096 B | template content / notification payload body   |
| `MAX_TOPIC_LEN`                 | 256 B  | `schedule_notification` — title (topic text)   |
| `MAX_METADATA_STRING_LEN`       | 256 B  | metadata string key / value                    |
| `MAX_METADATA_FIELDS`           | 20     | metadata custom-field entries                  |

**Failure errors:**

| Code | Variant                     | Condition                                                        |
|------|-----------------------------|------------------------------------------------------------------|
| 46   | `InputTooLarge`             | A collection (members, batch, custom fields) exceeds its bound   |
| 47   | `PayloadExceedsMaxLength`   | A payload/title/content string exceeds its byte-length bound     |

> A notification's `ttl_seconds` is separately bounded by
> `MAX_NOTIFICATION_LIFETIME_SECONDS` (2,592,000 = 30 days).

---

## Persistent Storage Lifecycle & Cleanup

Records are split into two lifecycle categories:

- **Historical / immutable** — never removed by cleanup:
  payment history, the audit log (`AuditRecord`), archived notifications
  (`ArchivedNotification`), AutoShare group state, channel metadata, templates,
  supported tokens, and contract config (admin, pause flag, version).
- **Ephemeral / expirable** — may be reclaimed once stale:
  scheduled notifications (`DataKey::ScheduledNotification`), which are bounded
  by their `expires_at`, and delivery-idempotency records.

### `cleanup_expired_records(admin: Address, notification_ids: Vec<BytesN<32>>) -> Result<u32, Error>`

Prunes expired **ephemeral** records in a single, admin-only call.

- **Access control**: `admin` must authorize the call *and* be the current
  contract admin; otherwise the call reverts with `Unauthorized`.
- **Input**: the caller supplies the notification ids to consider. There is no
  unbounded on-chain index, so gas cost is proportional to the input length.
- **Behaviour per id**:
  - *Expired* (`now >= expires_at`): the active entry is **archived first**
    (preserving immutable history with `archive_reason = "expired"`), then
    removed from active storage.
  - *Live*: never removed; its Soroban TTL is refreshed via `extend_ttl`
    (threshold `17,280` ledgers ≈ 1 day, extend-to `518,400` ledgers ≈ 30 days)
    so it is not evicted before its own `expires_at`.
  - *Unknown*: ignored.
- **Returns**: the number of expired records pruned.
- **Events**: emits `records_cleaned_up` with the pruned count.

### TTL management

Active scheduled notifications are extended on write and on cleanup:

| Constant                        | Ledgers  | Approx. duration (@ 5s/ledger) |
|---------------------------------|----------|--------------------------------|
| `NOTIFICATION_TTL_THRESHOLD`    | 17,280   | ~1 day                         |
| `NOTIFICATION_TTL_EXTEND_TO`    | 518,400  | ~30 days                       |

Historical/immutable records are never deleted by any code path; the *only*
removal performed by cleanup is the active `ScheduledNotification` entry, which
is archived before removal.
