# 📮 Dead-Letter Isolation & Operator Remediation

This document details the Dead Letter Queue (DLQ) isolation and remediation architecture for NotifyChain (Issue #706).

---

## 1. Overview & Non-blocking Guarantee

When a notification fails delivery and exhausts its maximum retry quota, it is immediately moved out of the active dispatch loop into the DLQ. This prevents poison-pill payloads or persistently failing endpoints from causing head-of-line blocking for other notifications.

---

## 2. DLQ Record Schema

| Field | Type | Description |
|---|---|---|
| `dlqId` | `string` | Unique identifier (`dlq-uuid`) |
| `originalNotificationId` | `string` | Foreign key linking to the source notification |
| `provider` | `string` | Target transport (e.g. `Discord`, `Webhook`) |
| `targetRecipientSanitized` | `string` | Redacted recipient URL/address |
| `failureReason` | `string` | Sanitized error message |
| `errorStack` | `string` | Redacted error stack trace |
| `retryAttempts` | `number` | Total number of attempts executed before isolation |
| `status` | `string` | `isolated` \| `requeued` \| `discarded` |

---

## 3. Operator Remediation

* **Inspection**: Query dead-lettered entries via `listDeadLetters()`.
* **Requeueing**: Re-inject isolated payloads back into the dispatch loop via `requeue(dlqId)`.
* **Discarding**: Mark permanently invalid webhooks as discarded via `discard(dlqId)`.
