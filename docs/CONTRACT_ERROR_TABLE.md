# 📜 Soroban Contract Error Codes and Recovery Reference

Every error code the NotifyChain Soroban contracts can return, what triggers it, and how to
recover (issues #710, #1252).

| Contract | Error enum (source of truth) |
| --- | --- |
| NotifyChain core (`hello-world`) | `contract/contracts/hello-world/src/base/errors.rs` → `Error` |
| TaskBounty | `Documents/Task Bounty/src/types.rs` → `Error` |

> **Keeping this in sync.** `python3 scripts/check_contract_error_docs.py` compares the tables
> below with both enums and fails if a code is missing, renamed, renumbered or no longer exists.
> When you add or change an error variant, update the matching table in the same pull request.

---

## 1. How errors surface

A failing invocation aborts the transaction and returns `Error(Contract, #<code>)`:

```text
HostError: Error(Contract, #8)
  Event log: ["contract call failed", "set_preferences", […]]
```

- **Simulation** (`simulateTransaction`) returns the same error before anything is submitted.
  Simulate first, and read the code from the result instead of paying for a failed transaction.
- The **`stellar` CLI** prints `Error(Contract, #8)`. With the generated TypeScript bindings,
  the error is available as `result.error` / the thrown error's `code`.
- Codes are **per contract**: `#3` is `NotFound` in the core contract but `Unauthorized` in
  TaskBounty. Always map a code using the contract that was called.

---

## 2. NotifyChain core contract

| Code | Error | When it is returned | How to resolve |
|:---:|---|---|---|
| `1` | `InvalidInput` | A parameter fails validation (empty string, out-of-range value, malformed metadata). | Validate inputs client-side before invoking. |
| `2` | `AlreadyExists` | A channel, category, template or group with that identifier already exists. | Use a new identifier, or read the existing entity. |
| `3` | `NotFound` | The notification, group, channel or preference does not exist. | Check the ID; query before updating. |
| `4` | `UnsupportedToken` | Payment or top-up with a token that is not on the supported list. | Use a token from `get_supported_tokens`; an admin can call `add_supported_token`. |
| `5` | `InsufficientPayment` | The attached payment is below the required fee. | Read `get_usage_fee` and pay at least that amount. |
| `6` | `NoUsagesRemaining` | An AutoShare group has used up its paid usages. | `topup_subscription`, then retry. |
| `7` | `InvalidUsageCount` | The usage count is zero or otherwise invalid. | Pass a positive count. |
| `8` | `Unauthorized` | The caller lacks admin or owner rights for the action. | Sign with the admin/owner account (`get_admin`). |
| `9` | `InsufficientBalance` | The caller's token balance is too low for the transfer. | Fund the account, then retry. |
| `10` | `InvalidAmount` | The amount is zero, negative or too large. | Pass a positive amount within limits. |
| `11` | `ContractPaused` | The action was attempted while the contract is paused. | Wait for `unpause`; check `get_paused_status`. |
| `12` | `AlreadyPaused` | `pause` was called on a paused contract. | No action needed. |
| `13` | `NotPaused` | `unpause` was called on an active contract. | No action needed. |
| `14` | `InvalidTotalPercentage` | Group member percentages don't sum to exactly 100. | Adjust the shares so they total 100. |
| `15` | `EmptyMembers` | A group was given an empty member list. | Provide at least one member. |
| `16` | `DuplicateMember` | The member list repeats an address. | Deduplicate the addresses. |
| `17` | `GroupInactive` | The action targets a deactivated group. | `activate_group` first. |
| `18` | `GroupAlreadyActive` | `activate_group` was called on an active group. | No action needed. |
| `19` | `GroupAlreadyInactive` | `deactivate_group` was called on an inactive group. | No action needed. |
| `20` | `InsufficientContractBalance` | A `withdraw` exceeds the contract's token balance. | Check `get_contract_balance` and withdraw at most that. |
| `21` | `NameTooLong` | A name exceeds the maximum length (100 bytes for group names). | Shorten the name. |
| `22` | `TooManyMembers` | The member list is longer than the maximum (50). | Split into smaller groups. |
| `23` | `NotificationExpired` | The notification's lifetime has elapsed. | Terminal; schedule a new notification. |
| `24` | `InvalidExpirationDuration` | The expiration duration is zero, overflows the ledger clock, or exceeds the maximum lifetime. | Use a positive duration within the allowed lifetime. |
| `25` | `NotificationNotExpired` | `expire_notification` was called before the lifetime elapsed. | Wait; check `is_notification_expired`. |
| `26` | `BatchTooLarge` | A batch exceeds the maximum size (50). | Split into smaller batches. |
| `27` | `NotificationRevoked` | The notification has been revoked. | Terminal; no further actions apply. |
| `28` | `NotAuthorizedToRevoke` | The caller may not revoke this notification. | Revoke with the publisher or admin account. |
| `29` | `AlreadyRevoked` | The notification is already revoked. | No action needed. |
| `30` | `ZeroAddressTransfer` | A transfer targets the zero address. | Use a real recipient address. |
| `31` | `NoPendingOwnershipTransfer` | `accept_ownership` was called with no transfer queued. | Run `initiate_ownership_transfer` first. |
| `32` | `NotPendingOwner` | `accept_ownership` was called by someone other than the nominated owner. | Accept with the nominated account (`get_pending_owner`). |
| `33` | `NotAuthorizedToAcknowledge` | The caller may not acknowledge this notification. | Acknowledge as the recipient. |
| `34` | `InvalidLimit` | Invalid limit configuration (e.g. in `configure_notification_limits`). | Provide valid, positive limits. |
| `35` | `NotificationDelivered` | A delivered notification cannot be recalled. | Terminal; send a follow-up instead. |
| `36` | `CategoryNotRegistered` | The notification category isn't registered. | `register_category` first (`is_category_registered`). |
| `37` | `NotificationLifetimeTooLong` | The notification lifetime exceeds `MAX_NOTIFICATION_LIFETIME_SECONDS` (30 days). | Use a lifetime of 30 days or less. |
| `38` | `TemplateNotFound` | The template ID is not in the registry. | Create the template, or fix the ID. |
| `39` | `TemplateNameTooLong` | The template name exceeds the maximum length (100). | Shorten the name. |
| `40` | `TemplateContentEmpty` | A template content field is empty. | Provide template content. |
| `41` | `DuplicateDelivery` | A delivery for the same notification was already requested (idempotency). | Treat as success; don't resend. |
| `42` | `NonceAlreadyUsed` | The nonce was already consumed (replay) or is below the signer's next nonce (stale). | Fetch the next nonce and re-sign. |
| `43` | `InvalidNonce` | The nonce is ahead of the expected sequence, or its freshness window is out of bounds. | Use the signer's next expected nonce with a valid window. |
| `44` | `NonceExpired` | The nonce's `valid_until` deadline has passed. | Re-sign with a fresh `valid_until`. |
| `45` | `NonceContractMismatch` | The nonce is bound to a different contract address. | Sign the nonce for this contract's address. |

---

## 3. TaskBounty contract

| Code | Error | When it is returned | How to resolve |
|:---:|---|---|---|
| `1` | `TaskNotFound` | No task with that ID. | Check the ID (`get_total_tasks`). |
| `2` | `SubmissionNotFound` | No submission with that ID. | Check the ID (`get_task_submissions`). |
| `3` | `Unauthorized` | The caller isn't the poster (approve, reject, cancel), isn't a party to the dispute, or the submission belongs to another task. | Sign as the poster or the right party; pass a matching `task_id`. |
| `4` | `TaskExpired` | `submit_work` after the task deadline (`now > deadline`). | Too late to submit; see `Documents/Task Bounty/EXPIRY_AND_REFUND.md`. |
| `5` | `InvalidTaskStatus` | Submitting to a task that is not `Open`/`InProgress`; approving or cancelling a `Completed`/`Cancelled` task; or cancelling after a submission was approved. | Check `get_task(..).status` first. |
| `6` | `InvalidSubmissionStatus` | Approving or rejecting a non-`Pending` submission, approving one with an active dispute, or disputing an `Approved` one. | Check the submission status first. |
| `7` | `InsufficientReward` | `reward` below `MIN_REWARD` (1 000 000, i.e. 0.1 at 7 decimals). | Raise the reward. |
| `8` | `InvalidDeadline` | `deadline` not in the future, or more than 365 days ahead. | Use a deadline in `(now, now + 365 days]`. |
| `9` | `InvalidMaxSubmissions` | `max_submissions` is 0. | Use 1 or more. |
| `10` | `AlreadySubmitted` | The contributor already submitted to this task. | One submission per contributor per task. |
| `11` | `MaxSubmissionsReached` | The task has reached `max_submissions`. | The task is full. |
| `12` | `PaymentFailed` | Defined but not currently returned by any entrypoint (a failed token transfer aborts with the token's own error). | Reserved; if you see it, the contract was changed. Check the deployed version. |
| `13` | `DisputeAlreadyExists` | That submission already has an active dispute. | Wait for the existing dispute. |
| `14` | `ApiKeyNotFound` | The API credential doesn't exist. | Check the credential ID. |
| `15` | `ApiKeyAlreadyExists` | The credential fingerprint is already registered. | Use a new key. |
| `16` | `NoActiveApiKeys` | The organization has no active API key to rotate from. | Register a key first. |
| `17` | `InvalidApiKeyRotation` | The rotation request is invalid (e.g. reusing the same key). | Rotate to a new, different key. |
| `18` | `ApiKeyRevoked` | The credential has been revoked. | Register or rotate to an active key. |
| `19` | `UnauthorizedApiKeyAction` | The caller isn't allowed to manage this organization's keys. | Sign as the organization. |
| `21` | `NoPendingTransfer` | `accept_admin_transfer`/`cancel_admin_transfer` with no pending transfer. | Run `propose_admin_transfer` first. |
| `22` | `TransferAlreadyPending` | Defined but not currently returned (`propose_admin_transfer` replaces any pending proposal). | Reserved; no action needed. |

Code `20` is not assigned in TaskBounty.

---

## 4. Common failure examples

**Paused contract (core #11)**

```bash
stellar contract invoke --id $NOTIFY --source alice -- \
  schedule_notification --creator $ALICE …
# → Error(Contract, #11) ContractPaused
stellar contract invoke --id $NOTIFY -- get_paused_status   # → true; retry after unpause
```

**Group percentages (core #14)**

```bash
stellar contract invoke --id $NOTIFY --source alice -- create … \
  --members '[{"address":"G…A","percentage":60},{"address":"G…B","percentage":30}]'
# → Error(Contract, #14) InvalidTotalPercentage   (60 + 30 ≠ 100)
```

**Replayed signature (core #42)**

```text
First submission with nonce 7 succeeds; re-sending the same signed payload returns
Error(Contract, #42) NonceAlreadyUsed. Fetch the signer's next nonce and sign again.
```

**Late TaskBounty submission (TaskBounty #4)**

```bash
stellar contract invoke --id $TASK_BOUNTY --source bob -- \
  submit_work --task_id 7 --contributor $BOB --work_url "ipfs://…" --description "done"
# → Error(Contract, #4) TaskExpired
```

**Cancelling a completed bounty (TaskBounty #5)**

```bash
stellar contract invoke --id $TASK_BOUNTY --source poster -- \
  cancel_task --task_id 9 --poster $POSTER
# → Error(Contract, #5) InvalidTaskStatus   (reward already paid)
```

---

## 5. Handling errors in off-chain clients

- Map codes per contract (§1) and show the "How to resolve" text to operators.
- Simulate before submitting, so input errors (`1`, `10`, `14`, `21`, `24`, `37`; TaskBounty `7`,
  `8`, `9`) are caught without spending fees.
- Treat "already" codes (`12`, `13`, `18`, `19`, `29`, `41`) as idempotent no-ops rather than
  failures.
- Don't retry terminal states (`23`, `27`, `35`; TaskBounty `4`, `5` on completed or cancelled
  tasks).
