# Idempotency Keys for Event-Management Mutations

Issue: #1114

State-changing endpoints accept an optional `Idempotency-Key` header. A
client that retries a request with the same key (after a timeout or a dropped
connection, for example) gets the original result back instead of having the
mutation applied twice.

Clients that do **not** send the header are unaffected: they get the same
status codes and bodies as before.

## Eligible endpoints

| Endpoint                                         | Store                  |
| ------------------------------------------------ | ---------------------- |
| `POST /api/schedule`                             | `idempotency_keys`     |
| `POST /api/schedule/:id/cancel`                  | `api_idempotency_keys` |
| `POST /api/notifications/:id/cancel` (legacy)    | `api_idempotency_keys` |
| `POST /api/webhooks`                             | `api_idempotency_keys` |

`POST /api/schedule` keeps its existing store, which links the key to the
notification it created. The other endpoints create no notification row, so
they use the generic `api_idempotency_keys` store.

## Usage

```http
POST /api/schedule/42/cancel
Idempotency-Key: 6f1c2a9e-cancel-42
Content-Type: application/json

{"reason":"duplicate"}
```

* **Key format:** 1–255 printable ASCII characters, no spaces. A UUID per
  logical operation is recommended. An invalid key returns
  `400 IDEMPOTENCY_KEY_INVALID`.
* **Scope:** keys are scoped per client: a hash of the `X-API-Key` value, or
  `anonymous`. Webhooks are scoped per signing key id. Two clients can use the
  same key without colliding. Raw API keys are never stored.

## Behaviour

The server stores a **request fingerprint**: SHA-256 over the HTTP method,
the path and the canonical JSON body. Object keys are sorted, so key order
does not matter. The fingerprint is stored together with the response and an
expiry time.

| Situation                                              | Result                                                      |
| ------------------------------------------------------ | ----------------------------------------------------------- |
| First request with a key                               | Handler runs; response stored. `Idempotent-Replayed: false` |
| Same key, same fingerprint, before expiry              | Stored status + body replayed; handler **not** run. `Idempotent-Replayed: true` |
| Same key, different body/method/path, before expiry    | `409 IDEMPOTENCY_KEY_MISMATCH`; handler not run              |
| Same key while the first request is still running      | `409 IDEMPOTENCY_REQUEST_IN_PROGRESS`, `Retry-After: 1`      |
| Handler returned 5xx or threw                          | Nothing stored; the same key may be retried                  |
| Key used after expiry                                  | Treated as new: may be reused with any request               |
| Idempotency store unavailable                          | `503 IDEMPOTENCY_UNAVAILABLE` (fails closed)                 |

`X-Idempotent-Replay` is also sent, with the same value as
`Idempotent-Replayed`, for compatibility with existing clients of
`POST /api/schedule`.

Responses with status codes below 500 are stored, including 4xx results such
as `404` or `409 already_final`, so a retry sees the same answer. Malformed
JSON is rejected before the key is consumed.

`POST /api/webhooks` keeps its previous replay format: `202` on the first
request, then `200` with `"replay": true` on retries.

## Expiration policy

* **TTL:** 24 hours from completion by default. Configure it with
  `IDEMPOTENCY_KEY_TTL_SECONDS`.
* **In-progress lease:** 60 seconds. If a process dies mid-request, the key is
  released after the lease instead of staying locked for the full TTL.
* An expired key is released the next time it is used, and periodic cleanup
  deletes expired rows (`purgeExpired` / `cleanupExpiredKeys`).
* `POST /api/schedule` follows the same rule: once its record expires, the key
  is released and may be reused with a different body.

## Implementation

* `listener/src/services/api-idempotency-service.ts`: policy, fingerprinting,
  SQLite and in-memory stores.
* `listener/src/services/idempotency-key-service.ts`: notification-creation
  store used by `POST /api/schedule`.
* Concurrency: the `UNIQUE (scope, idempotency_key)` constraint decides
  between concurrent first requests. Exactly one claims the key and the others
  get `IDEMPOTENCY_REQUEST_IN_PROGRESS`.
