# Inbound Webhook Signature Verification

Applies to `POST /api/webhooks` in the listener (`listener/src/api/events-server.ts`).

Every inbound webhook is authenticated with an HMAC-SHA256 signature before its
body is parsed or acted on. Requests that fail authentication are rejected and
never reach the notification pipeline.

---

## Required headers

| Header              | Required | Description                                                        |
|---------------------|----------|--------------------------------------------------------------------|
| `X-Webhook-Key-Id`  | Yes      | Identifies which entry of `WEBHOOK_SECRETS` signed the request.     |
| `X-Webhook-Timestamp` | Yes    | Unix time in **whole seconds**, used to bind and age-limit the HMAC. |
| `X-Webhook-Signature` | Yes    | `sha256=<hex digest>` of the signing input.                         |

`Idempotency-Key` is optional. Signature verification and replay protection do
not depend on it — see [Replay protection](#replay-protection).

---

## Signing scheme

```
signingInput = "<timestamp>" + "." + <raw request body>
signature    = "sha256=" + hex( HMAC-SHA256( signingInput, secret ) )
```

The HMAC is computed over the **raw** request body, so the sender must sign the
exact bytes it transmits. Re-serializing JSON before signing will produce a
different digest and the request will be rejected.

The timestamp is part of the signed material, not merely metadata. This matters:
if the timestamp were only checked separately, an attacker could capture a valid
request, delete the `X-Webhook-Timestamp` header, and have the server fall back
to verifying the HMAC over the bare body. Because the timestamp is inside the
HMAC, removing or altering it breaks the digest and the request is rejected.

### Signing example (Node.js)

```js
import crypto from 'crypto';

const secret = 'whsec_...';                       // WEBHOOK_SECRETS[i].secret
const rawBody = JSON.stringify({ event: 'transfer' });
const timestamp = String(Math.floor(Date.now() / 1000));

const signature =
  'sha256=' +
  crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`, 'utf8')
    .digest('hex');

await fetch('http://localhost:8787/api/webhooks', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-Webhook-Key-Id': 'key-alpha',
    'X-Webhook-Timestamp': timestamp,
    'X-Webhook-Signature': signature,
  },
  body: rawBody,
});
```

`computeWebhookSignature(payload, secret, timestamp)` in
`listener/src/services/webhook-verifier.ts` implements the same computation and
is convenient for sender-side tooling and tests.

---

## Replay protection

A captured request is only dangerous if it can be resubmitted. Three layers
defend against that:

1. **Timestamp binding (cryptographic).** The timestamp is signed, so it cannot
   be swapped, and requests older than the freshness window are rejected with
   `AUTH_TIMESTAMP_EXPIRED`. Replaying a captured request after the window has
   elapsed fails.

2. **Timestamp requiredness.** `X-Webhook-Timestamp` is mandatory by default. A
   request without one is rejected with `AUTH_MISSING_TIMESTAMP`. This is what
   keeps layer 1 from being bypassed: without a timestamp there is nothing to
   age out, and a bare-body signature would otherwise stay valid indefinitely.

3. **Replay cache (`listener/src/services/webhook-replay-cache.ts`).** Once a
   request authenticates, its `(keyId, signature)` pair is recorded for the same
   duration as the freshness window. A second submission of the byte-identical
   request is rejected with `409 AUTH_REPLAY_DETECTED`, even inside a fresh
   window and even though the request is perfectly valid.

Layer 3 is deliberately independent of the optional `Idempotency-Key` header.
That header is only useful when the sender chooses to send one, so an attacker
replaying a captured request simply omits it and any server-side lookup keyed on
it is skipped. The replay cache keys on the signature the server has *already
validated*, so it needs no cooperation from the sender.

Because the signature is computed over `timestamp + "." + body`, a given
signature pins down both the body and the timestamp. Two requests carrying the
same signature under the same key are by definition the same request, not two
legitimate-but-identical deliveries — which is what makes the cache safe.

Invalid signatures are never written to the cache, so a flood of forged requests
cannot evict or poison legitimate entries.

---

## Rejection responses

All authentication failures return a JSON body of the shape
`{ "success": false, "error": { "code", "message" }, "code" }`.

| Code                          | Status | Cause                                                        |
|-------------------------------|--------|--------------------------------------------------------------|
| `AUTH_MISSING_SIGNATURE`      | 401    | `X-Webhook-Signature` absent.                                 |
| `AUTH_MISSING_KEY_ID`         | 401    | `X-Webhook-Key-Id` absent.                                    |
| `AUTH_UNKNOWN_KEY_ID`         | 401    | `X-Webhook-Key-Id` matches no configured secret.              |
| `AUTH_MISSING_TIMESTAMP`      | 401    | `X-Webhook-Timestamp` absent while it is required.            |
| `AUTH_INVALID_SIGNATURE_FORMAT` | 401  | Signature is not prefixed `sha256=`.                          |
| `AUTH_INVALID_SIGNATURE`      | 401    | Digest mismatch, or wrong length — including tampered bodies. |
| `AUTH_TIMESTAMP_EXPIRED`      | 401    | Timestamp outside the window, or not a bare integer.          |
| `AUTH_REPLAY_DETECTED`        | 409    | This exact request was already accepted.                      |

Message text is kept deliberately generic for the invalid-signature cases so the
response does not tell an attacker which check failed. Detailed reasons are
written to the structured log instead, carrying `requestId`, `correlationId`,
`keyId` and `sourceIp` for audit.

---

## Configuration

| Variable      | Default | Purpose                                                   |
|---------------|---------|-----------------------------------------------------------|
| `WEBHOOK_SECRETS` | `[]` | JSON array of `{ "id", "secret" }` entries.               |

Server-side knobs live on `EventsServerOptions`:

| Option                            | Default | Purpose                                                        |
|-----------------------------------|---------|----------------------------------------------------------------|
| `signatureExpirationSeconds`       | `300`   | Freshness window in seconds.                                    |
| `requireWebhookTimestamp`         | `true`  | Reject timestamp-less requests. Set `false` only for legacy senders that cannot be updated. |
| `webhookReplayCacheMaxEntries`    | `10000` | Upper bound on retained signatures.                             |

> **Note:** with `requireWebhookTimestamp: false` a timestamp-less request is
> signed over the bare body and remains valid forever, because there is no age
> information to expire it. Only use this for senders you cannot change, and
> treat it as a temporary measure.

---

## Comparison safety

Digests are compared with `crypto.timingSafeEqual`, which throws on
length-mismatched buffers; the length is therefore checked first and a mismatch
short-circuits to a rejection.

Hex digests are compared case-insensitively (both the `sha256=` prefix and the
digest body), since hex encoding is case-insensitive by definition and some
senders emit uppercase. This is not a weakening: the digest is still compared in
constant time, and altering any hex character still fails the comparison.
