# NotifyChain Listener — Integration Examples

Runnable, dependency-free integration examples for the **NotifyChain listener HTTP API**, in
both JavaScript (ESM) and TypeScript.

Every endpoint path, header name, query parameter, body field, and response field in these
examples was taken from the listener source (`listener/src/**`), **not** guessed. Where
`listener/API.md` and the code disagree, **the code wins** — see
[API.md vs. code discrepancies](#apimd-vs-code-discrepancies).

All examples use only Node built-ins: the global `fetch` (stable in Node 22+) and `node:crypto`.
No `axios`, `node-fetch`, or `dotenv`.

---

## Contents

| Path | What it shows |
| --- | --- |
| `js/lib/client.mjs` | Shared JS client: config, auth headers, envelope parsing, webhook signing, endpoint helpers |
| `js/01-setup-and-config.mjs` | Read config, build auth/tracing headers, probe `GET /health` |
| `js/02-events-retrieval.mjs` | `GET /api/events`, `GET /api/events/history`, client-side filtering, range validation errors |
| `js/03-notifications-consumption.mjs` | Offline webhook-signature verifier + signed `POST /api/webhooks` + history polling |
| `js/04-error-handling-and-retries.mjs` | Both error shapes, retry/backoff honouring `Retry-After`, malformed bodies |
| `ts/lib/client.ts` | Typed mirror of the JS client (real request/response interfaces) |
| `ts/01-…` … `ts/04-…` | TypeScript equivalents of the four JS examples |
| `ts/tsconfig.json` | Node ESM (`NodeNext`) config used by the `typecheck` script |

---

## Prerequisites

- **Node.js `^22.0.0 || ^24.0.0`**
  - `fetch` is used directly (global + stable from Node 22).
  - The TypeScript examples are executed **directly** by Node using its built-in
    type-stripping (Node ≥ 22.6, on by default in 24). No build step is required.
  - Examples were verified on Node **24.17.0** / npm **11.13.0**.
- A running listener is **optional**. Every example degrades gracefully when the listener is
  unreachable, and `03`/`04` exercise their core logic fully offline against local servers /
  injected `fetch`, so you can run all examples with no listener at all.

Check your version:

```sh
node --version   # expect v22.x or v24.x
```

---

## Install

```sh
cd examples
npm install
```

`npm install` only pulls the two dev dependencies (`typescript`, `@types/node`) used for
type-checking. The examples themselves have **zero runtime dependencies**.

---

## Configuration

Copy the template and edit as needed:

```sh
# Windows (PowerShell)
Copy-Item .env.example .env

# macOS / Linux
cp .env.example .env
```

Run an example with the file loaded (Node ≥ 20.6):

```sh
node --env-file=.env js/01-setup-and-config.mjs
```

Or export the variables in your shell and run the example normally. **Every variable is
optional** — the examples fall back to safe local defaults so they run standalone.

### Environment variables

| Variable | Default | Read by | Purpose |
| --- | --- | --- | --- |
| `EVENTS_API_BASE_URL` | `http://localhost:8787` | client | Listener base URL (listener `EVENTS_API_PORT` default is `8787`). |
| `EVENTS_API_KEY` | _(empty)_ | client | Sent as `X-API-Key`. Leave empty when the listener has no `API_KEYS` configured. |
| `WEBHOOK_SECRET` | `whsec_example_secret` | client | HMAC-SHA256 secret for webhook signing/verification (mirrors listener `WEBHOOK_SECRETS[].secret`). |
| `WEBHOOK_KEY_ID` | `default` | client | Sent as `X-Webhook-Key-Id`; must match the secret's `id` (mirrors `WEBHOOK_SECRETS[].id`). |
| `WEBHOOK_TIMESTAMP_MAX_AGE_SECONDS` | `300` | client | Freshness window for `X-Webhook-Timestamp` (listener default `300`). |
| `EXAMPLE_RECEIVER_PORT` | `8790` | example `03` | Port the local demo webhook receiver binds to (example-only; not read by the listener). |

---

## Running the examples

JavaScript:

```sh
node js/01-setup-and-config.mjs
node js/02-events-retrieval.mjs
node js/03-notifications-consumption.mjs
node js/04-error-handling-and-retries.mjs
```

TypeScript (run directly — Node strips the types):

```sh
node ts/01-setup-and-config.ts
node ts/02-events-retrieval.ts
node ts/03-notifications-consumption.ts
node ts/04-error-handling-and-retries.ts
```

The same commands are available as npm scripts:

```sh
npm run example:js:01   # … example:js:04
npm run example:ts:01   # … example:ts:04
```

Type-check the TypeScript examples (no emit):

```sh
npm run typecheck
# equivalent to: tsc --noEmit -p ts/tsconfig.json
```

### What each example does

- **01 — Setup & config**: prints the effective configuration with secrets masked, shows the
  exact headers the client attaches, then probes `GET /health` (best-effort).
- **02 — Events retrieval**: fetches the newest events, describes one event, demonstrates
  client-side filtering (the endpoint has no server-side filters), and triggers both the
  oversized-range and missing-parameter `400` errors from `GET /api/events/history`.
- **03 — Notification consumption**: starts a local HTTP receiver that verifies webhook
  signatures with the **exact** listener scheme, then posts valid / tampered / expired /
  wrong-secret payloads (all offline). Then, best-effort, it signs and `POST`s to the real
  listener's `/api/webhooks` and pages through `/api/notifications/history` using the opaque
  cursor.
- **04 — Errors & retries**: parses both real error envelope shapes, retries on `429`/`5xx`
  honouring `Retry-After` (with exponential backoff + jitter fallback), and shows that a
  non-JSON body is reported via a `malformed` flag rather than thrown.

---

## API contract (verified against the code)

### Base URL and tracing headers

The listener assigns a request ID and a correlation ID to every request and echoes them back
(`listener/src/utils/request-id.ts:94-103`):

| Header | Direction | Notes |
| --- | --- | --- |
| `X-Request-Id` | response (and optionally request) | Reused from the caller only if it matches `^[\w.:-]{8,128}$` (`request-id.ts:24-41`). |
| `X-Correlation-Id` | response (and optionally request) | Reused only if it matches `^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$` (`request-id.ts:53-72`). |
| `X-API-Key` | request | Authenticates protected routes (`api-key-auth.ts:47`). When no keys are configured, all routes are open (dev mode). |

### Response envelopes

Two envelopes exist (`listener/src/utils/response.ts:1-26,48-99`):

**Success** (most routes, e.g. `/api/events`):

```json
{ "success": true, "data": { /* payload */ } }
```

**Error** (most routes, via `sendErr`):

```json
{
  "success": false,
  "error": {
    "code": "BAD_REQUEST",
    "message": "Human readable message",
    "details": [],
    "correlation_id": "4d1c3c1e-0000-0000-0000-000000000000"
  }
}
```

Some routes deliberately **do not** use the envelope and return a bare object, and a few error
paths use a bare error shape `{ "error": "…", "code": "…" }`. The shared client's
`unwrapEnvelope()` / `extractApiError()` helpers handle both.

Stable error codes come from `listener/src/errors/api-error-codes.ts:26-42`:
`BAD_REQUEST`, `VALIDATION_ERROR`, `PARSE_ERROR`, `UNAUTHORIZED`, `INVALID_PERMISSIONS`,
`FORBIDDEN`, `NOT_FOUND`, `METHOD_NOT_ALLOWED`, `CONFLICT`, `PAYLOAD_TOO_LARGE`,
`UNSUPPORTED_MEDIA_TYPE`, `UNPROCESSABLE`, `RATE_LIMITED`, `INTERNAL_ERROR`,
`SERVICE_UNAVAILABLE`.

### Endpoints used by the examples

| Method + path | Auth | Enveloped? | Codes | Source |
| --- | --- | --- | --- | --- |
| `GET /health` | none | **no** (raw object) | `200` ok/degraded, `503` error | `events-server.ts:632-647`, `174-187`, `428-464` |
| `GET /api/events?limit=` | none | yes | `200` | `events-server.ts:723`; limit default 20, max 100 (`utils/pagination.ts:35-36`) |
| `GET /api/events/history?fromLedger&toLedger` | none | yes | `200`, `400` | `events-server.ts:672`; span ≤ 10 000 (`utils/ledger-range-validator.ts:17`) |
| `GET /api/notifications/history` | `X-API-Key` when configured | **no** (raw paginated object) | `200` | `events-server.ts:1788-1818` |
| `POST /api/schedule` | none | **no** (raw 201 object) | `201`, `400`, `503` | `events-server.ts:1196-1369` |
| `POST /api/webhooks` | signature | **no** (raw object) | `202` (or `200` replay), `400`, `401` | `events-server.ts:863-964` |

#### `GET /api/events` — `200`

```json
{
  "success": true,
  "data": {
    "count": 2,
    "events": [
      {
        "eventId": "0000551382593654784-0000000001",
        "contractAddress": "CCEMX6...",
        "eventName": "TaskCreated",
        "ledger": 551382,
        "type": "contract",
        "topic": ["AAAADwAAAAtUYXNrQ3JlYXRlZA=="],
        "value": "AAAAEAAAAAEAAAAC...",
        "txHash": "1a2b3c…",
        "receivedAt": 1718895600000
      }
    ]
  }
}
```

`DisplayEvent` shape: `listener/src/types/display-event.ts:1-11`. `value` is base64-encoded XDR;
`topic` is the decoded topic array; `receivedAt` is epoch milliseconds.

#### `GET /api/events/history` — `200` and `400`

```json
{ "success": true, "data": { "count": 0, "startLedger": 1, "endLedger": 5000, "events": [] } }
```

```json
{
  "success": false,
  "error": {
    "code": "BAD_REQUEST",
    "message": "range too large: 20000 ledgers requested, maximum is 10000",
    "details": [{ "field": "endLedger", "message": "range too large: …" }],
    "correlation_id": "…"
  }
}
```

#### `GET /api/notifications/history` — `200` (raw, not enveloped)

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

Shape: `listener/src/services/notification-history.ts:5-32`, `listener/API.md:657-708`.
`status` is one of `SUCCESS` | `FAILED` | `RETRY`.

#### `POST /api/schedule` — `201` (raw, not enveloped)

Request body (required fields):

```json
{
  "executeAt": "2026-01-01T00:00:00.000Z",
  "payload": "Hello from the examples",
  "targetRecipient": "123456789"
}
```

Response:

```json
{
  "id": 7,
  "executeAt": "2026-01-01T00:00:00.000Z",
  "timezone": "UTC",
  "executeAtLocal": "January 1, 2026 at 12:00 AM"
}
```

`notificationType` defaults to `DISCORD` (`events-server.ts:1310`). A local schedule may instead
pass `timeZone` + `localDateTime`. Validation failures use the bare shape, e.g.
`{ "error": "Missing required fields: …", "code": "MISSING_FIELDS" }` (`events-server.ts:1226-1237`).

#### `POST /api/webhooks` — `202` accepted

**Required headers** (see `webhook-verifier.ts:190-206`):

| Header | Value |
| --- | --- |
| `Content-Type` | `application/json` |
| `X-Webhook-Signature` | `sha256=<hex>` — HMAC-SHA256 of the signing input |
| `X-Webhook-Key-Id` | The secret's id |
| `X-Webhook-Timestamp` | Unix epoch **seconds** (integer) |

**Signing input** (`webhook-verifier.ts:6-10,44-66`):

```
signingInput = `${timestamp}.${rawBody}`     // or just `rawBody` when no timestamp
signature    = "sha256=" + HMAC_SHA256(signingInput, secret).hex
```

The signature prefix is compared case-insensitively, the timestamp must be within the freshness
window (default 300s, small negative clock skew tolerated), and the comparison is
timing-safe (`verifySignature`).

Accepted response:

```json
{ "status": "accepted", "verified": true }
```

When an `Idempotency-Key` is supplied, a duplicate replay returns `200` with
`{ ...result, "replay": true }` and an `X-Idempotent-Replay: true` header (`events-server.ts:942-959`).

**Auth failures** use the bare shape (`events-server.ts:870-873`), e.g.
`{ "success": false, "error": { "code": "…", "message": "…" }, "code": "…" }` with HTTP `401`.

---

## API.md vs. code discrepancies

These are places where `listener/API.md` and the actual implementation disagree. **The examples
follow the code.**

1. **Webhook header names differ.**
   - `API.md:1305-1310, 1633-1647` documents the required headers as **`X-Signature`** and
     **`X-Key-Id`** (and lists only those two).
   - The code reads **`X-Webhook-Signature`**, **`X-Webhook-Key-Id`**, and
     **`X-Webhook-Timestamp`** (`listener/src/services/webhook-verifier.ts:190-206`).
   - **Follow the code**: use the `X-Webhook-*` header names. There is also a **timestamp
     header** the doc omits entirely.

2. **Webhook signature format.** The code produces `sha256=<hex>`
   (`webhook-verifier.ts:6`), while `API.md:1309` describes a bare "HMAC-SHA256 hex digest".
   Use the `sha256=` prefix.

3. **API.md structure is off.** `API.md:1301` documents `POST /api/webhooks` under the
   **"User Notification Preferences"** heading, and the later `## Webhooks` section
   (`API.md:1460`) is empty. The response examples in the doc (`{ "status": "accepted" }`) also
   omit the `verified: true` field the code returns (`events-server.ts:929-939`).

4. **Response-shape split is under-documented.** Several routes do **not** wrap their payload in
   the `{ success: true, data }` envelope — `/api/notifications/history`, `POST /api/schedule`,
   `POST /api/webhooks`, and `/health` all return raw objects, and some error paths use the bare
   `{ error, code }` shape. The examples' `unwrapEnvelope()` / `extractApiError()` helpers handle
   both uniformly.

5. **`GET /api/events` supports only `limit`.** There are no server-side `offset`/filter
   parameters; filtering must be done client-side (see example `02`). Use
   `/api/notifications/history` for `offset`/`cursor` pagination.

---

## Notes on tooling

- The examples intentionally avoid a bundler/ts-node. `.ts` files are executed by Node's native
  type-stripping, so they must use **erasable-only** TypeScript syntax (types are erased, not
  transformed) — no `enum`, no parameter properties, no `namespace` with runtime output. The
  provided `tsconfig.json` matches this with `verbatimModuleSyntax` and `allowImportingTsExtensions`.
- `ts/lib/client.ts` imports with explicit `.ts` extensions so the same import specifiers work
  both for Node execution and `tsc --noEmit`.
