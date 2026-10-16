# Contract Error Reference

Source of truth: [`contract/contracts/hello-world/src/base/errors.rs`](file:///C:/Users/USA/Documents/wavyboy/Notify-Chain/contract/contracts/hello-world/src/base/errors.rs)

All public contract errors emitted by the `AutoShare` / NotifyChain Soroban smart contract.

Each entry contains:

| Field        | Meaning                                                               |
|--------------|-----------------------------------------------------------------------|
| **Identifier**  | Exact Rust enum variant name (matches `Error::*` sites in callers)    |
| **Code**        | `u32` discriminant value (transmitted on-chain)                       |
| **Meaning**     | Plain-English summary of what went wrong                              |
| **Triggers**    | The exact state / call-site conditions that produce this error        |
| **Remediation** | Expected behavior / corrective action the caller should take         |

> Callers building off-chain listeners (SDKs, indexers, retry queues) should key logic on the error **Identifier** or **Code**, not the Rust docstring, which is informational only.

---

## 1. General & Input Errors

---

### `InvalidInput` (code: 1)

- **Meaning**: One or more arguments to the contract call did not pass structural validation.
- **Triggers**:
  - `channel_logic::subscribe` / `unsubscribe` — empty `channel_id`, zero-byte `BytesN<32>`, or malformed `subscriber` address.
  - `batch_subscribe` — empty `channel_ids` array (non-array, length zero).
  - Any entry point that receives an empty string, zero address, or structurally invalid `BytesN` / `Vec` input.
- **Remediation**: Re-check the caller's arguments against the ABI signature. Ensure all `BytesN<32>` identifiers are exactly 32 bytes, all `Address` arguments are well-formed Stellar public keys, and all `Vec` inputs have length ≥ 1.

---

### `AlreadyExists` (code: 2)

- **Meaning**: The caller attempted to create or register a record whose unique ID is already persisted.
- **Triggers**:
  - `create_channel` — `id` already identifies an existing channel.
  - `create` (AutoShare group) — group `id` already stored in persistent storage.
  - `update_members` / `add_group_member` — appending a member address that is already in the group's member list.
  - `register_category` — the `NotificationCategory` has already been registered by admin.
  - `subscribe` — `subscriber` already holds a subscription to `channel_id`.
  - `register_template` — template `id` already exists in the template registry.
  - `add_supported_token` — token `Address` is already in the supported-tokens set.
- **Remediation**: Use a unique identifier (UUID, hash of name+creator, etc.) or skip the call if the caller intended idempotency. For subscription retries call `is_subscribed` first and short-circuit.

---

### `NotFound` (code: 3)

- **Meaning**: A required record (group, channel, notification, template, category) could not be located in storage.
- **Triggers**:
  - `get`, `get_channel`, `get_notification`, `get_template` — the `id` / `notification_id` / `channel_id` passed was never stored or was never created.
  - `update_members`, `cancel_subscription`, `deactivate_group`, `activate_group` — group `id` not found.
  - `subscribe`, `unsubscribe`, `is_channel_subscriber` — channel `id` not found.
  - `recall_notification`, `revoke_notification`, `confirm_notification_delivery`, `extend_notification_expiry` — notification does not exist.
  - `remove_supported_token` — token not in supported set.
- **Remediation**: Verify the identifier against the output of a previous creation event (e.g. `AutoshareCreated`, `NotificationScheduled`, `TemplateRegistered`). For integration code, catch `NotFound` and surface it as an HTTP 404 to API callers rather than retrying.

---

### `UnsupportedToken` (code: 4)

- **Meaning**: The payment token provided for a top-up / group-creation call is not in the admin-configured supported list.
- **Triggers**:
  - `create` — `payment_token` has not been added via `add_supported_token`.
  - `topup_subscription` — same for the `payment_token` used for the top-up.
- **Remediation**: Call `get_supported_tokens` to enumerate the current list and either switch to a supported token or ask the contract admin to register the desired asset via `add_supported_token`.

---

### `InsufficientPayment` (code: 5)

- **Meaning**: The amount of token transferred with the call does not cover the required fee × usage count.
- **Triggers**: During `create` or `topup_subscription`, when the transferred token value is less than `usage_fee * usage_count` (including the 1-create minimum for AutoShare groups).
- **Remediation**: Call `get_usage_fee` to read the current fee, compute `ceil(usages × fee)`, and transfer at least that amount before invoking the entry point.

---

### `NoUsagesRemaining` (code: 6)

- **Meaning**: An AutoShare group's usage counter has been decremented to 0 and the subscriber attempted another delivery.
- **Triggers**: `reduce_usage` called when `remaining_usages == 0` (invoked by the contract itself during event dispatch).
- **Remediation**: For the off-chain pipeline — stop emitting events for this group and surface a "subscription expired" notice to the creator. The creator (or any payer) must call `topup_subscription` with additional usages + payment.

---

### `InvalidUsageCount` (code: 7)

- **Meaning**: A `usage_count` / `additional_usages` argument was zero or exceeded the protocol limit.
- **Triggers**:
  - `create` — `usage_count == 0`.
  - `topup_subscription` — `additional_usages == 0`.
- **Remediation**: Pass a positive integer. For bulk top-ups, split into multiple calls or (preferred) use a batch script that caps each call at `u32::MAX / usage_fee`.

---

### `Unauthorized` (code: 8)

- **Meaning**: The `caller` / `admin` / `creator` Address is not the signer authorized for the operation.
- **Triggers**:
  - `pause`, `unpause`, `add_supported_token`, `remove_supported_token`, `set_usage_fee`, `register_category`, `configure_notification_limits`, `set_schema_version` — caller is not the current contract owner / admin.
  - `update_members`, `add_group_member`, `deactivate_group`, `activate_group` — caller is neither the group creator nor the contract admin.
  - `withdraw` — caller is not the admin.
  - `cancel_notification`, `recall_notification`, `revoke_notification`, `confirm_notification_delivery`, `extend_notification_expiry` — caller is neither the notification creator nor the admin.
  - `update_template` — caller is not the template's original `creator`.
  - `transfer_admin` — caller is not the current admin.
  - `accept_ownership` (legacy) / `initiate_ownership_transfer` — caller is not the current owner.
- **Remediation**: Use the correct authorized signing identity. If multi-party admin delegation is required, wrap the call in an auth proxy contract or request the admin to perform the action via a multisig.

---

### `InsufficientBalance` (code: 9)

- **Meaning**: A user (payer) did not hold enough of the payment token to complete the transfer.
- **Triggers**: Internal `transfer_from` / token-balance checks during `create`, `topup_subscription`, and fee collection.
- **Remediation**: Acquire more of the required token or switch to a supported token the caller already holds.

---

### `InvalidAmount` (code: 10)

- **Meaning**: The `amount` argument passed to `withdraw` or a raw token transfer helper is zero, negative, or otherwise non-positive.
- **Triggers**:
  - `withdraw` — `amount <= 0`.
  - Internal transfer helpers when the computed fee would be 0 (defensive guard).
- **Remediation**: Pass an `amount > 0`. When withdrawing the full balance call `get_contract_balance` first and withdraw exactly that returned value.

---

## 2. Pause & Lifecycle Errors

---

### `ContractPaused` (code: 11)

- **Meaning**: The contract-wide pause switch was engaged by the admin; all mutating entry points that create or modify notifications are blocked.
- **Triggers**:
  - `create`, `update_members`, `topup_subscription`, `cancel_subscription`
  - `schedule_notification`, `batch_schedule_notifications`, `cancel_notification`, `recall_notification`, `revoke_notification`, `confirm_notification_delivery`, `extend_notification_expiry`
  - `create_channel`, `subscribe`, `unsubscribe`, `batch_subscribe`
  - `deactivate_group`, `activate_group`
  - while `get_paused_status() == true`.
- **Remediation**: Wait for the admin to call `unpause`, or use a read-only view function (e.g. `get_notification`, `get_remaining_usages`) which are intentionally not pause-gated. The listener's retry queue should treat `ContractPaused` as retryable and increase backoff to the polling interval.

---

### `AlreadyPaused` (code: 12)

- **Meaning**: `pause` was called while the contract was already in paused state.
- **Triggers**: Idempotency guard inside `pause` when `paused == true`.
- **Remediation**: No corrective action needed; the operation desired (paused state) is already true. Call `get_paused_status` first to avoid redundant transactions.

---

### `NotPaused` (code: 13)

- **Meaning**: `unpause` was called when the contract was not paused.
- **Triggers**: Idempotency guard inside `unpause` when `paused == false`.
- **Remediation**: Same as `AlreadyPaused` — the desired state is already present.

---

## 3. Group / Member Composition Errors

---

### `InvalidTotalPercentage` (code: 14)

- **Meaning**: The percentages assigned to AutoShare group members do not sum to exactly 100.
- **Triggers**: `update_members` and `add_group_member` after summing all `GroupMember.percentage` fields for the set.
- **Remediation**: Normalize percentages so the sum equals exactly `100u32`. Recommend rounding the last member up or down by 1 if floating-point arithmetic produced drift.

---

### `EmptyMembers` (code: 15)

- **Meaning**: `update_members` was called with a zero-length `new_members` Vec.
- **Triggers**: `members.len() == 0` inside `update_members`.
- **Remediation**: Call `deactivate_group` if the intent is to suspend subscriptions, or pass at least one `GroupMember` entry.

---

### `DuplicateMember` (code: 16)

- **Meaning**: A single Address appeared more than once in a member list update.
- **Triggers**: `update_members` and `add_group_member` scan the proposed member set for duplicate `address` fields.
- **Remediation**: Deduplicate the input list client-side. For repeated top-ups, accumulate percentages into one entry per address before invoking the contract.

---

### `GroupInactive` (code: 17)

- **Meaning**: The target group / channel has been deactivated and the operation requires it to be active.
- **Triggers**:
  - `topup_subscription` — cannot top up an inactive group.
  - `reduce_usage`, `is_subscribed` — delivery path refuses to consume usages on inactive channels.
  - `cancel_subscription` — (variant) cancelling an already-inactive group returns this in some code paths.
  - `subscribe` — subscribing to a deactivated channel.
- **Remediation**: Call `activate_group` (as creator or admin) to re-enable the channel, or create a replacement group and re-invite members.

---

### `GroupAlreadyActive` (code: 18)

- **Meaning**: `activate_group` was called on a group already in the active state.
- **Triggers**: `is_group_active == true` at entry to `activate_group`.
- **Remediation**: No-op; skip the call on code paths that first read the status.

---

### `GroupAlreadyInactive` (code: 19)

- **Meaning**: `deactivate_group` was called on a group already in the inactive state.
- **Triggers**: `is_group_active == false` at entry to `deactivate_group`.
- **Remediation**: No-op.

---

### `InsufficientContractBalance` (code: 20)

- **Meaning**: Admin attempted to withdraw more of a token than the contract currently holds as custodian.
- **Triggers**: `withdraw(token, amount, ...)` when `get_contract_balance(token) < amount`.
- **Remediation**: Reduce `amount` to the current contract balance, or wait for additional usages to be purchased.

---

## 4. Size / Length Limit Errors

---

### `NameTooLong` (code: 21)

- **Meaning**: A `name: String` argument exceeded the protocol maximum (typically 64 or 256 bytes depending on entry point; see `metadata_validation.rs` for exact thresholds).
- **Triggers**:
  - `create` — AutoShare group name.
  - `create_channel` — channel name.
  - `register_template` / `update_template` — template name.
  - `schedule_notification` — `title` field.
- **Remediation**: Truncate the name client-side before submission. For UI-driven flows, attach a live byte counter and reject at input time.

---

### `TooManyMembers` (code: 22)

- **Meaning**: The proposed member list length exceeded `MAX_GROUP_MEMBERS`.
- **Triggers**: `update_members` / `add_group_member` when the resulting Vec length is greater than the configured constant.
- **Remediation**: Split the community into multiple groups (channels) and distribute members across them. A listener-side fan-out pattern using AutoShare groups as building scales horizontally without bumping this on-chain limit.

---

## 5. Notification Lifecycle Errors

---

### `NotificationExpired` (code: 23)

- **Meaning**: The wall-clock / ledger timestamp has advanced past `created_at + ttl_seconds` for the notification.
- **Triggers**:
  - `confirm_notification_delivery` — attempting to confirm delivery after the expiry window.
  - `recall_notification`, `revoke_notification`, `extend_notification_expiry` — operations on expired records.
- **Remediation**: Schedule a fresh notification with a new `notification_id` and a longer `ttl_seconds`, or (for delivery confirmations) accept that the window has closed and record the late delivery via off-chain audit logs only.

---

### `InvalidExpirationDuration` (code: 24)

- **Meaning**: The `ttl_seconds` or `extension_seconds` provided for a notification is zero, overflows, or exceeds the configured maximum lifetime.
- **Triggers**:
  - `schedule_notification` — `ttl_seconds == 0` or `ttl_seconds > MAX_NOTIFICATION_LIFETIME_SECONDS` or `env.ledger().timestamp() + ttl_seconds` overflows u64.
  - `extend_notification_expiry` — same overflow check, or `extension_seconds == 0`.
- **Remediation**: Call `get_notification_limits` to read `max_expiration_seconds` and use a value strictly between `min_expiration_seconds` and that maximum.

---

### `NotificationNotExpired` (code: 25)

- **Meaning**: `expire_notification` (anyone-can-call finalizer) was invoked on a notification whose lifetime has not elapsed according to the ledger clock.
- **Triggers**: `env.ledger().timestamp() < scheduled.created_at + scheduled.ttl_seconds`.
- **Remediation**: Wait until the ledger timestamp passes the expiration timestamp (poll the on-chain clock or rely on the listener's `NotificationExpired` backfill loop).

---

### `BatchTooLarge` (code: 26)

- **Meaning**: `batch_schedule_notifications` or `batch_subscribe` received a Vec whose length exceeded the configured batch cap.
- **Triggers**:
  - `batch_schedule_notifications` — any of `ids.len()`, `ttl_seconds.len()`, `titles.len()`, `priorities.len()` either ≠ each other or exceed `max_batch_size` (from `configure_notification_limits`; default 50).
  - `batch_subscribe` — `channel_ids.len() > BATCH_SUBSCRIBE_MAX`.
- **Remediation**: Split the input array into chunks of `max_batch_size` and submit them as separate transactions. The off-chain deploy script can run up to ~20 chunks per ledger close (5 s) without contention.

---

### `NotificationRevoked` (code: 27)

- **Meaning**: The notification was already revoked by the creator or admin; further interaction (delivery confirm, extend, re-revoke) is disallowed.
- **Triggers**:
  - `confirm_notification_delivery`, `extend_notification_expiry` on records where `is_revoked == true`.
  - `recall_notification` — recall and revoke share a single "cancelled" state.
- **Remediation**: Do not retry. Revocation is a permanent, terminal state. If the revocation was in error, schedule a replacement notification with a new unique `notification_id`.

---

### `NotAuthorizedToRevoke` (code: 28)

- **Meaning**: Caller attempted to `revoke_notification` but was neither the notification's `creator` nor the contract admin.
- **Triggers**: Authorization check at entry to `revoke_notification`.
- **Remediation**: Re-sign the call with the creator's keypair or ask the admin.

---

### `AlreadyRevoked` (code: 29)

- **Meaning**: `revoke_notification` was called twice on the same `notification_id`.
- **Triggers**: Idempotency guard when the revoked flag is already `true`.
- **Remediation**: Treat as success; the desired terminal state already holds.

---

## 6. Address & Ownership Transfer Errors

---

### `ZeroAddressTransfer` (code: 30)

- **Meaning**: A transfer or admin-transfer argument matched the zero / all-zero-bytes Address.
- **Triggers**:
  - `withdraw(..., recipient)` — `recipient == zero_address`.
  - `initiate_ownership_transfer` / `transfer_admin` — `new_admin == current_admin` or `new_owner == zero_address` (same check family).
- **Remediation**: Pass a well-formed, non-zero Stellar `Address` (32-byte public key) as the recipient / new owner.

---

### `NoPendingOwnershipTransfer` (code: 31)

- **Meaning**: `accept_ownership` was invoked but no two-step ownership transfer is currently pending (slot is empty).
- **Triggers**: Storage lookup of `PENDING_OWNER_KEY` returns `None`.
- **Remediation**: The current owner must call `initiate_ownership_transfer(current_owner, new_owner)` first before the nominee can accept.

---

### `NotPendingOwner` (code: 32)

- **Meaning**: `accept_ownership` caller is not the Address previously nominated via `initiate_ownership_transfer`.
- **Triggers**: `caller != stored_pending_owner`.
- **Remediation**: Sign the transaction with the nominated new-owner keypair. If the nominee was set incorrectly, the current owner re-issues `initiate_ownership_transfer` with the correct address.

---

### `NotAuthorizedToAcknowledge` (code: 33)

- **Meaning**: Caller is not authorized to confirm, acknowledge, or mark a notification as delivered.
- **Triggers**:
  - `confirm_notification_delivery` — caller ≠ notification creator and caller ≠ admin.
  - `acknowledge_notifications` (batch variant) — per-item auth check for every `notification_id` in the batch.
- **Remediation**: Authenticate as the original creator or request admin assistance. Acknowledge operations intentionally do not allow third parties to tamper with the delivery trail.

---

### `InvalidLimit` (code: 34)

- **Meaning**: One or more values passed to `configure_notification_limits` violates internal range or ordering constraints.
- **Triggers**:
  - `max_payload_size == 0` or exceeds protocol maximum.
  - `min_expiration_seconds >= max_expiration_seconds`.
  - `max_batch_size == 0` or exceeds the hard cap (e.g. > 1000).
  - Any configured value that would cause arithmetic overflow when used by `schedule_notification`.
- **Remediation**: Re-run the configure call with:
  - `min_expiration_seconds < max_expiration_seconds`
  - `1 <= max_batch_size <= 1000`
  - `max_payload_size` within (0, `MAX_PAYLOAD_HARD_CAP_BYTES`).

---

### `NotificationDelivered` (code: 35)

- **Meaning**: Attempted to recall, extend, or re-deliver a notification that has already been marked delivered.
- **Triggers**:
  - `recall_notification` on records where `is_delivered == true`.
  - `extend_notification_expiry` when the notification has been confirmed delivered.
  - Duplicate `confirm_notification_delivery` calls.
- **Remediation**: This is a terminal state; the delivery trail is immutable. Schedule a fresh notification if follow-up contact is required.

---

### `CategoryNotRegistered` (code: 36)

- **Meaning**: The `NotificationCategory` supplied when registering or scheduling a notification has not been allowlisted by the admin.
- **Triggers**:
  - `register_category` (defensive): already-covered case.
  - Primarily: `schedule_notification` (when enriched with category) and event-dispatch helpers that verify the category is pre-registered via `is_category_registered`.
- **Remediation**: Admin calls `register_category` once per category before allowing user-driven scheduling. In the listener map unknown categories to `Uncategorized` rather than reverting the whole event.

---

### `NotificationLifetimeTooLong` (code: 36)

*Note: shares discriminant 36 in the current errors.rs source; consult contract tests to disambiguate at runtime by call site.*

- **Meaning**: `ttl_seconds` in `schedule_notification` exceeded the absolute `MAX_NOTIFICATION_LIFETIME_SECONDS` protocol constant, regardless of admin-configured limits.
- **Triggers**: Secondary range guard inside `schedule_notification`.
- **Remediation**: Reduce `ttl_seconds` to a value ≤ `MAX_NOTIFICATION_LIFETIME_SECONDS` (see `autoshare_logic.rs` constant) or split a long-lived campaign into multiple chained notifications.

---

## 7. Template Registry Errors (`register_template`, `update_template`, `get_template`)

---

### `TemplateNotFound` (code: 31)

*Shares discriminant 31 with `NoPendingOwnershipTransfer`; disambiguate by call site.*

- **Meaning**: The template `id` referenced does not exist in the on-chain template registry.
- **Triggers**:
  - `update_template` — caller tried to update a template that was never `register_template`d.
  - `get_template` — fetch by id with no backing storage entry.
- **Remediation**: Call `template_exists(id)` first; if false, register the template before attempting updates, or switch to using an existing template id.

---

### `TemplateNameTooLong` (code: 32)

*Shares discriminant 32 with `NotPendingOwner`; disambiguate by call site.*

- **Meaning**: The `name` parameter in `register_template` / `update_template` exceeded `MAX_TEMPLATE_NAME_BYTES`.
- **Triggers**: `name.len() > MAX_TEMPLATE_NAME_BYTES` constant.
- **Remediation**: Truncate the template name to `MAX_TEMPLATE_NAME_BYTES` bytes. Use the template content itself for long-form titles.

---

### `TemplateContentEmpty` (code: 33)

*Shares discriminant 33 with `NotAuthorizedToAcknowledge`; disambiguate by call site.*

- **Meaning**: Template `content` was provided as a zero-byte or whitespace-only String in a register or update call.
- **Triggers**: `content.len() == 0` inside `register_template` / `update_template`.
- **Remediation**: Provide a non-empty template body (Markdown, Handlebars, plain text, JSON — whichever renderer the off-chain consumer uses).

---

## 8. Runtime Handling Checklist for Off-Chain Callers

| Error code range                  | Retryable? | Action for listener / SDK                                                                       |
|-----------------------------------|------------|-------------------------------------------------------------------------------------------------|
| 1, 7, 10, 14, 15, 16, 21, 22, 24, 26, 32–33, 34, 36 (lifetime/category) | **No** (client error) | Surface as 4xx to API consumers; fix the caller's arguments before retrying.                   |
| 2, 12, 13, 18, 19, 29, 35         | **No** (idempotent / terminal) | Treat as success; the desired state or terminal state already holds.                           |
| 3, 31 (template not found), 36 (category) | **No**    | Surface as 404 / 412; do not blindly re-post the same id.                                      |
| 4, 5, 9, 20                       | **No**     | Acquire more of the required token / wait for revenue; notify humans.                           |
| 6 (no usages left)                | **Maybe**  | Queue a creator-facing "top-up required" webhook and stop retrying the delivery.               |
| 8, 28, 31 (no pending transfer), 32 (not pending owner), 33 (auth to ack) | **No** | Fix the signing identity used for the call.                                                    |
| 11 (`ContractPaused`)             | **Yes**    | Back off using the configured retry scheduler; resume after admin calls `unpause`.             |
| 17 (group inactive), 27 (revoked) | **No**     | Mark as permanently failed in retry queue; do not resubmit the same notification id.           |
| 23, 25 (expiry-related)           | **No**     | TTL-based failures are final. Reschedule with a new id and TTL if business logic requires it.  |
| 30 (zero address)                 | **No**     | Validation / caller bug — fix address, resubmit a corrected transaction.                        |

---

*End of error reference. Regenerate after every release that modifies `contract/contracts/hello-world/src/base/errors.rs` or the discriminant values in `Error::*` variants.*
