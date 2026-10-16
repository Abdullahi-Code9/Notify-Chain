# Listener Service API

Base URL: `http://localhost:8787` (configured via `EVENTS_API_PORT`)

Every response carries `X-Request-Id` (a UUID unique to the request) and `X-Correlation-Id` (echo of the caller-supplied `X-Correlation-Id` header, or a server-generated UUID if omitted). Include both when reporting issues.

For a centralized list of API errors, causes, examples, and troubleshooting steps, see [API_ERROR_REFERENCE.md](./API_ERROR_REFERENCE.md).

---

## Table of Contents

1. [Health & Status](#health--status)
2. [Events](#events)
3. [Scheduled Notifications](#scheduled-notifications)
4. [Notification Delivery History](#notification-delivery-history)
5. [Notification Search](#notification-search)
6. [Batch Validation](#batch-validation)
7. [Notification Templates](#notification-templates)
8. [Analytics](#analytics)
9. [User Notification Preferences](#user-notification-preferences)
10. [Webhooks](#webhooks)
11. [Rate Limiting](#rate-limiting)
12. [Error Codes Reference](#error-codes-reference)

---

## Health & Status

### GET /health

Returns the operational status of all service dependencies.

The `uptimeSeconds` field reports the listener process uptime in seconds, measured from process startup.

**Response `200`** — all systems operational (or Discord degraded but Stellar RPC healthy)

```json
{
  "status": "ok",
  "timestamp": "2024-06-20T14:00:00.000Z",
  "uptimeSeconds": 123.45,
  "services": {
    "stellarRpc": { "status": "ok", "latencyMs": 42 },
    "discord": { "status": "ok", "latencyMs": 87 },
    "eventRegistry": { "status": "ok", "eventCount": 128 }
  }
}
```

`status` is `"degraded"` when Discord is unreachable but Stellar RPC is healthy:

```json
{
  "status": "degraded",
  "timestamp": "2024-06-20T14:00:00.000Z",
  "services": {
    "stellarRpc": { "status": "ok", "latencyMs": 38 },
    "discord": { "status": "error", "latencyMs": 5001, "detail": "HTTP 401" },
    "eventRegistry": { "status": "ok", "eventCount": 128 }
  }
}
```

**Response `503`** — Stellar RPC is unreachable

```json
{
  "status": "error",
  "timestamp": "2024-06-20T14:00:00.000Z",
  "services": {
    "stellarRpc": { "status": "error", "latencyMs": 5001, "detail": "Health check timed out" },
    "discord": { "status": "ok", "latencyMs": 65 },
    "eventRegistry": { "status": "ok", "eventCount": 128 }
  }
}
```

**Response `500`** — health check itself threw an unexpected error

```json
{ "status": "error", "detail": "Internal health check failure" }
```

A service entry's `status` can be `"ok"`, `"error"`, or `"not_configured"`. `"not_configured"` means the service URL was not provided at startup and is not checked.

---

### GET /api/status

Returns the pause status of all configured smart contracts.

**Response `200`**

```json
{
  "timestamp": "2024-06-20T14:00:00.000Z",
  "contracts": [
    { "address": "CCEMX6...", "paused": false },
    { "address": "CCEMX7...", "paused": true, "error": "Failed to simulate contract call" }
  ]
}
```

| Field     | Type    | Description                                                        |
|-----------|---------|--------------------------------------------------------------------|
| timestamp | string  | ISO 8601 timestamp of when the status was fetched                  |
| contracts | array   | One entry per configured contract                                  |
| address   | string  | Contract address                                                   |
| paused    | boolean | Whether the contract is currently paused                           |
| error     | string  | Present only when the contract status could not be fetched         |

**Response `500`**

```json
{ "status": "error", "detail": "Internal status check failure" }
```

---

### GET /api/indexing/health

Reports the current indexing lag between the local event registry and the Stellar network tip.

**Response `200`**

```json
{
  "status": "synced",
  "timestamp": "2024-06-20T14:00:00.000Z",
  "indexedLedger": 54321,
  "networkTipLedger": 54321,
  "ledgerLag": 0,
  "processingDelayMs": 850,
  "lastIngestedAt": "2024-06-20T13:59:59.000Z",
  "detail": null
}
```

| Field             | Type          | Description                                                               |
|-------------------|---------------|---------------------------------------------------------------------------|
| status            | string        | `"synced"`, `"syncing"`, or `"degraded"`                                  |
| indexedLedger     | number\|null  | Ledger sequence of the last ingested event                                |
| networkTipLedger  | number\|null  | Latest ledger on the Stellar network                                      |
| ledgerLag         | number\|null  | `networkTipLedger - indexedLedger` (0 = in sync)                         |
| processingDelayMs | number\|null  | Milliseconds since the last event was ingested                            |
| lastIngestedAt    | string\|null  | ISO 8601 timestamp of the last ingested event                             |
| detail            | string\|null  | Human-readable explanation when `status` is not `"synced"`                |

**Status thresholds:**
- `"synced"` — `ledgerLag == 0` and `processingDelayMs <= 60 000`
- `"syncing"` — `ledgerLag <= 5` and `processingDelayMs <= 300 000`
- `"degraded"` — outside the above bounds, or `networkTipLedger` is unavailable

---

### GET /api/notifications/health

Returns the last report produced by the notification health monitor.

**Response `200`**

```json
{
  "status": "healthy",
  "checkedAt": "2024-06-20T14:00:00.000Z",
  "pendingCount": 5,
  "overdueCount": 0,
  "failureRatePercent": 1.2
}
```

**Response `503`** — health monitor not configured or no report produced yet

```json
{ "error": "Health monitor not configured or no report yet" }
```

---

## Events

### GET /api/events

Returns all stored contract events, newest first.

**Query Parameters**

| Name  | Type   | Required | Description                                          |
|-------|--------|----------|------------------------------------------------------|
| limit | number | No       | Maximum number of events to return (default: 20, max: 100) |

**Response `200`**

```json
{
  "count": 42,
  "events": [
    {
      "eventId": "0000000000000000-1",
      "contractAddress": "CCEMX6JKPEUGYAOU4YZP3WBXGPWK7AEFDEDLRXFIDIJPQFMRXTHUVIO",
      "eventName": "autoshare_created",
      "ledger": 12345,
      "type": "contract",
      "topic": ["autoshare_created", "GABC..."],
      "value": "AAAAAQ==",
      "txHash": "abc123...",
      "receivedAt": 1718640000000
    }
  ]
}
```

| Field           | Type          | Description                                              |
|-----------------|---------------|----------------------------------------------------------|
| eventId         | string        | Soroban event ID (`ledger-index` format)                 |
| contractAddress | string        | Contract that emitted the event                          |
| eventName       | string\|null  | Decoded event name (first topic symbol), if decodeable   |
| ledger          | number        | Ledger sequence containing the event                     |
| type            | string        | Always `"contract"` for Soroban events                   |
| topic           | string[]      | Decoded event topics                                     |
| value           | string        | Base64-encoded XDR event data                            |
| txHash          | string        | Transaction hash                                         |
| receivedAt      | number        | Unix timestamp (ms) when the listener received the event |

---

## Scheduled Notifications

Preferences control which notification categories are delivered per user. Categories default to **enabled** when not explicitly set.

### GET /api/preferences/:userId

Returns the notification preferences for a user.

**Path Parameters**

| Name   | Description        |
|--------|--------------------|
| userId | User identifier    |

**Response `200`**

```json
{
  "userId": "alice",
  "categories": {
    "discord": true
  },
  "updatedAt": 1718640000000
}
```

---

### PUT /api/preferences/:userId

Updates one or more notification category flags for a user. Unspecified categories are preserved.

**Path Parameters**

| Name   | Description        |
|--------|--------------------|
| userId | User identifier    |

**Request Body**

```json
{
  "categories": {
    "discord": false
  }
}
```

| Field      | Type                          | Required | Description                              |
|------------|-------------------------------|----------|------------------------------------------|
| categories | `Record<string, boolean>`     | Yes      | Map of category name to enabled flag     |

**Response `200`** — returns the full updated preferences object.

```json
{
  "userId": "alice",
  "categories": {
    "discord": false
  },
  "updatedAt": 1718640100000
}
```

**Response `400`** — returned when the request body is invalid JSON or the `categories` field is missing.

```json
{ "error": "Invalid body: expected { categories: { [key]: boolean } }" }
```

> **Note:** Available notification categories include `discord` and any custom categories defined in your deployment. Categories default to **enabled** when not explicitly set.

> **Per-contract user binding:** To apply a user's preferences to events from a specific contract, set `userId` in the contract address config: `{ "address": "CCEMX6...", "events": ["*"], "userId": "alice" }`. If `userId` is omitted, the `"global"` user's preferences apply.

---

```json
{ "error": "Failed to insert notification into database" }
```

**Response `503`** — scheduler feature is disabled

```json
{ "error": "Scheduler not enabled" }
```

---

### GET /api/schedule/:id

Returns a single scheduled notification by its numeric ID.

**Path Parameters**

| Name | Description              |
|------|--------------------------|
| id   | Notification ID (integer) |

**Response `200`**
> **Payload size limit**: The `payload` object is serialised to JSON before storage. The resulting byte length must not exceed the configured maximum (default **64 KB / 65 536 bytes**). Oversized payloads are rejected with HTTP `413`. Override the limit at runtime with the `MAX_PAYLOAD_SIZE_BYTES` environment variable.

**Request Body**

```json
{
  "id": 42,
  "executeAt": "2024-06-20T15:00:00.000Z",
  "payload": { "content": "Your task was completed." },
  "targetRecipient": "https://discord.com/api/webhooks/...",
  "notificationType": "discord",
  "status": "pending",
  "retries": 0,
  "maxRetries": 3,
  "priority": 1,
  "eventId": "abc123",
  "contractAddress": "CCEMX6...",
  "metadata": null,
  "createdAt": 1718640000000
}
```

**Response `400`** — non-numeric `:id`
| Field             | Type     | Required | Description                                              |
|-------------------|----------|----------|----------------------------------------------------------|
| executeAt         | string   | Yes      | ISO 8601 datetime — when to deliver the notification     |
| payload           | object   | Yes      | Arbitrary data forwarded to the notification handler. Serialised JSON must not exceed `MAX_PAYLOAD_SIZE_BYTES` (default 64 KB). |
| targetRecipient   | string   | Yes      | Delivery target (e.g. Discord webhook URL)               |
| notificationType  | string   | No       | `"discord"` (default)                                    |
| maxRetries        | number   | No       | Override max retry count                                 |
| priority          | number   | No       | Lower numbers run first                                  |
| eventId           | string   | No       | Correlation ID linking this to a contract event          |
| contractAddress   | string   | No       | Contract that triggered the notification                 |
| metadata          | object   | No       | Arbitrary key/value metadata                             |

**Response `201`**

```json
{ "id": 42 }
```

**Response `400`** — missing required fields

```json
{ "error": "Invalid notification ID" }
```

**Response `404`** — no notification with that ID

```json
{ "error": "Notification not found" }
```

**Response `500`** — database read failure
**Response `413`** — payload exceeds the maximum allowed size

```json
{ "error": "Notification payload is too large: 70000 bytes exceeds the 65536-byte limit. Reduce the payload size and retry." }
```

**Response `500`** — internal scheduling failure

```json
{ "error": "SQLITE_ERROR: ..." }
```

**Response `503`** — scheduler feature is disabled

```json
{ "error": "Scheduler not enabled" }
```

---

### GET /api/schedule/stats

Returns aggregate statistics about the scheduled-notification queue.

**Response `200`**

```json
{
  "pending": 15,
  "processing": 3,
  "completed": 1234,
  "failed": 45,
  "overdue": 2
}
```

| Field      | Type   | Description                                                  |
|------------|--------|--------------------------------------------------------------|
| pending    | number | Notifications waiting to be processed                        |
| processing | number | Notifications currently being processed                      |
| completed  | number | Successfully delivered notifications                         |
| failed     | number | Notifications that permanently failed after exhausting retries |
| overdue    | number | Pending notifications that are past their `executeAt` time   |

**Response `500`** — database read failure

```json
{ "error": "SQLITE_ERROR: ..." }
```

**Response `503`** — scheduler feature is disabled

```json
{ "error": "Scheduler not enabled" }
```

---

### GET /api/schedule/execution-metrics

Returns deduplicated delivery performance metrics. Each notification is counted exactly once regardless of how many retry attempts it took, preventing double-counting.

**Response `200`**

```json
{
  "totalNotifications": 100,
  "successfulFirstAttempt": 70,
  "successfulAfterRetry": 20,
  "permanentFailures": 10,
  "totalRetryAttempts": 35,
  "averageRetriesPerNotification": 0.35,
  "averageSuccessDurationMs": 845.5,
  "averageFailureDurationMs": 2341.2
}
```

| Field                        | Type   | Description                                                                    |
|------------------------------|--------|--------------------------------------------------------------------------------|
| totalNotifications           | number | Completed or permanently failed notifications (one count per notification ID)  |
| successfulFirstAttempt       | number | Delivered successfully on the first attempt (zero retries)                     |
| successfulAfterRetry         | number | Delivered successfully after one or more retries                               |
| permanentFailures            | number | Failed permanently after exhausting all retries                                |
| totalRetryAttempts           | number | Sum of retry counts across all notifications                                   |
| averageRetriesPerNotification| number | `totalRetryAttempts / totalNotifications`                                      |
| averageSuccessDurationMs     | number | Average duration (ms) of the final successful delivery attempt                 |
| averageFailureDurationMs     | number | Average duration (ms) of the final failed delivery attempt                     |

**Computing success rate:**
```javascript
const successRate =
  (metrics.successfulFirstAttempt + metrics.successfulAfterRetry) /
  metrics.totalNotifications;
// Example: (70 + 20) / 100 = 0.90
```

**Response `500`** — database read failure

```json
{ "error": "SQLITE_ERROR: ..." }
```

**Response `503`** — scheduler feature is disabled

```json
{ "error": "Scheduler not enabled" }
```

---

### GET /api/schedule/retry-distribution

Returns a breakdown of final outcomes grouped by retry count. Useful for tuning retry policies.

**Response `200`**

```json
[
  { "retryCount": 0, "successCount": 70, "failureCount": 0 },
  { "retryCount": 1, "successCount": 15, "failureCount": 2 },
  { "retryCount": 2, "successCount": 5,  "failureCount": 3 },
  { "retryCount": 3, "successCount": 0,  "failureCount": 5 }
]
```

| Field        | Type   | Description                                                  |
|--------------|--------|--------------------------------------------------------------|
| retryCount   | number | Number of retries before the final outcome                   |
| successCount | number | Notifications that succeeded after exactly `retryCount` retries |
| failureCount | number | Notifications that failed after exactly `retryCount` retries |

**Response `500`** — database read failure

```json
{ "error": "SQLITE_ERROR: ..." }
```

**Response `503`** — scheduler feature is disabled

```json
{ "error": "Scheduler not enabled" }
```

---

## Notification Delivery History

### GET /api/notifications/history

Returns paginated delivery execution records from `notification_execution_log`.

**Query Parameters**

| Name      | Type   | Required | Description                                                       |
|-----------|--------|----------|-------------------------------------------------------------------|
| limit     | number | No       | Maximum records per page (default `20`, max `100`)                |
| offset    | number | No       | Number of records to skip (default `0`). Prefer `cursor`.         |
| cursor    | string | No       | Opaque token for cursor-based pagination                          |
| status    | string | No       | Filter by execution status: `SUCCESS`, `FAILED`, or `RETRY`       |
| startDate | string | No       | ISO 8601 lower bound on `execution_time` (inclusive)              |
| endDate   | string | No       | ISO 8601 upper bound on `execution_time` (inclusive)              |

**Response `200`**

```json
{
  "records": [
    {
      "id": 1,
      "scheduledNotificationId": 42,
      "executionAttempt": 1,
      "executionTime": "2024-06-20T15:00:00.000Z",
      "status": "SUCCESS",
      "errorMessage": null,
      "responseDuration": 120
    }
  ],
  "total": 5,
  "itemCount": 5,
  "totalPages": 3,
  "limit": 2,
  "offset": 0,
  "nextCursor": "MjAyNC0wNi0yMFQxNTowMDowMC4wMDBaLDQy"
}
```

| Field       | Type   | Description                                                                 |
|-------------|--------|-----------------------------------------------------------------------------|
| records     | array  | Execution log entries for the current page                                  |
| total       | number | Total matching records (preserved for backward compatibility; same value as `itemCount`) |
| itemCount   | number | Total number of records matching the query filters                          |
| totalPages  | number | Total pages available at the requested `limit` (`0` when `itemCount` is `0`) |
| limit       | number | Effective page size applied to the query                                    |
| offset      | number | Number of records skipped before this page                                  |
| nextCursor  | string | Opaque token to fetch the next page of results                              |

Existing clients that read `total`, `limit`, `offset`, and `records` continue to work unchanged. New clients should prefer `itemCount` and `totalPages` for pagination UI.

**Response `500`** — database read failure

```json
{ "error": "SQLITE_ERROR: ..." }
```

---

## Notification Search

### GET /api/notifications/search

Full-text and field-based search across scheduled notifications.

**Query Parameters**

| Name     | Type   | Required | Description                                                       |
|----------|--------|----------|-------------------------------------------------------------------|
| q        | string | No       | Free-text search across payload, metadata, and recipient fields   |
| sender   | string | No       | Filter by sender address or identifier                            |
| txHash   | string | No       | Filter by originating transaction hash                            |
| eventId  | string | No       | Filter by correlated contract event ID                            |
| status   | string | No       | Filter by status: `PENDING`, `PROCESSING`, `COMPLETED`, `FAILED`, `CANCELLED` |
| type     | string | No       | Filter by notification type: `discord`, `email`, `webhook`, `sms` |
| limit    | number | No       | Maximum results to return (default: 20)                           |
| offset   | number | No       | Number of results to skip (default: 0)                            |

**Response `200`**

```json
{
  "results": [
    {
      "id": 42,
      "payload": { "content": "Your task completed." },
      "notificationType": "discord",
      "targetRecipient": "https://discord.com/api/webhooks/...",
      "executeAt": "2024-06-20T15:00:00.000Z",
      "status": "COMPLETED",
      "eventId": "abc123",
      "contractAddress": "CCEMX6...",
      "createdAt": "2024-06-20T14:00:00.000Z"
    }
  ],
  "total": 150,
  "limit": 20,
  "offset": 0
}
```

**Response `500`**

```json
{ "error": "..." }
```

---

### POST /api/notifications/:id/cancel

Cancel a pending scheduled notification. An optional `reason` may be supplied for auditing.

**Path Parameters**

| Name | Type   | Required | Description                              |
|------|--------|----------|------------------------------------------|
| id   | number | Yes      | Numeric identifier of the notification   |

**Request Body** (optional)

```json
{
  "reason": "Duplicate request"
}
```

**Response `200`**

Returns the full `ScheduledNotification` object, now including `cancellationReason` if provided.

---

### GET /api/search/suggestions

Returns autocomplete suggestions based on a partial query string. Useful for building search UIs.

**Query Parameters**

| Name  | Type   | Required | Description                                      |
|-------|--------|----------|--------------------------------------------------|
| q     | string | Yes      | Partial search string (minimum 1 character)      |
| limit | number | No       | Maximum suggestions to return (default: 10)      |

**Response `200`**

```json
{
  "suggestions": [
    "task_completed",
    "task_created",
    "transfer_complete"
  ]
}
```

**Response `500`**

```json
{ "error": "..." }
```

---

## Batch Validation

### POST /api/notifications/validate-batch

Validates a batch of notification objects without persisting them. Useful for pre-flight checks before bulk scheduling.

**Request Body**

Accepts either a JSON array of notification objects directly, or a wrapper object:

```json
[
  {
    "payload": { "content": "Message 1" },
    "targetRecipient": "https://discord.com/api/webhooks/...",
    "executeAt": "2024-06-20T15:00:00.000Z",
    "notificationType": "discord"
  },
  {
    "payload": { "content": "Message 2" },
    "targetRecipient": "https://discord.com/api/webhooks/...",
    "executeAt": "invalid-date"
  }
]
```

Or with a wrapper key:

```json
{
  "notifications": [ ... ]
}
```

**Response `200`** — all items passed validation

```json
{
  "valid": true,
  "processedCount": 2,
  "errors": []
}
```

**Response `400`** — one or more items failed validation

```json
{
  "valid": false,
  "processedCount": 2,
  "errors": [
    {
      "index": 1,
      "code": "INVALID_DATE",
      "message": "executeAt is not a valid ISO 8601 date"
    }
  ]
}
```

| Field          | Type    | Description                                                            |
|----------------|---------|------------------------------------------------------------------------|
| valid          | boolean | `true` only when zero validation errors were found                     |
| processedCount | number  | Total items evaluated                                                  |
| errors         | array   | One entry per failed item; empty array when `valid` is `true`          |
| errors[].index | number  | Zero-based position of the failing item in the input array (`-1` for parse errors) |
| errors[].code  | string  | Machine-readable error code (e.g. `INVALID_DATE`, `MISSING_FIELD`, `PARSE_ERROR`) |
| errors[].message | string | Human-readable description                                           |

**Response `400`** — request body is not valid JSON

```json
{
  "valid": false,
  "processedCount": 0,
  "errors": [{ "index": -1, "code": "PARSE_ERROR", "message": "Request body must be valid JSON." }]
}
```

---

## Notification Templates

Templates allow reusable message bodies with variable substitution. The template service must be enabled at startup; all template endpoints return `503` when it is not.

### GET /api/templates

Lists all templates, with optional filtering.

**Query Parameters**

| Name        | Type    | Required | Description                                     |
|-------------|---------|----------|-------------------------------------------------|
| channelType | string  | No       | Filter by channel type (e.g. `"discord"`, `"email"`) |
| activeOnly  | boolean | No       | When `true`, return only active templates       |

**Response `200`**

```json
{
  "count": 3,
  "templates": [
    {
      "id": 1,
      "uniqueKey": "task-completed",
      "name": "Task Completed",
      "description": "Sent when a task bounty is completed.",
      "channelType": "discord",
      "subjectTemplate": null,
      "bodyTemplate": "Task {{taskId}} has been completed by {{contributor}}.",
      "variables": ["taskId", "contributor"],
      "defaultValues": {},
      "isActive": true,
      "createdBy": "admin",
      "createdAt": "2024-06-01T00:00:00.000Z",
      "updatedAt": "2024-06-01T00:00:00.000Z"
    }
  ]
}
```

---

### POST /api/templates

Creates a new notification template.

**Request Body**

```json
{
  "uniqueKey": "task-completed",
  "name": "Task Completed",
  "description": "Sent when a task bounty is completed.",
  "channelType": "discord",
  "bodyTemplate": "Task {{taskId}} has been completed by {{contributor}}.",
  "subjectTemplate": null,
  "variables": ["taskId", "contributor"],
  "defaultValues": {},
  "createdBy": "admin"
}
```

| Field           | Type     | Required | Description                                              |
|-----------------|----------|----------|----------------------------------------------------------|
| uniqueKey       | string   | Yes      | URL-safe unique identifier for this template             |
| name            | string   | Yes      | Human-readable display name                              |
| channelType     | string   | Yes      | Target channel: `"discord"`, `"email"`, `"webhook"`, `"sms"` |
| bodyTemplate    | string   | Yes      | Handlebars-style template body with `{{variable}}` placeholders |
| description     | string   | No       | Optional description                                     |
| subjectTemplate | string   | No       | Subject line template (relevant for email)               |
| variables       | string[] | No       | List of variable names used in the template              |
| defaultValues   | object   | No       | Default values for variables                             |
| createdBy       | string   | No       | Identifier of the user creating the template             |

**Response `201`**

```json
{ "id": 1, "uniqueKey": "task-completed" }
```

**Response `400`** — missing required fields

```json
{ "error": "Missing required fields", "required": ["uniqueKey", "name", "channelType", "bodyTemplate"] }
```

**Response `409`** — `uniqueKey` already exists

```json
{ "error": "Template with this unique key already exists" }
```

---

### GET /api/templates/:id

Returns a template by its numeric ID.

**Path Parameters**

| Name | Description          |
|------|----------------------|
| id   | Template ID (integer) |

**Response `200`** — template object (same shape as items in the list response)

**Response `400`** — non-numeric `:id`

```json
{ "error": "Invalid template ID" }
```

**Response `404`**

```json
{ "error": "Template not found" }
```

---

### GET /api/templates/by-key/:uniqueKey

Returns a template by its `uniqueKey`.

**Path Parameters**

| Name      | Description              |
|-----------|--------------------------|
| uniqueKey | The template's unique key |

**Response `200`** — template object

**Response `404`**

```json
{ "error": "Template not found" }
```

---

### PUT /api/templates/:id

Updates an existing template. Only the supplied fields are changed.

**Path Parameters**

| Name | Description          |
|------|----------------------|
| id   | Template ID (integer) |

**Request Body** — any subset of the template fields:

```json
{
  "bodyTemplate": "Task {{taskId}} was completed. Reward: {{reward}} XLM.",
  "variables": ["taskId", "reward"]
}
```

**Response `200`**

```json
{ "id": 1, "message": "Template updated successfully" }
```

**Response `404`**

```json
{ "error": "Template not found" }
```

---

### DELETE /api/templates/:id

Deactivates a template (soft-delete by default). Pass `?hard=true` to permanently delete.

**Path Parameters**

| Name | Description          |
|------|----------------------|
| id   | Template ID (integer) |

**Query Parameters**

| Name | Type    | Required | Description                                            |
|------|---------|----------|--------------------------------------------------------|
| hard | boolean | No       | When `true`, permanently deletes the template record   |

**Response `200`**

```json
{ "id": 1, "message": "Template deactivated" }
```

Or when `hard=true`:

```json
{ "id": 1, "message": "Template deleted permanently" }
```

**Response `404`**

```json
{ "error": "Template not found" }
```

---

### POST /api/templates/render

Renders a template by substituting variables with provided context values.

**Request Body**

```json
{
  "templateId": 1,
  "context": {
    "taskId": "TASK-99",
    "contributor": "GABC1234...XYZ"
  }
}
```

| Field      | Type   | Required | Description                                                    |
|------------|--------|----------|----------------------------------------------------------------|
| templateId | number | No*      | Template ID. Provide either `templateId` or `uniqueKey`.       |
| uniqueKey  | string | No*      | Template unique key. Provide either `templateId` or `uniqueKey`. |
| context    | object | Yes      | Key-value map of variable names to substitution values         |

\* One of `templateId` or `uniqueKey` is required.

**Response `200`**

```json
{
  "subject": null,
  "body": "Task TASK-99 has been completed by GABC1234...XYZ."
}
```

**Response `400`** — missing required fields

```json
{ "error": "Missing required fields", "required": ["templateId OR uniqueKey", "context"] }
```

**Response `404`**

```json
{ "error": "Template not found" }
```

---

### GET /api/templates/stats

Returns usage statistics for all templates, or for a specific template.

**Query Parameters**

| Name       | Type   | Required | Description                         |
|------------|--------|----------|-------------------------------------|
| templateId | number | No       | Limit stats to a specific template  |

**Response `200`**

```json
{
  "totalTemplates": 5,
  "activeTemplates": 4,
  "renderCount": 1234,
  "byTemplate": [
    { "id": 1, "uniqueKey": "task-completed", "renderCount": 800, "lastRenderedAt": "2024-06-20T14:00:00.000Z" }
  ]
}
```

---

### GET /api/templates/:id/audit

Returns the full audit history for a specific template (create, update, delete events).

**Path Parameters**

| Name | Description          |
|------|----------------------|
| id   | Template ID or unique key |

**Response `200`**

```json
{
  "templateId": "task-completed",
  "records": [
    {
      "action": "created",
      "actor": "admin",
      "timestamp": "2024-06-01T00:00:00.000Z",
      "changes": {}
    },
    {
      "action": "updated",
      "actor": "admin",
      "timestamp": "2024-06-10T12:00:00.000Z",
      "changes": { "bodyTemplate": "..." }
    }
  ]
}
```

**Response `404`**

```json
{ "error": "Template not found" }
```

---

## Analytics

### GET /api/analytics

Returns a real-time aggregated snapshot of notification delivery metrics. Pass `?reset=true` to atomically read and reset the counters.

**Query Parameters**

| Name  | Type    | Required | Description                                          |
|-------|---------|----------|------------------------------------------------------|
| reset | boolean | No       | If `true`, resets the aggregator after reading       |

**Response `200`**

```json
{
  "totalRecorded": 1500,
  "successCount": 1350,
  "failureCount": 100,
  "retryCount": 50,
  "byType": {
    "discord": { "success": 900, "failure": 60 },
    "email":   { "success": 450, "failure": 40 }
  },
  "buckets": [
    { "startMs": 1718640000000, "endMs": 1718640060000, "count": 25 }
  ]
}
```

**Response `503`** — analytics aggregator not available

```json
{ "error": "Analytics aggregator unavailable" }
```

---

### GET /api/analytics/history

Returns historical analytics snapshots persisted by the metrics store. Supports time-range filtering.

**Query Parameters**

| Name  | Type   | Required | Description                                                   |
|-------|--------|----------|---------------------------------------------------------------|
| limit | number | No       | Maximum snapshots to return (default: 50, max: 100)           |
| since | string | No       | ISO 8601 lower bound — return only snapshots after this time  |

**Response `200`**

```json
{
  "snapshots": [
    {
      "capturedAt": "2024-06-20T14:00:00.000Z",
      "totalRecorded": 1500,
      "successCount": 1350,
      "failureCount": 100
    }
  ]
}
```

**Response `503`** — metrics store not configured

```json
{ "error": "Metrics history store unavailable" }
```

---

## User Notification Preferences

### POST /api/webhooks

Receives a signed webhook event payload. The request must carry a valid HMAC-SHA256 signature produced with a pre-shared secret.

**Required Headers**

| Header            | Description                                      |
|-------------------|--------------------------------------------------|
| `X-Signature`     | HMAC-SHA256 hex digest of the raw request body   |
| `X-Key-Id`        | Identifier selecting which secret to verify with |

**Response `202`**

```json
{ "status": "accepted" }
```

**Response `400`** — request body could not be read

```json
{ "error": "Failed to read request body" }
```

**Response `401`** — `X-Signature` header absent

```json
{ "error": "Missing signature header" }
```

**Response `401`** — `X-Key-Id` header absent

```json
{ "error": "Missing key-id header" }
```

**Response `401`** — `X-Key-Id` value does not match any registered secret

```json
{ "error": "Unknown key-id" }
```

**Response `401`** — signature does not match the computed HMAC

```json
{ "error": "Invalid signature" }
```

---

## Rate Limiting

The API enforces configurable rate limits to protect against abuse. Limits can be set globally or per-client using API keys or IP addresses.

### Rate Limit Headers

All responses include these headers when rate limiting is enabled:

| Header                  | Description                                              |
|-------------------------|----------------------------------------------------------|
| `X-RateLimit-Limit`     | Maximum requests allowed in the current window           |
| `X-RateLimit-Remaining` | Requests remaining before hitting the limit              |
| `X-RateLimit-Reset`     | Unix timestamp (seconds) when the window resets          |

When a rate limit is exceeded:

| Header        | Description                                     |
|---------------|-------------------------------------------------|
| `Retry-After` | Seconds to wait before retrying the request     |

### GET /api/rate-limit/metrics

Returns real-time rate limiting statistics for monitoring and analysis.

**Query Parameters**

| Name  | Type    | Required | Description                                      |
|-------|---------|----------|--------------------------------------------------|
| reset | boolean | No       | If `true`, resets metrics after reading them     |

**Response `200`**

```json
{
  "totalRequests": 1543,
  "blockedRequests": 87,
  "allowedRequests": 1456,
  "uniqueClients": 23,
  "topBlockedClients": [
    {
      "clientId": "192.168.1.100",
      "blockCount": 45
    },
    {
      "clientId": "sk_live_...",
      "blockCount": 23
    }
  ],
  "startTime": "2024-01-01T12:00:00.000Z"
}
```

| Field              | Type   | Description                                                  |
|--------------------|--------|--------------------------------------------------------------|
| totalRequests      | number | Total requests processed since server start or last reset    |
| blockedRequests    | number | Requests that were rate limited                              |
| allowedRequests    | number | Requests that were allowed through                           |
| uniqueClients      | number | Number of distinct clients currently tracked                 |
| topBlockedClients  | array  | Top 10 clients by block count (API keys are masked)          |
| startTime          | string | ISO 8601 timestamp when metrics tracking started             |

**Response `503`** — rate limiting is disabled

```json
{ "error": "Rate limiting not enabled" }
```

**Example — fetch metrics**

```http
GET /api/rate-limit/metrics HTTP/1.1
```

```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "totalRequests": 1543,
  "blockedRequests": 87,
  "allowedRequests": 1456,
  "uniqueClients": 23,
  "topBlockedClients": [
    { "clientId": "192.168.1.100", "blockCount": 45 }
  ],
  "startTime": "2024-01-01T12:00:00.000Z"
}
```

**Example — fetch and reset metrics**

```http
GET /api/rate-limit/metrics?reset=true HTTP/1.1
```

```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "totalRequests": 1543,
  "blockedRequests": 87,
  "allowedRequests": 1456,
  "uniqueClients": 23,
  "topBlockedClients": [],
  "startTime": "2024-01-01T12:00:00.000Z"
}
```

---

## Webhooks
## Health

### GET /health

Returns the operational status of all service dependencies.

**Response `200`** — all systems operational or non-critical services degraded

```json
{
  "status": "ok",
  "timestamp": "2024-06-20T14:00:00.000Z",
  "services": {
    "stellarRpc": { "status": "ok", "latencyMs": 42 },
    "discord": { "status": "ok", "latencyMs": 87 },
    "database": { "status": "ok", "latencyMs": 3 },
    "eventRegistry": { "status": "ok", "eventCount": 128 }
  }
}
```

`status` is `"degraded"` when Discord is unreachable but Stellar RPC and the database are healthy:

```json
{
  "status": "degraded",
  "timestamp": "2024-06-20T14:00:00.000Z",
  "services": {
    "stellarRpc": { "status": "ok", "latencyMs": 38 },
    "discord": { "status": "error", "latencyMs": 5001, "detail": "HTTP 401" },
    "database": { "status": "ok", "latencyMs": 2 },
    "eventRegistry": { "status": "ok", "eventCount": 128 }
  }
}
```

**Response `503`** — Stellar RPC or the SQLite database is unreachable

```json
{
  "status": "error",
  "timestamp": "2024-06-20T14:00:00.000Z",
  "services": {
    "stellarRpc": { "status": "error", "latencyMs": 5001, "detail": "Health check timed out" },
    "discord": { "status": "ok", "latencyMs": 65 },
    "database": { "status": "ok", "latencyMs": 2 },
    "eventRegistry": { "status": "ok", "eventCount": 128 }
  }
}
```

**Response `500`** — health check itself threw an unexpected error

```json
{ "status": "error", "detail": "Internal health check failure" }
```

A service entry's `status` field can be `"ok"`, `"error"`, or `"not_configured"`. `"not_configured"` means the service URL was not provided at startup and is not checked.

---

## Contract Status

### GET /api/status

Returns the pause status of all configured smart contracts.

**Response `200`**

```json
{
  "timestamp": "2024-06-20T14:00:00.000Z",
  "contracts": [
    {
      "address": "CCEMX6...",
      "paused": false
    },
    {
      "address": "CCEMX7...",
      "paused": true,
      "error": "Failed to simulate contract call"
    }
  ]
}
```

| Field       | Type     | Description                                                                 |
|-------------|----------|-----------------------------------------------------------------------------|
| timestamp   | string   | ISO 8601 timestamp of when the status was fetched                          |
| contracts   | array    | List of contracts and their statuses                                             |
| address     | string   | Contract address                                                            |
| paused      | boolean  | Whether the contract is currently paused                                   |
| error       | string   | Optional. Error message if we could not fetch the status for this contract   |

**Response `500`** — internal error fetching status

```json
{ "status": "error", "detail": "Internal status check failure" }
```

---

## Error Codes Reference

Every error response is a JSON object. All errors carry an `error` string. Rate-limit responses also include a `message` field; health-check failures use `detail` instead.

```json
{ "error": "Human-readable description of what went wrong" }
```

Every response — success or error — includes the following tracing headers:

| Header            | Description                                    |
|-------------------|------------------------------------------------|
| `X-Request-Id`    | Unique ID generated for this request           |
| `X-Correlation-Id`| Caller-supplied or server-generated trace ID   |

---

### Status Code Table

| HTTP Code | Name                  | When it occurs                                                    | Client action                                                            |
|-----------|-----------------------|-------------------------------------------------------------------|--------------------------------------------------------------------------|
| 200       | OK                    | Request succeeded; body contains the result                       | Consume response body                                                    |
| 201       | Created               | Resource created (scheduled notification)                         | Persist the returned `id` for future lookups                             |
| 202       | Accepted              | Webhook accepted for processing                                   | No further action needed                                                 |
| 204       | No Content            | CORS preflight (`OPTIONS`) succeeded                              | Browser handles automatically                                            |
| 400       | Bad Request           | Client sent invalid input — see error message for the specific field | Fix the request body or parameters before retrying                    |
| 401       | Unauthorized          | Webhook signature is missing, unrecognised, or invalid            | Verify the signing secret and key ID; regenerate the HMAC               |
| 404       | Not Found             | Route or resource does not exist                                  | Check the URL and resource ID                                            |
| 429       | Too Many Requests     | Client exceeded its rate limit for the current window             | Wait `Retry-After` seconds before sending the next request              |
| 500       | Internal Server Error | Unhandled server-side failure                                     | Retry with exponential backoff; report if persistent                     |
| 503       | Service Unavailable   | Scheduler is disabled, or Stellar RPC is unreachable             | Check server configuration or wait for dependency to recover             |

---

### 400 Bad Request

The request was rejected because client-supplied data failed validation.

| Error message | Endpoint | Cause | Fix |
|---|---|---|---|
| `"Invalid body: expected { categories: { [key]: boolean } }"` | `PUT /api/preferences/:userId` | Body is valid JSON but `categories` field is absent or not an object | Send `{ "categories": { "discord": true } }` |
| `"Invalid JSON"` | `PUT /api/preferences/:userId` | Body is not parseable JSON | Ensure `Content-Type: application/json` and well-formed JSON |
| `"Missing required fields: executeAt, payload, targetRecipient"` | `POST /api/schedule` | One or more of the three required fields is absent | Include all three fields in the request body |
| `"executeAt is not a valid date"` | `POST /api/schedule` | `executeAt` string cannot be parsed as a JavaScript `Date` | Use a valid ISO 8601 string, e.g. `"2024-06-20T15:00:00.000Z"` |
| `"Invalid notification ID"` | `GET /api/schedule/:id` | `:id` path segment is not a valid integer | Use a numeric ID returned by `POST /api/schedule` |
| `"Failed to read request body"` | `POST /api/webhooks` | The connection was dropped while reading the body | Resend the request with the full body intact |

**Example — missing schedule fields**

```http
POST /api/schedule HTTP/1.1
Content-Type: application/json

{ "payload": { "content": "hello" } }
```

```http
HTTP/1.1 400 Bad Request
Content-Type: application/json
X-Request-Id: f3a2c1b0-...

{ "error": "Missing required fields: executeAt, payload, targetRecipient" }
```

---

### 401 Unauthorized

All `401` errors come from the `POST /api/webhooks` endpoint when signature verification fails. The request must carry both `X-Signature` and `X-Key-Id` headers.

| Error message | Cause | Fix |
|---|---|---|
| `"Missing signature header"` | `X-Signature` header is absent | Add the header with an HMAC-SHA256 hex digest of the raw request body |
| `"Missing key-id header"` | `X-Key-Id` header is absent | Add the header with the ID of the signing key used |
| `"Unknown key-id"` | The `X-Key-Id` value does not match any key registered with the server | Use a key ID that the server was started with |
| `"Invalid signature"` | The signature does not match the server's HMAC computation | Re-sign the raw body bytes with the correct secret; ensure no encoding transformation is applied to the body in transit |

**Example — wrong secret**

```http
POST /api/webhooks HTTP/1.1
X-Signature: aabbccdd...
X-Key-Id: key-prod-1
Content-Type: application/json

{ "event": "TaskCreated", "contractAddress": "CCEMX6..." }
```

```http
HTTP/1.1 401 Unauthorized
Content-Type: application/json
X-Request-Id: d9e1f2a3-...

{ "error": "Invalid signature" }
```

---

### 404 Not Found

| Error message | When | Fix |
|---|---|---|
| `"Not found"` | The request path does not match any known route | Check the URL against this document |
| `"Notification not found"` | `GET /api/schedule/:id` — no notification exists with the given ID | Verify the ID was returned by `POST /api/schedule` and has not been purged |

---

### 429 Too Many Requests

Returned by the rate limiter when a client exceeds the configured request quota within the sliding window.

The response always includes `error` and `message`. Response headers tell the client exactly when to retry.

**Response headers**

| Header              | Description                                                    |
|---------------------|----------------------------------------------------------------|
| `X-RateLimit-Limit` | Maximum requests allowed in the current window                 |
| `X-RateLimit-Remaining` | Requests still available (0 when limited)                  |
| `X-RateLimit-Reset` | Unix timestamp (seconds) when the oldest slot leaves the window |
| `Retry-After`       | Seconds to wait before the next request will be accepted       |

**Client identification** — the limiter tracks clients by API key first, then by IP address:

1. `X-API-Key` header value
2. `Authorization: Bearer <token>` token
3. `X-Forwarded-For` first IP
4. TCP remote address

**Example**

```http
GET /api/events HTTP/1.1
X-API-Key: my-key

```

```http
HTTP/1.1 429 Too Many Requests
Content-Type: application/json
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 0
X-RateLimit-Reset: 1718640060
Retry-After: 12
X-Request-Id: 8b4c3d2e-...

{
  "error": "Too Many Requests",
  "message": "Rate limit exceeded. Try again in 12 seconds."
}
```

Rate limit violations are recorded in the SQLite database for audit purposes.

---

### 500 Internal Server Error

Returned when the server encounters an unexpected failure. The `error` field contains the original exception message.

| Endpoint | Likely cause |
|---|---|
| `POST /api/schedule` | Database write failure; SQLite locked or corrupt |
| `GET /api/schedule/:id` | Database read failure |
| `GET /api/schedule/stats` | Database read failure |
| `GET /health` | Unexpected exception in the health check loop |

**Example**

```http
HTTP/1.1 500 Internal Server Error
Content-Type: application/json
X-Request-Id: 1c2d3e4f-...

{ "error": "SQLITE_BUSY: database is locked" }
```

Retry with exponential backoff. If the error persists, inspect the server logs using the `X-Request-Id` from the response to find the full stack trace.

The `/health` endpoint returns a distinct shape on its own internal failure:

```json
{ "status": "error", "detail": "Internal health check failure" }
```

---

### 503 Service Unavailable

Returned in two distinct situations.

**Scheduler disabled**

`POST /api/schedule`, `GET /api/schedule/:id`, and `GET /api/schedule/stats` all return `503` when the scheduler was not enabled at startup (i.e. the `notificationAPI` option was not provided).

```json
{ "error": "Scheduler not enabled" }
```

This is a configuration issue, not a transient failure. Retrying will not help until the service is restarted with the scheduler enabled.

**Stellar RPC unreachable**

`GET /health` returns `503` when the Stellar RPC node cannot be reached or times out (5-second timeout). The body is the full health object with `"status": "error"`:

```json
{
  "status": "error",
  "timestamp": "2024-06-20T14:00:00.000Z",
  "services": {
    "stellarRpc": {
      "status": "error",
      "latencyMs": 5001,
      "detail": "Health check timed out"
    },
    "discord": { "status": "ok", "latencyMs": 54 },
    "eventRegistry": { "status": "ok", "eventCount": 200 }
  }
}
```

Wait for the upstream Stellar RPC node to recover, or point `STELLAR_RPC_URL` at a healthy node and restart the service.

---

### Diagnosing errors with request IDs

Every response carries `X-Request-Id` (a UUID unique to that request) and `X-Correlation-Id` (a caller-supplied or server-generated trace ID). Include both values when reporting issues.

Server-side logs are keyed on the same IDs:

```
[WARN]  requestId=8b4c3d2e correlationId=front-42 Webhook missing signature header
[ERROR] requestId=1c2d3e4f correlationId=front-43 Failed to schedule notification { error: "SQLITE_BUSY" }
```

To propagate a trace ID from your own service, send `X-Correlation-Id` in the request. The server echoes it back in the response header.
