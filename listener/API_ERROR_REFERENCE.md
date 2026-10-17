# Notification API Error Reference

This reference lists listener API error responses, common causes, and operator or client actions.

## Standard Error Envelope (#987)

Errors produced through the shared response helpers use this envelope:

```json
{
  "success": false,
  "error": {
    "code": "INVALID_PERMISSIONS",
    "message": "The provided credentials lack the necessary scope for this action.",
    "details": [],
    "correlation_id": "req-12345"
  }
}
```

| Field | Type | Notes |
|-------|------|-------|
| `code` | string | Stable machine-readable code from the table below. **Branch on this, not on `message`.** |
| `message` | string | Human-readable; wording may change between releases. |
| `details` | array \| object | Validation issues or extra context. `[]` when there is nothing to add. |
| `correlation_id` | string | Same value as the `X-Correlation-Id` response header. Quote it when reporting problems. |

### Error Codes

Codes are never renamed or reused once published. The source of truth is
`src/errors/api-error-codes.ts` (`ERROR_CODE_CATALOG`).

| Code | HTTP | Meaning |
|------|------|---------|
| `BAD_REQUEST` | 400 | Malformed request or invalid parameters. |
| `VALIDATION_ERROR` | 400 | Body failed schema validation; `details` lists `{ field, message }` issues. |
| `PARSE_ERROR` | 400 | Body is not valid JSON. |
| `UNAUTHORIZED` | 401 | API key missing, unknown, revoked, or mismatched. |
| `INVALID_PERMISSIONS` | 403 | Valid credential lacking a required scope; `details` lists `requiredScopes` / `missingScopes`. |
| `FORBIDDEN` | 403 | Action not permitted for this caller. |
| `NOT_FOUND` | 404 | Unknown route or resource. |
| `METHOD_NOT_ALLOWED` | 405 | Resource does not support the method; see `Allow`. |
| `CONFLICT` | 409 | Conflicts with current resource state. |
| `PAYLOAD_TOO_LARGE` | 413 | Body exceeds the size limit. |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | `Content-Type` not accepted. |
| `UNPROCESSABLE` | 422 | Well-formed but cannot be processed. |
| `RATE_LIMITED` | 429 | Rate limit exceeded; honour `Retry-After`. |
| `INTERNAL_ERROR` | 500 | Unexpected server failure. |
| `SERVICE_UNAVAILABLE` | 503 | A required optional service is not configured. |

> Some older endpoints documented below (e.g. `POST /api/schedule`) still
> write ad-hoc bodies such as `{ "error": "...", "code": "..." }`. They will be
> migrated to the standard envelope; the codes they emit are unchanged.

Batch validation endpoints return structured validation results instead:

```json
{
  "valid": false,
  "processedCount": 0,
  "errors": [
    {
      "index": -1,
      "code": "PARSE_ERROR",
      "message": "Request body must be valid JSON."
    }
  ]
}
```

## HTTP Status Codes

| Status | Meaning | Typical Causes | Recommended Resolution |
|--------|---------|----------------|------------------------|
| 400 | Bad request | Invalid JSON, missing required fields, invalid IDs, invalid dates, invalid template or preference body | Fix request syntax and required fields before retrying. |
| 401 | Unauthorized | Missing webhook signature, missing key ID, unknown key ID, expired signature, invalid signature | Re-sign the exact raw body with a registered secret and send required headers. |
| 404 | Not found | Unknown route, scheduled notification ID not found, template not found, archived record not found | Verify the endpoint path and resource ID. |
| 429 | Too many requests | Rate limit exceeded for the client IP or API key | Wait for `Retry-After`, reduce request rate, or request a higher configured limit. |
| 500 | Internal server error | Database read/write failure, downstream service failure, unexpected handler error | Check listener logs with the request/correlation ID, database health, and downstream dependency status. |
| 503 | Service unavailable | Optional service disabled or unavailable, such as scheduler, templates, archive, analytics, metrics, or rate-limit metrics | Enable/configure the service or retry after the dependency is restored. |

## Scheduled Notifications

### `POST /api/schedule`

| Status | Error | Cause | Resolution |
|--------|-------|-------|------------|
| 400 | `Missing required fields: executeAt, payload, targetRecipient` | Request omitted one or more required scheduling fields. | Include `executeAt`, `payload`, and `targetRecipient`. |
| 400 | `executeAt is not a valid date` | `executeAt` could not be parsed into a valid JavaScript `Date`. | Send an ISO 8601 timestamp such as `2026-06-29T12:00:00.000Z`. |
| 500 | Runtime message from `NotificationAPI` or database | Date is expired, insert failed, or another scheduling error occurred. | Use a future `executeAt`; if it persists, inspect database logs. |
| 503 | `Scheduler not enabled` | Server was started without a configured `NotificationAPI`. | Configure and pass `notificationAPI` to the events server. |

Sample invalid date:

```json
{ "error": "executeAt is not a valid date" }
```

### `GET /api/schedule/:id`

| Status | Error | Cause | Resolution |
|--------|-------|-------|------------|
| 400 | `Invalid notification ID` | `:id` is not numeric. | Use an integer notification ID. |
| 404 | `Notification not found` | No scheduled notification exists with the requested ID. | Confirm the ID returned from `POST /api/schedule`. |
| 500 | Database error message | Lookup failed unexpectedly. | Check SQLite availability and listener logs. |
| 503 | `Scheduler not enabled` | Scheduler API is unavailable. | Enable scheduler configuration. |

