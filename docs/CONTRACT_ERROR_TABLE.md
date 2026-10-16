# 📜 Soroban Smart Contract Error Reference Table

This document provides a comprehensive mapping of all Soroban smart contract error codes, their trigger conditions, and expected caller behavior (Issue #710).

---

## 1. Overview

NotifyChain's smart contracts use custom Soroban `#[contracterror]` return types. When a contract invocation fails, the transaction aborts and returns a specific `u32` error code.

---

## 2. Contract Error Reference

| Code | Error Identifier | Description & Trigger Conditions | Expected Caller Action / Resolution |
|:---:|---|---|---|
| `1` | `InvalidInput` | Provided parameters fail structural validation (e.g. empty strings, zero addresses). | Check input formats and ensure non-empty arguments before invoking. |
| `2` | `AlreadyExists` | Entity (channel, category, or template) with the given identifier already exists. | Use a unique identifier or query existing entities via read-only methods. |
| `3` | `NotFound` | Queried resource (notification, channel, or preference) does not exist in storage. | Verify entity existence before invoking updates or queries. |
| `4` | `UnsupportedToken` | Attempted payment or deposit using an unapproved Soroban token contract. | Pass a registered and approved token contract address. |
| `5` | `InsufficientPayment` | Attached payment amount is less than the required service or registration fee. | Query contract fee structure and fund the account with adequate balance. |
| `6` | `NoUsagesRemaining` | AutoShare group usage quota has been completely exhausted. | Top up or renew group usage allocations prior to subsequent dispatch. |
| `7` | `InvalidUsageCount` | Specified usage count is non-positive or overflows max limits. | Supply a valid positive integer count (`1..=10,000`). |
| `8` | `Unauthorized` | Caller lacks administrative or ownership authorization for the action. | Ensure the transaction is signed with the correct admin or owner secret key. |
| `9` | `InsufficientBalance` | User balance is lower than the transfer or escrow amount requested. | Ensure sufficient token balances before attempting transfer/escrow calls. |
| `10` | `InvalidAmount` | Supplied numerical amount is zero or exceeds maximum permissible value. | Pass a non-zero, valid numerical amount. |
| `11` | `ContractPaused` | Operation attempted while the contract is under administrative pause. | Wait for administrator to unpause the contract or check status notices. |
| `12` | `AlreadyPaused` | Admin attempted to pause an already paused contract. | Verify state before triggering pause transitions. |
| `13` | `NotPaused` | Admin attempted to unpause a contract that is currently active. | Check contract status before unpausing. |
| `14` | `InvalidTotalPercentage` | AutoShare group member percentage allocations do not sum to exactly 100%. | Adjust member splits so that $\sum \text{percentage} = 100$. |
| `15` | `EmptyMembers` | Attempted to configure an AutoShare group with zero members. | Provide at least one valid member address in the configuration. |
| `16` | `DuplicateMember` | Member address list contains repeated or duplicated accounts. | Deduplicate member address arrays before submission. |
| `17` | `GroupInactive` | Interaction attempted with a deactivated AutoShare group. | Re-activate the group before publishing notifications. |
| `18` | `GroupAlreadyActive` | Attempted to activate a group that is already in active state. | No action needed; group is already operational. |
| `19` | `GroupAlreadyInactive` | Attempted to deactivate a group that is already inactive. | No action needed; group is already inactive. |
| `20` | `InsufficientContractBalance` | Contract balance cannot satisfy the requested withdrawal. | Ensure withdrawal requests do not exceed contract token balances. |
| `21` | `NameTooLong` | Supplied entity or channel name exceeds maximum allowed byte length. | Shorten string name within permitted limit (max 64 bytes). |
| `22` | `TooManyMembers` | Member array length exceeds maximum permissible limit. | Limit member count to allowable maximum. |
| `23` | `NotificationExpired` | Interaction attempted with a notification whose TTL/lifetime has elapsed. | Notification is terminal; no further updates can be applied. |
| `24` | `InvalidExpirationDuration` | Expiration timestamp is zero, in the past, or exceeds protocol maximum. | Specify valid future expiration within allowable lifetime window. |
| `25` | `NotificationNotExpired` | Attempted to trigger cleanup/expiry before notification lifetime ended. | Wait until expiration ledger sequence/timestamp has passed. |
| `26` | `BatchTooLarge` | Number of events/notifications in batch operation exceeds batch ceiling. | Split request into smaller batches. |
| `27` | `NotificationRevoked` | Attempted to interact with or acknowledge a revoked notification. | Revoked notifications cannot be acknowledged or modified. |
| `28` | `NotAuthorizedToRevoke` | Caller is not the original publisher or contract owner. | Only original publisher or contract admin can revoke. |
| `29` | `AlreadyRevoked` | Notification has already been marked as revoked. | No action needed; entity is already revoked. |
| `30` | `ZeroAddressTransfer` | Transfer or escrow target address is zero / null. | Provide a valid non-zero Stellar address. |
| `31` | `NoPendingOwnershipTransfer` | `accept_ownership` invoked when no pending transfer exists. | Admin must first call `transfer_ownership` before acceptance. |
| `32` | `NotPendingOwner` | `accept_ownership` invoked by an account other than the nominated owner. | Only the designated pending owner can accept ownership transfer. |
| `33` | `NotAuthorizedToAcknowledge` | Caller is not authorized to acknowledge this notification recipient. | Sign transaction with recipient's authorization. |
| `34` | `InvalidLimit` | Rate limit or pagination limit is invalid or out of bounds. | Provide positive integer within supported bounds (`1..=100`). |
| `35` | `NotificationDelivered` | Attempted recall/modification on an already delivered notification. | Delivered notifications cannot be revoked. |
| `36` | `CategoryNotRegistered` | Specified category ID is not present in category registry. | Register category before assigning notifications. |
| `37` | `TemplateNotFound` | Referenced template ID does not exist in template registry. | Verify template ID or create template prior to referencing. |
| `38` | `TemplateNameTooLong` | Template name string exceeds max byte limit. | Shorten template name. |
| `39` | `TemplateContentEmpty` | Template content payload is empty. | Provide valid template body. |

---

## 3. Handling Contract Errors in Off-Chain Clients

Off-chain clients (e.g. `listener`, `dashboard`) should parse the `InvokeHostFunction` error code from Soroban simulation / transaction submission responses and present human-readable remediation messages as mapped above.
