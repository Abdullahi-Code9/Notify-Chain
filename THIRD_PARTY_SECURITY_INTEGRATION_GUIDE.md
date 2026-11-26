# Third-Party Security Integration Guide

**Issue #1222** — External Security Integration Reference

This guide covers everything an external developer needs to connect a third-party
application to NotifyChain securely. It documents API credential handling, webhook
destination requirements, secure communication expectations, request validation,
and authorization. Each section ends with an example. No real credentials appear
anywhere in this document.

---

## Table of Contents

1. [Prerequisites](#1-prerequisites)
2. [API credential handling](#2-api-credential-handling)
3. [Webhook destination requirements](#3-webhook-destination-requirements)
4. [Secure communication expectations](#4-secure-communication-expectations)
5. [Request signing and verification](#5-request-signing-and-verification)
6. [Authorization model and scopes](#6-authorization-model-and-scopes)
7. [Rate limiting and abuse prevention](#7-rate-limiting-and-abuse-prevention)
8. [Error handling and status codes](#8-error-handling-and-status-codes)
9. [Complete integration examples](#9-complete-integration-examples)
10. [Unsafe patterns to avoid](#10-unsafe-patterns-to-avoid)
11. [Security checklist](#11-security-checklist)

---

## 1. Prerequisites

| Requirement | Detail |
|---|---|
| **HTTPS endpoint** | Your webhook receiver must accept HTTPS. HTTP destinations are rejected. |
| **TLS 1.2 or later** | Older protocol versions are not accepted. |
| **Valid TLS certificate** | Self-signed certificates are rejected in production. |
| **Reachable from the internet** | The listener must be able to POST to your URL. |
| **Respond within 10 seconds** | The default `WEBHOOK_TIMEOUT_MS` is `10000`. Longer responses are treated as failures and trigger the retry policy. |

---

## 2. API credential handling

### 2.1 Credential format

NotifyChain API keys follow this format:

```
nck_<16-hex-char-id>_<43-char-base64url-secret>
```

Example (non-functional):

```
nck_a3f1c09d4b7e82f1_X9kLmNpQrStUvWxYzAbCdEfGhIjKlMnOpQrStUvWxYz
```

The first segment (`nck_<id>`) is public — it identifies the credential in logs
and in the management API without exposing the secret. The secret portion is
**returned exactly once**, at creation time, and is never recoverable after that.
Store it immediately in a secret manager.

### 2.2 Credential scopes

Every key carries an explicit list of permission scopes. Request only the scopes
your integration actually needs — the principle of least privilege.

| Scope | Grants access to |
|---|---|
| `events:read` | `GET /api/events` and the SSE stream |
| `events:write` | Ingest or acknowledge events |
| `stats:read` | `GET /api/stats` and analytics endpoints |
| `notifications:read` | Read scheduled and historical notifications |
| `notifications:write` | Create, update, or cancel notifications |
| `webhooks:manage` | Register and rotate webhook destinations |
| `credentials:manage` | Issue and revoke API keys (admin only) |
| `credentials:read` | List existing credentials without secret material |

### 2.3 Secret storage rules

- **Never hardcode a key in source code.** Use environment variables or a secrets
  manager (AWS Secrets Manager, HashiCorp Vault, GCP Secret Manager, etc.).
- **Never log the full key.** NotifyChain's listener redacts any field whose name
  looks like a credential (`secret`, `token`, `apiKey`, `authorization`,
  `signature`, `privateKey`, and variants). Your own application should do the
  same.
- **Never commit a `.env` file** that contains a live key. Add `.env` to
  `.gitignore`. Commit only `.env.example` files with placeholder values.
- **Rotate keys periodically.** Use `credentials:manage` scope or the management
  UI to revoke and reissue keys on a schedule, or immediately after any suspected
  exposure.

### 2.4 Sending the key in requests

Pass the key in the `Authorization` header using the `Bearer` scheme:

```http
GET /api/events HTTP/1.1
Host: your-notifychain-listener.example.com
Authorization: Bearer nck_a3f1c09d4b7e82f1_<secret>
```

Do not pass the key as a query parameter — query strings appear in server access
logs, proxy logs, and browser history.

---

## 3. Webhook destination requirements

### 3.1 URL requirements

NotifyChain performs the following checks before registering or delivering to a
webhook URL.

- Must use the `https://` scheme. `http://` URLs are rejected.
- Must be reachable from the NotifyChain host at registration time.
- Must not be a localhost, loopback, or RFC 1918 private address in production
  deployments (prevents server-side request forgery via webhook registration).
- Path and query string are preserved. Fragments (`#…`) are stripped.

### 3.2 Delivery mechanism

NotifyChain sends a `POST` request to your registered URL with:

```
Content-Type: application/json
X-Webhook-Key-Id: <your-key-id>
X-Webhook-Signature: sha256=<hmac-hex>
X-Webhook-Timestamp: <unix-epoch-seconds>
```

Your endpoint must return any `2xx` response to acknowledge delivery. Any other
status code, a timeout, or a connection failure causes the delivery to be retried
according to the retry policy (see [Section 7](#7-rate-limiting-and-abuse-prevention)).

### 3.3 Expected response time

The listener waits at most `WEBHOOK_TIMEOUT_MS` (default `10000` ms) for your
endpoint to respond. If your handler needs to do expensive processing, respond
immediately with `202 Accepted` and process the payload asynchronously.

```http
HTTP/1.1 202 Accepted
Content-Length: 0
```

---

## 4. Secure communication expectations

### 4.1 TLS

All traffic between NotifyChain and your integration must use HTTPS with TLS 1.2
or later. The listener will refuse to deliver to a URL that presents an expired,
self-signed, or otherwise invalid certificate.

### 4.2 CORS

The listener exposes an `EVENTS_API_CORS_ORIGIN` configuration that restricts
which browser origins may call the events API. In production this must be set to
your specific dashboard origin, not `*`. A wildcard `CORS_ORIGIN` in production
is flagged as a misconfiguration at startup.

```bash
# Correct — specific origin
EVENTS_API_CORS_ORIGIN=https://dashboard.yourcompany.example.com

# Unsafe — do not use in production
EVENTS_API_CORS_ORIGIN=*
```

### 4.3 Mutual authentication (optional)

For high-security integrations, place the NotifyChain listener behind an mTLS
reverse proxy (e.g. nginx, Envoy, Cloudflare Tunnel) so that your webhook
receiver also validates a client certificate from NotifyChain. The listener
itself does not issue client certificates today; mTLS must be managed at the
network layer.

### 4.4 Network-level controls

- Restrict inbound webhook traffic to NotifyChain's egress IP range. Keep this
  allowlist in your infrastructure-as-code, not in the application.
- Do not expose the NotifyChain listener management endpoints (`/api/admin/*`)
  on a public interface. Place them behind a VPN or an internal load balancer.

---

## 5. Request signing and verification

NotifyChain signs every outgoing webhook delivery with HMAC-SHA256. Your
receiver must verify this signature before processing the payload.

### 5.1 Signing scheme

The signed input is:

```
signingInput = X-Webhook-Timestamp + "." + rawRequestBody
```

The HMAC is computed over `signingInput` using the per-destination secret, then
hex-encoded and prefixed with `sha256=`:

```
X-Webhook-Signature: sha256=<hex-encoded-hmac>
```

The timestamp is **cryptographically bound** to the signature. Stripping the
`X-Webhook-Timestamp` header from a captured request does not produce a
re-playable payload — the HMAC will not verify without the original timestamp
value that was included during signing.

### 5.2 Verification steps

1. Read the raw request body **before** any JSON parsing. JSON parsers may
   normalize whitespace and invalidate the HMAC.
2. Extract `X-Webhook-Key-Id`, `X-Webhook-Signature`, and `X-Webhook-Timestamp`.
3. Look up the shared secret for the given key ID.
4. Reconstruct `signingInput = timestamp + "." + rawBody`.
5. Compute `expectedHmac = HMAC-SHA256(secret, signingInput)`, hex-encoded.
6. Compare `sha256=<expectedHmac>` with the received `X-Webhook-Signature`
   using a **constant-time comparison** (see example below). Do not use `===`.
7. Check that `X-Webhook-Timestamp` is within ±5 minutes of the current time.
   Reject any request outside this window to bound the replay attack surface.

### 5.3 Node.js verification example

```typescript
import crypto from 'crypto';

const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET!; // loaded from env/secrets manager
const MAX_AGE_SECONDS = 300; // 5 minutes

function verifyNotifyChainWebhook(
  rawBody: string,
  signatureHeader: string,
  timestampHeader: string,
): boolean {
  // 1. Reject requests outside the freshness window
  const now = Math.floor(Date.now() / 1000);
  const requestTime = parseInt(timestampHeader, 10);
  if (!Number.isFinite(requestTime) || Math.abs(now - requestTime) > MAX_AGE_SECONDS) {
    return false;
  }

  // 2. Reconstruct the signing input
  const signingInput = `${timestampHeader}.${rawBody}`;

  // 3. Compute expected HMAC
  const expected = crypto
    .createHmac('sha256', WEBHOOK_SECRET)
    .update(signingInput, 'utf8')
    .digest('hex');
  const expectedHeader = `sha256=${expected}`;

  // 4. Constant-time comparison — never use === for HMAC comparison
  if (expectedHeader.length !== signatureHeader.length) return false;
  return crypto.timingSafeEqual(
    Buffer.from(expectedHeader, 'utf8'),
    Buffer.from(signatureHeader, 'utf8'),
  );
}
```

### 5.4 Python verification example

```python
import hashlib
import hmac
import os
import time

WEBHOOK_SECRET = os.environ["WEBHOOK_SECRET"]  # loaded from env/secrets manager
MAX_AGE_SECONDS = 300

def verify_notifychain_webhook(
    raw_body: bytes,
    signature_header: str,
    timestamp_header: str,
) -> bool:
    # 1. Freshness check
    now = int(time.time())
    try:
        request_time = int(timestamp_header)
    except ValueError:
        return False
    if abs(now - request_time) > MAX_AGE_SECONDS:
        return False

    # 2. Reconstruct signing input
    signing_input = f"{timestamp_header}.".encode() + raw_body

    # 3. Compute expected HMAC
    expected_hex = hmac.new(
        WEBHOOK_SECRET.encode(), signing_input, hashlib.sha256
    ).hexdigest()
    expected = f"sha256={expected_hex}"

    # 4. Constant-time comparison
    return hmac.compare_digest(expected, signature_header)
```

### 5.5 Replay cache

Even with freshness checks, a captured request is replayable within the
5-minute window. NotifyChain's listener maintains a server-side replay cache
keyed on `(key-id, signature)`. If your receiver is sensitive to duplicate
deliveries (e.g. payment processing), maintain your own idempotency store keyed
on the same tuple.

---

## 6. Authorization model and scopes

### 6.1 How scopes are enforced

Each endpoint in the listener declares the scopes it requires. When a request
arrives with an `Authorization: Bearer nck_…` key, the listener:

1. Looks up the credential record by the key ID prefix.
2. Verifies the secret against the stored scrypt hash.
3. Checks that every required scope appears in the credential's scope list.
4. If any scope is missing, returns `403` with error code `INVALID_PERMISSIONS`.

Revoked credentials return `401` regardless of scope.

### 6.2 Creating a credential with minimal scopes

Using `credentials:manage`, issue a key with only the scopes the integration needs:

```bash
# Request: POST /api/credentials
# Authorization: Bearer <admin-key>
curl -X POST https://listener.example.com/api/credentials \
  -H "Authorization: Bearer nck_<admin-id>_<admin-secret>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "event-reader-prod",
    "scopes": ["events:read", "stats:read"]
  }'
```

Response (returned once only — store the `apiKey` immediately):

```json
{
  "id": "nck_b4e2d10a3c9f75e2",
  "name": "event-reader-prod",
  "scopes": ["events:read", "stats:read"],
  "keyPrefix": "nck_b4e2d10a3c9f75e2",
  "apiKey": "nck_b4e2d10a3c9f75e2_<secret>",
  "createdAt": "2025-07-26T10:00:00.000Z",
  "lastUsedAt": null,
  "revokedAt": null
}
```

### 6.3 Revoking a credential

```bash
curl -X DELETE https://listener.example.com/api/credentials/nck_b4e2d10a3c9f75e2 \
  -H "Authorization: Bearer nck_<admin-id>_<admin-secret>"
```

Revocation is immediate. The in-process verification cache is cleared for that
credential within the next cache TTL cycle (default 60 seconds). For
high-security scenarios, restart the listener after revoking a suspected
compromised key.

---

## 7. Rate limiting and abuse prevention

### 7.1 API rate limits

The events API applies per-client rate limiting controlled by:

| Variable | Default | Description |
|---|---|---|
| `RATE_LIMIT_WINDOW_MS` | `60000` | Rolling window size in milliseconds |
| `RATE_LIMIT_MAX_REQUESTS` | `60` | Requests allowed per window |
| `RATE_LIMIT_CLIENT_OVERRIDES` | `{}` | Per-client overrides as a JSON object |

When the limit is exceeded the API responds with `429 Too Many Requests`. Retry
using exponential backoff with jitter — do not immediately retry in a tight loop.

```bash
# Example: request with rate-limit headers in response
HTTP/1.1 429 Too Many Requests
Retry-After: 30
X-RateLimit-Limit: 60
X-RateLimit-Remaining: 0
X-RateLimit-Reset: 1753000000
```

### 7.2 Webhook retry policy

Failed deliveries are retried with exponential backoff:

| Variable | Default | Description |
|---|---|---|
| `RETRY_BASE_DELAY_MS` | `5000` | Initial delay before first retry |
| `RETRY_MAX_RETRIES` | `5` | Maximum attempts |
| `RETRY_MULTIPLIER` | `2` | Backoff multiplier per attempt |
| `RETRY_MAX_DELAY_MS` | `3600000` | Maximum single delay (1 hour) |
| `RETRY_JITTER` | `true` | Adds randomness to prevent thundering-herd |

Permanent failure types (`auth_error`, `not_found`, `client_error`,
`configuration_error`) are not retried. Fix the root cause and re-send.

### 7.3 Circuit breaker

The listener's RPC circuit breaker (`CIRCUIT_BREAKER_FAILURE_THRESHOLD`, default
5 consecutive failures) will stop outbound requests to a failing RPC endpoint.
Your integration should be prepared for a temporary gap in event delivery during
a circuit-open period and reconcile state using the `GET /api/events` polling
endpoint when the circuit recovers.

---

## 8. Error handling and status codes

All error responses follow a consistent structure:

```json
{
  "error": "Validation failed: Field 'executeAt' is required",
  "code": "BAD_REQUEST",
  "issues": [
    { "field": "executeAt", "message": "Field 'executeAt' is required" }
  ],
  "requestId": "req_01JW1234ABCD"
}
```

| HTTP status | Error code | Meaning |
|---|---|---|
| `400` | `BAD_REQUEST` | Payload validation failed |
| `400` | `PARSE_ERROR` | Malformed JSON in request body |
| `401` | `AUTH_MISSING_SIGNATURE` | No `X-Webhook-Signature` header |
| `401` | `AUTH_MISSING_KEY_ID` | No `X-Webhook-Key-Id` header |
| `401` | `AUTH_UNKNOWN_KEY_ID` | Key ID not recognised |
| `401` | `AUTH_INVALID_SIGNATURE` | HMAC mismatch |
| `401` | `AUTH_TIMESTAMP_EXPIRED` | Request timestamp outside 5-minute window |
| `401` | `AUTH_MISSING_TIMESTAMP` | Timestamp required but absent |
| `403` | `INVALID_PERMISSIONS` | Credential lacks a required scope |
| `409` | `AUTH_REPLAY_DETECTED` | Duplicate signature already processed |
| `413` | `PAYLOAD_TOO_LARGE` | Request body exceeds 1 MB limit |
| `429` | `RATE_LIMIT_EXCEEDED` | Too many requests in the current window |
| `500` | `INTERNAL_ERROR` | Unexpected server error |
| `503` | `CONTRACT_PAUSED` | Contract is paused; write operations are blocked |

Always log the `requestId` from error responses. It maps directly to a listener
log entry that includes the full request context.

---

## 9. Complete integration examples

### 9.1 Polling for new events

This example shows a minimal but secure event poller. It uses `Bearer` auth,
handles rate-limit back-off, and processes only new events using a cursor.

```typescript
// event-poller.ts — example integration
// Credentials are loaded from environment variables, never hardcoded.
const API_BASE = process.env.NOTIFYCHAIN_API_URL!;
const API_KEY  = process.env.NOTIFYCHAIN_API_KEY!;  // nck_<id>_<secret>

let cursor: string | undefined;

async function pollEvents(): Promise<void> {
  const url = new URL(`${API_BASE}/api/events`);
  if (cursor) url.searchParams.set('after', cursor);

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${API_KEY}` },
  });

  if (res.status === 429) {
    const retryAfter = Number(res.headers.get('Retry-After') ?? 30);
    console.warn(`Rate limited — backing off for ${retryAfter}s`);
    await sleep(retryAfter * 1000);
    return;
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    console.error('Poll failed', { status: res.status, code: body.code, requestId: body.requestId });
    return;
  }

  const { events, nextCursor } = await res.json();
  for (const event of events) {
    await processEvent(event);
  }
  if (nextCursor) cursor = nextCursor;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function processEvent(event: unknown): Promise<void> {
  // Your business logic here
  console.log('Received event', event);
}

setInterval(pollEvents, 30_000);
```

### 9.2 Receiving webhook deliveries (Node.js / Express)

```typescript
// webhook-receiver.ts — example integration
import express, { Request, Response } from 'express';
import crypto from 'crypto';

const app = express();

// IMPORTANT: use express.raw() so the body arrives as a Buffer.
// express.json() would re-serialize and may change whitespace, invalidating the HMAC.
app.use('/webhooks/notifychain', express.raw({ type: 'application/json' }));

const WEBHOOK_SECRET = process.env.NOTIFYCHAIN_WEBHOOK_SECRET!; // from secrets manager
const MAX_AGE_SECONDS = 300;

app.post('/webhooks/notifychain', (req: Request, res: Response) => {
  const signatureHeader = req.headers['x-webhook-signature'] as string;
  const timestampHeader = req.headers['x-webhook-timestamp'] as string;
  const rawBody = req.body as Buffer;

  // 1. Verify signature before doing anything else
  if (!signatureHeader || !timestampHeader) {
    return res.status(401).json({ error: 'Missing required webhook headers' });
  }

  const now = Math.floor(Date.now() / 1000);
  const requestTime = parseInt(timestampHeader, 10);
  if (!Number.isFinite(requestTime) || Math.abs(now - requestTime) > MAX_AGE_SECONDS) {
    return res.status(401).json({ error: 'Request timestamp out of range' });
  }

  const signingInput = `${timestampHeader}.${rawBody.toString('utf8')}`;
  const expectedHex = crypto.createHmac('sha256', WEBHOOK_SECRET)
    .update(signingInput, 'utf8')
    .digest('hex');
  const expected = `sha256=${expectedHex}`;

  if (expected.length !== signatureHeader.length ||
      !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signatureHeader))) {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  // 2. Acknowledge quickly — do heavy work asynchronously
  res.status(202).end();

  // 3. Process payload safely
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch {
    console.error('Failed to parse webhook payload');
    return;
  }

  handleEvent(payload).catch(err => console.error('Event processing error', err));
});

async function handleEvent(payload: unknown): Promise<void> {
  // Your business logic here
  console.log('Processing event', payload);
}

app.listen(3000, () => console.log('Webhook receiver listening on :3000'));
```

### 9.3 Scheduling a notification via the REST API

```bash
curl -X POST https://listener.example.com/api/schedule \
  -H "Authorization: Bearer nck_<id>_<secret>" \
  -H "Content-Type: application/json" \
  -d '{
    "executeAt": "2025-08-01T09:00:00.000Z",
    "payload": {
      "message": "Your subscription renews tomorrow.",
      "type": "billing_reminder"
    },
    "targetRecipient": "GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
    "notificationType": "webhook",
    "maxRetries": 3,
    "priority": 5
  }'
```

Success response:

```json
{
  "id": "notif_01JW1234EFGH",
  "status": "scheduled",
  "executeAt": "2025-08-01T09:00:00.000Z",
  "createdAt": "2025-07-26T10:30:00.000Z"
}
```

---

## 10. Unsafe patterns to avoid

The examples below show patterns you must **not** follow. They are presented to
make the problem concrete so you can recognise them in existing code.

### Hardcoded credentials

```typescript
// ❌ UNSAFE — secret is in source control
const client = new NotifyChainClient({
  apiKey: 'nck_a3f1c09d4b7e82f1_X9kLmNpQrStUvWxYz...',
});
```

```typescript
// ✅ SAFE — secret is loaded from the environment
const client = new NotifyChainClient({
  apiKey: process.env.NOTIFYCHAIN_API_KEY!,
});
```

### Credentials in URLs

```bash
# ❌ UNSAFE — key appears in server logs, proxy logs, and browser history
GET /api/events?apiKey=nck_a3f1c09d4b7e82f1_...

# ✅ SAFE — key is in the Authorization header, which is not logged by default
GET /api/events
Authorization: Bearer nck_a3f1c09d4b7e82f1_...
```

### Skipping signature verification

```typescript
// ❌ UNSAFE — accepting any payload without verification
app.post('/webhooks/notifychain', express.json(), (req, res) => {
  processEvent(req.body);  // No signature check — attacker can send arbitrary events
  res.sendStatus(200);
});
```

### Using `===` for HMAC comparison

```typescript
// ❌ UNSAFE — timing-side-channel leaks whether the prefix matches
if (computed === received) { ... }

// ✅ SAFE — constant-time comparison
if (crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(received))) { ... }
```

### Overly broad CORS

```bash
# ❌ UNSAFE — any origin can call your listener
EVENTS_API_CORS_ORIGIN=*

# ✅ SAFE — only your dashboard origin is permitted
EVENTS_API_CORS_ORIGIN=https://dashboard.yourcompany.example.com
```

### Credential logging

```typescript
// ❌ UNSAFE — secret ends up in log files
console.log('Connecting with key', process.env.NOTIFYCHAIN_API_KEY);

// ✅ SAFE — log only the non-secret prefix
const key = process.env.NOTIFYCHAIN_API_KEY!;
const prefix = key.split('_').slice(0, 2).join('_');  // "nck_<id>" only
console.log('Connecting with key prefix', prefix);
```

### Ignoring the timestamp

```typescript
// ❌ UNSAFE — a captured request stays valid indefinitely
const signingInput = rawBody;

// ✅ SAFE — timestamp is bound to the HMAC; stale requests are rejected
const signingInput = `${timestampHeader}.${rawBody}`;
```

---

## 11. Security checklist

Use this checklist before going live with an integration.

**Credentials**
- [ ] API key is stored in a secrets manager or environment variable, not in source code.
- [ ] API key is not present in any log file or error message.
- [ ] API key scope is limited to only the operations your integration performs.
- [ ] A rotation procedure is documented and tested.

**Webhook receiver**
- [ ] Endpoint is HTTPS with a valid, non-self-signed certificate.
- [ ] Raw request body is buffered before JSON parsing.
- [ ] `X-Webhook-Signature` is verified before the payload is processed.
- [ ] Timestamp freshness is checked (±5 minutes).
- [ ] HMAC comparison uses `crypto.timingSafeEqual` or equivalent.
- [ ] Receiver responds within 10 seconds (or returns `202` immediately).
- [ ] An idempotency store prevents duplicate processing of retried deliveries.

**Network and infrastructure**
- [ ] The listener management endpoints are not exposed on a public interface.
- [ ] `EVENTS_API_CORS_ORIGIN` is set to your specific origin, not `*`.
- [ ] Inbound webhook traffic is restricted to NotifyChain's egress IPs (if known).
- [ ] TLS 1.2 or later is enforced at the reverse proxy layer.

**Operational**
- [ ] Errors from the events API are logged with the `requestId` field for correlation.
- [ ] Rate-limit `429` responses trigger exponential backoff, not immediate retries.
- [ ] A runbook exists for responding to a suspected credential compromise (revoke → rotate → audit).
- [ ] Credential rotation is scheduled at least once per quarter.

---

## Related documents

- [`ENVIRONMENT_VARIABLES_AND_SECRETS.md`](./ENVIRONMENT_VARIABLES_AND_SECRETS.md) — full variable reference for the listener service
- [`listener/.env.example`](./listener/.env.example) — annotated configuration template
- [`CONTRACT_EVENT_REFERENCE.md`](./CONTRACT_EVENT_REFERENCE.md) — Soroban contract event schemas
- [`API_CONTRACT_TESTS_SUMMARY.md`](./API_CONTRACT_TESTS_SUMMARY.md) — API contract test coverage
