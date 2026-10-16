# API Error Reference

Complete reference for error responses returned by the NotifyChain listener HTTP API.

Every error response is JSON. Use this document to map a status code and body to a cause and a concrete fix.

**Related:** [API Contract and Event Reference](../listener/API_CONTRACT_EVENT_REFERENCE.md) · [API Versioning](api-versioning.md) · [Contributor Troubleshooting](CONTRIBUTOR_TROUBLESHOOTING.md)

---

## Table of Contents

1. [Error Response Format](#1-error-response-format)
2. [Diagnostic Headers](#2-diagnostic-headers)
3. [HTTP Status Codes](#3-http-status-codes)
4. [400 — Bad Request](#4-400--bad-request)
5. [401 — Unauthorized](#5-401--unauthorized)
6. [404 — Not Found](#6-404--not-found)
7. [409 — Conflict](#7-409--conflict)
8. [413 — Payload Too Large](#8-413--payload-too-large)
9. [415 — Unsupported Media Type](#9-415--unsupported-media-type)
10. [429 — Too Many Requests](#10-429--too-many-requests)
11. [500 — Internal Server Error](#11-500--internal-server-error)
12. [503 — Service Unavailable](#12-503--service-unavailable)
13. [Batch Validation Error Codes](#13-batch-validation-error-codes)
14. [Quick Reference Table](#14-quick-reference-table)

---

## 1. Error Response Format

Most errors return a single `error` field:

```json
{
  "error": "Template not found"
}
```

Rate-limit responses add a human-readable `message`:

```json
{
  "error": "Too Many Requests",
  "message": "Rate limit exceeded. Try again in 42 seconds."
}
```

Batch validation returns a structured, per-item error array instead of a flat `error` string — see [Section 13](#13-batch-validation-error-codes):

```json
{
  "valid": false,
  "processedCount": 0,
  "errors": [
    { "index": 2, "code": "MISSING_FIELD", "message": "Field 'recipient' is required." }
  ]
}
```

> **Note:** the API does not currently emit a stable machine-readable error code at the top level for non-batch errors. Match on the HTTP status code first, and treat the `error` string as human-readable. Only the batch validation `code` values in Section 13 are stable identifiers safe to branch on.

---

## 2. Diagnostic Headers

Every response — success or error — carries these headers. Include them in any bug report.

| Header | Description |
|--------|-------------|
| `X-Request-Id` | Unique ID generated per request. Appears in listener logs for the same request. |
| `X-Correlation-Id` | Echoes an inbound `X-Correlation-Id` if supplied, otherwise a new UUID. Use it to trace one logical operation across services. |
| `X-API-Version` | Active API version — currently `v1`. |

Rate-limited endpoints additionally return `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`, and — on a 429 — `Retry-After`.

To correlate a failure with server logs, send your own correlation ID:

```bash
curl -i -H "X-Correlation-Id: debug-run-001" http://localhost:8787/api/events
```

---

## 3. HTTP Status Codes

| Code | Meaning | Retry? |
|------|---------|--------|
| `200` | Success | — |
| `201` | Resource created (scheduled notification, template) | — |
| `202` | Accepted — webhook received, processed asynchronously | — |
| `204` | No content — CORS preflight (`OPTIONS`) | — |
| `400` | Bad Request — malformed or invalid input | No — fix the request |
| `401` | Unauthorized — missing or invalid credentials/signature | No — fix credentials |
| `404` | Not Found — unknown route or missing resource | No |
| `409` | Conflict — resource already exists | No — use a different key |
| `413` | Payload Too Large — body exceeds the size limit | No — shrink the payload |
| `415` | Unsupported Media Type — request Content-Type is not supported | No — send supported Content-Type (e.g. application/json) |
| `429` | Too Many Requests — rate limit exceeded | Yes — after `Retry-After` |
| `500` | Internal Server Error — unhandled server failure | Yes — with backoff |
| `503` | Service Unavailable — an optional subsystem is not enabled | No — enable the subsystem |

---

## 4. 400 — Bad Request

The request reached the right handler but the input was rejected.

### Missing required fields

```json
{ "error": "Missing required fields: executeAt, payload, targetRecipient" }
```

**Cause:** `POST /api/schedule` was called without all three required fields.

**Resolution:** Supply every listed field.

```bash
curl -X POST http://localhost:8787/api/schedule \
  -H "Content-Type: application/json" \
  -d '{
    "executeAt": "2026-01-01T12:00:00Z",
    "payload": { "message": "Reminder" },
    "targetRecipient": "GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
  }'
```

### Invalid date

```json
{ "error": "executeAt is not a valid date" }
```

**Cause:** `executeAt` could not be parsed as a date.

**Resolution:** Use an ISO 8601 timestamp, e.g. `2026-01-01T12:00:00Z`. A Unix epoch number or a locale-formatted string will be rejected.

### Malformed JSON body

```json
{
  "valid": false,
  "processedCount": 0,
  "errors": [
    { "index": -1, "code": "PARSE_ERROR", "message": "Request body must be valid JSON." }
  ]
}
```

**Cause:** The body of `POST /api/notifications/validate-batch` was not valid JSON.

**Resolution:** Verify the payload parses, and that `Content-Type: application/json` is set. A common cause is shell quoting — prefer `--data-binary @file.json` over an inline heredoc.

### Failed to read request body

```json
{ "error": "Failed to read request body" }
```

**Cause:** The connection dropped or the stream errored while `POST /api/webhooks` was reading the body.

**Resolution:** Retry. If it persists, check for a proxy timeout between client and listener.

### Template validation errors

```json
{ "error": "Missing required fields" }
```
```json
{ "error": "Invalid template ID" }
```
```json
{ "error": "Missing unique key" }
```

**Cause:** A template request omitted required fields, or passed a non-numeric/malformed template ID in the path.

**Resolution:** Check the request against [`listener/src/api/template-routes.ts`](../listener/src/api/template-routes.ts). Template IDs are numeric; `/api/templates/abc` is rejected.

---

## 5. 401 — Unauthorized

Returned by `POST /api/webhooks` (signature verification) and the scheduler admin routes.

| Response | Cause | Resolution |
|----------|-------|------------|
| `{"error": "Missing signature header"}` | No signature header on the webhook request. | Sign the raw body and send the signature header. |
| `{"error": "Missing key-id header"}` | No key-id header supplied. | Send the key-id identifying which shared secret was used. |
| `{"error": "Unknown key-id"}` | The key-id is not registered with the listener. | Verify the key-id matches one configured in the listener's webhook key set. |
| `{"error": "Request signature expired"}` | The signed timestamp is outside the allowed freshness window. | Sign and send within the window. Check for clock skew — sync with NTP. |
| `{"error": "Invalid signature"}` | The computed HMAC does not match the supplied signature. | See below. |
| `{"error": "Unauthorized"}` | Scheduler admin route called without valid credentials. | Supply the configured API key. |

**Debugging `Invalid signature`** — the three usual causes, in order of likelihood:

1. **Signing the parsed body rather than the raw bytes.** Re-serialising JSON changes key order and whitespace, producing a different digest. Sign the exact bytes you transmit.
2. **A secret mismatch** between sender and listener — check for a trailing newline in the `.env` value.
3. **Encoding mismatch** — confirm hex vs. base64 matches what the verifier expects.

See [`listener/src/services/webhook-verifier.ts`](../listener/src/services/webhook-verifier.ts) for the exact verification logic.

---

## 6. 404 — Not Found

```json
{ "error": "Not found" }
```

**Cause:** No route matched the method and path.

**Resolution:**
- Check the method — `GET /api/schedule` does not exist; scheduling is `POST /api/schedule`.
- Check the version prefix. Both `/api/events` and `/api/v1/events` work (`/api/v1/*` is rewritten to `/api/*`), but `/v1/events` does not.
- Confirm the subsystem is registered. Template routes only exist when a `templateService` is configured; without it, `/api/templates` returns 404 rather than 503.

```json
{ "error": "Template not found" }
```

**Cause:** The template ID or unique key does not exist.

**Resolution:** List templates with `GET /api/templates` and confirm the identifier. Note a deleted template returns 404 on subsequent reads.

---

## 7. 409 — Conflict

```json
{ "error": "Template with this unique key already exists" }
```

**Cause:** `POST /api/templates` used a unique key already taken.

**Resolution:** Choose a different unique key, or update the existing template instead of creating a new one. To check first:

```bash
curl http://localhost:8787/api/templates
```

---

## 8. 413 — Payload Too Large

```json
{ "error": "Notification payload of 98304 bytes exceeds the 65536-byte limit. Reduce the payload size and retry." }
```

**Cause:** The notification payload exceeded the maximum size — **64 KB (65,536 bytes)** by default.

**Resolution:**
- Move large content out of the payload and reference it by URL.
- Split a batch into smaller requests.
- Strip redundant nesting or whitespace before sending.

Retrying unchanged will fail identically. See [`listener/src/utils/payload-size-validator.ts`](../listener/src/utils/payload-size-validator.ts).

---

## 9. 415 — Unsupported Media Type

```json
{
  "success": false,
  "error": {
    "code": "UNSUPPORTED_MEDIA_TYPE",
    "message": "Unsupported Content-Type. Supported types: application/json"
  }
}
```

**Cause:** The request supplied a `Content-Type` header specifying a media type that the endpoint does not support (e.g. sending `text/plain` or `application/xml` to a JSON API endpoint).

**Resolution:**
- Set `Content-Type: application/json` (or `application/json; charset=utf-8`) for JSON endpoints (e.g. `POST /api/schedule`, `POST /api/webhooks`, `POST /api/templates`, `PUT /api/preferences/:userId`).
- For bulk import (`POST /api/notifications/import`), both `application/json` and `text/csv` (or `application/csv`) are supported.
- Ensure the header value matches the payload format.

---

## 10. 429 — Too Many Requests

```json
{
  "error": "Too Many Requests",
  "message": "Rate limit exceeded. Try again in 42 seconds."
}
```

**Cause:** The client exceeded its allowed request count within the sliding window.

**Response headers:**

| Header | Meaning |
|--------|---------|
| `X-RateLimit-Limit` | Maximum requests permitted per window. |
| `X-RateLimit-Remaining` | Requests left in the current window. |
| `X-RateLimit-Reset` | Unix timestamp (seconds) when the window resets. |
| `Retry-After` | Seconds to wait before retrying. |

**Resolution:** Honour `Retry-After` — do not retry immediately. Use exponential backoff with jitter for automated clients, and read `X-RateLimit-Remaining` proactively rather than waiting to be blocked.

`GET /api/rate-limit/metrics` is **exempt** from rate limiting by design, so you can always inspect the metrics that explain why you are being throttled:

```bash
curl http://localhost:8787/api/rate-limit/metrics
```

---

## 11. 500 — Internal Server Error

```json
{ "error": "Internal server error" }
```

Some handlers surface the underlying exception message instead:

```json
{ "error": "SQLITE_BUSY: database is locked" }
```

**Cause:** An unhandled exception — commonly a database failure, a downstream provider timeout, or a bug.

**Resolution:**

1. Capture the `X-Request-Id` from the response.
2. Grep the listener logs for that ID — the full stack trace is logged server-side even when the response body is generic.
3. For `SQLITE_BUSY`, check whether another process holds the database file; see [Contributor Troubleshooting](CONTRIBUTOR_TROUBLESHOOTING.md).
4. Retry with exponential backoff — many 500s here are transient.

If reproducible, open an issue including the request ID, the request, and the surrounding log lines.

---

## 12. 503 — Service Unavailable

A 503 from this API almost always means **an optional subsystem is not enabled**, not that the server is overloaded. Retrying will not help — enable the subsystem.

| Response | Subsystem | Resolution |
|----------|-----------|------------|
| `{"error": "Scheduler not enabled"}` | Scheduled notifications | Configure and enable the scheduler; all `/api/schedule*` routes return this until it is running. |
| `{"error": "Rate limiting not enabled"}` | Rate limiter | Enable rate limiting to use `/api/rate-limit/metrics`. |
| `{"error": "Health monitor not configured or no report yet"}` | Notification health monitor | Configure the monitor, or wait for its first report — this also appears briefly right after startup. |
| `{"error": "Metrics history store unavailable"}` | Analytics history | Enable the metrics history store for `/api/analytics/history`. |
| `{"error": "Analytics aggregator unavailable"}` | Analytics aggregator | Enable the aggregator for `/api/analytics`. |

See [`ENVIRONMENT_VARIABLES_AND_SECRETS.md`](../ENVIRONMENT_VARIABLES_AND_SECRETS.md) for the configuration each subsystem requires.

---

## 13. Batch Validation Error Codes

`POST /api/notifications/validate-batch` returns a structured error array. These `code` values are stable and safe to branch on.

```json
{
  "valid": false,
  "processedCount": 0,
  "errors": [
    { "index": 0, "code": "MISSING_FIELD", "message": "Field 'recipient' is required." },
    { "index": 3, "code": "INVALID_CHANNEL", "message": "Channel 'carrier-pigeon' is not supported." }
  ]
}
```

`index` is the zero-based position in the submitted array; `-1` means the error applies to the request as a whole.

| Code | Meaning | Resolution |
|------|---------|------------|
| `PARSE_ERROR` | Body is not valid JSON. Always `index: -1`. | Validate the JSON and set `Content-Type: application/json`. |
| `INVALID_STRUCTURE` | Top-level payload is not the expected shape. | Send an array of notification objects (or the documented wrapper). |
| `EMPTY_BATCH` | The batch contains no items. | Include at least one notification. |
| `INVALID_ITEM` | An item is not an object. | Remove nulls, strings, or primitives from the array. |
| `MISSING_FIELD` | A required field is absent. | Add the field named in `message`. |
| `EMPTY_FIELD` | A required field is present but empty or whitespace-only. | Provide a non-empty value. |
| `INVALID_CHANNEL` | The channel is not supported. | Use a supported channel identifier. |
| `DUPLICATE_RECIPIENT` | The same recipient appears more than once in the batch. | Deduplicate before sending — see [ADR-0005](adr/0005-event-deduplication-strategy.md). |
| `VALIDATION_ERROR` | General validation failure from the batch service. | Read `message` for the specific constraint violated. |

Validate a batch before submitting it:

```bash
curl -X POST http://localhost:8787/api/notifications/validate-batch \
  -H "Content-Type: application/json" \
  --data-binary @batch.json
```

You can also run the validator locally without a server:

```bash
cd listener
npm run validate:batch
```

---

## 14. Quick Reference Table

| Status | Response `error` | Endpoint(s) | Fix |
|--------|------------------|-------------|-----|
| 400 | `Missing required fields: executeAt, payload, targetRecipient` | `POST /api/schedule` | Add all three fields |
| 400 | `executeAt is not a valid date` | `POST /api/schedule` | Use ISO 8601 |
| 400 | `Failed to read request body` | `POST /api/webhooks` | Retry; check proxy timeouts |
| 400 | `Missing required fields` | `POST /api/templates` | Add required template fields |
| 400 | `Invalid template ID` | `/api/templates/:id` | Use a numeric ID |
| 400 | `Missing unique key` | `/api/templates` | Supply the unique key |
| 401 | `Missing signature header` | `POST /api/webhooks` | Sign the request |
| 401 | `Missing key-id header` | `POST /api/webhooks` | Send the key-id |
| 401 | `Unknown key-id` | `POST /api/webhooks` | Register/correct the key-id |
| 401 | `Request signature expired` | `POST /api/webhooks` | Fix clock skew; re-sign |
| 401 | `Invalid signature` | `POST /api/webhooks` | Sign raw bytes, verify secret |
| 401 | `Unauthorized` | `/api/schedule` admin | Supply the API key |
| 404 | `Not found` | any | Check method, path, version prefix |
| 404 | `Template not found` | `/api/templates/*` | Verify the identifier |
| 409 | `Template with this unique key already exists` | `POST /api/templates` | Use a different key |
| 413 | `…exceeds the 65536-byte limit…` | notification endpoints | Shrink the payload |
| 415 | `Unsupported Content-Type. Supported types: …` | mutating endpoints (`POST`/`PUT`) | Send `Content-Type: application/json` (or `text/csv` for import) |
| 429 | `Too Many Requests` | rate-limited routes | Wait `Retry-After` seconds |
| 500 | `Internal server error` | any | Trace `X-Request-Id` in logs |
| 503 | `Scheduler not enabled` | `/api/schedule*` | Enable the scheduler |
| 503 | `Rate limiting not enabled` | `/api/rate-limit/metrics` | Enable rate limiting |
| 503 | `Health monitor not configured or no report yet` | `/api/notifications/health` | Configure the monitor |
| 503 | `Metrics history store unavailable` | `/api/analytics/history` | Enable the history store |
| 503 | `Analytics aggregator unavailable` | `/api/analytics` | Enable the aggregator |

---

## Reporting an Undocumented Error

If you hit an error not covered here, open an issue with:

1. The full request (method, path, headers, body — **redact secrets**).
2. The full response, including status code and the `X-Request-Id` / `X-Correlation-Id` headers.
3. Listener log lines matching that request ID.
4. The listener version or commit SHA.

Source of truth for these responses: [`listener/src/api/events-server.ts`](../listener/src/api/events-server.ts), [`listener/src/api/template-routes.ts`](../listener/src/api/template-routes.ts), [`listener/src/api/rate-limiter.ts`](../listener/src/api/rate-limiter.ts), and [`listener/src/utils/batch-validator.ts`](../listener/src/utils/batch-validator.ts).