### `GET /api/schedule/stats`

| Status | Error | Cause | Resolution |
|--------|-------|-------|------------|
| 500 | Database error message | Stats query failed. | Check database health and schema migrations. |
| 503 | `Scheduler not enabled` | Scheduler API is unavailable. | Enable scheduler configuration. |

## Batch Validation

### `POST /api/notifications/validate-batch`

| Status | Error Shape | Cause | Resolution |
|--------|-------------|-------|------------|
| 400 | `errors[].code = PARSE_ERROR` | Request body is not valid JSON. | Send a JSON array or `{ "notifications": [...] }`. |
| 400 | `INVALID_STRUCTURE` | Body is not an array and does not contain `notifications`. | Send an array of notification payloads. |
| 400 | `EMPTY_BATCH` | Batch has no items. | Include at least one notification. |
| 400 | `MISSING_FIELD`, `EMPTY_FIELD`, `INVALID_CHANNEL`, `DUPLICATE_RECIPIENT` | One or more notification items are invalid. | Correct the item fields shown in `errors[]`. |

Sample validation failure:

```json
{
  "valid": false,
  "processedCount": 0,
  "errors": [
    {
      "index": 0,
      "field": "recipient",
      "code": "MISSING_FIELD",
      "message": "Item at index [0]: Missing required field 'recipient'."
    }
  ]
}
```

## Webhooks

### `POST /api/webhooks`

| Status | Error | Cause | Resolution |
|--------|-------|-------|------------|
| 400 | `Failed to read request body` | Body stream could not be collected. | Retry with a valid request body. |
| 401 | `Missing signature header` | `X-Signature` was not provided. | Include the HMAC-SHA256 signature header. |
| 401 | `Missing key-id header` | `X-Key-Id` was not provided. | Include the key ID matching a configured webhook secret. |
| 401 | `Unknown key-id` | Key ID is not configured. | Use a registered key ID or update server secrets. |
| 401 | `Request signature expired` | Timestamp is outside the allowed window. | Recreate and resend the webhook promptly. |
| 401 | `Invalid signature` | HMAC does not match the raw body. | Sign the exact raw request body with the correct secret. |

## Templates

| Endpoint | Status | Error | Cause | Resolution |
|----------|--------|-------|-------|------------|
| Template routes | 503 | `Template service not enabled` | Template service was not injected into the server. | Configure `templateService`. |
| `GET /api/templates/:id` | 404 | `Template not found` | Unknown template ID. | Verify the template ID. |
| `GET /api/templates/:id/audit` | 404 | `Template not found` | No template and no audit records exist for ID. | Verify ID or create template first. |
| `PUT /api/templates/:id` | 400 | `Invalid JSON` | Request body is malformed JSON. | Send valid JSON. |
| `PUT /api/templates/:id` | 400 | `Invalid body: ...` | Update payload failed validation. | Provide at least one valid template field. |
| `PUT /api/templates/:id` | 404 | Template repository not found message | Template ID does not exist. | Create the template or use the correct ID. |
| `POST /api/templates` | 400 | `Invalid body: id, name, type, and body are required` | Required create fields are missing. | Include all required fields. |
| `POST /api/templates` | 400 | Template validation message | Template failed repository validation. | Correct field types and values. |

## Preferences

### `PUT /api/preferences/:userId`

| Status | Error | Cause | Resolution |
|--------|-------|-------|------------|
| 400 | `Invalid body: expected { categories: { [key]: boolean } }` | `categories` is missing or not an object. | Send category flags as booleans. |
| 400 | `Invalid JSON` | Body is malformed JSON. | Send valid JSON. |

## History, Search, Archive, Analytics, and Metrics

| Endpoint Area | Status | Error | Cause | Resolution |
|---------------|--------|-------|-------|------------|
| `/api/notifications/history` | 500 | Database or service error message | History query failed. | Check database and execution log table. |
| `/api/search/suggestions` | 500 | Search service error message | Suggestion lookup failed. | Check search service logs and data source. |
| `/api/archive/run` | 503 | `Archive service not enabled` | Archive service unavailable. | Configure `archiveService`. |
| `/api/archive/:id` | 404 | `Archived record not found` | Unknown archive ID. | Verify the archive record ID. |
| `/api/archive*` | 500 | Archive error message | Archive query/run failed. | Inspect archive logs and backing store. |
| `/api/rate-limit/metrics` | 503 | `Rate limiting not enabled` | Rate limiter was not configured. | Configure rate limiting before querying metrics. |
| Metrics history routes | 503 | `Metrics history store unavailable` | Metrics store missing. | Configure `metricsStore`. |
| Analytics routes | 503 | `Analytics aggregator unavailable` | Aggregator disabled or unavailable. | Configure analytics aggregation. |

## Troubleshooting Checklist

1. Capture the HTTP status, response body, request ID, and correlation ID.
2. Confirm the endpoint is enabled in server options.
3. Validate request JSON, required fields, and date formats.
4. For scheduler errors, inspect `scheduled_notifications` and `notification_execution_log`.
5. For retry errors, check `retry_count`, `max_retries`, and `next_retry_at`.
6. For 500 errors, inspect listener logs and database migration state.
