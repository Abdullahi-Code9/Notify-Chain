# API Caching, Tracing and Scoped Credentials

Covers issues #985 (ETags), #986 (correlation IDs), #987 (error codes) and
#988 (scoped credentials). Error codes are documented in
[`API_ERROR_REFERENCE.md`](../API_ERROR_REFERENCE.md).

## Conditional GET with ETags (#985)

These endpoints return a strong `ETag` (SHA-256 of the response body) and
`Cache-Control: private, no-cache`:

- `GET /api/events`, `GET /api/events/history`
- `GET /api/analytics` (not when `?reset=true`), `GET /api/analytics/history`
- `GET /api/schedule/stats`, `/execution-metrics`, `/retry-distribution`, `/retry-statistics`

Send the tag back in `If-None-Match`. If the data is unchanged the server
replies `304 Not Modified` with an empty body:

```bash
etag=$(curl -s -D - -o /dev/null localhost:8787/api/events | grep -i etag | cut -d' ' -f2 | tr -d '\r')
curl -i -H "If-None-Match: $etag" localhost:8787/api/events   # → 304
```

The tag is computed from the bytes that would be sent, so it changes as soon as
the underlying data changes; there is no separate cache to invalidate.
`W/"…"`, comma-separated lists and `*` are honoured.

## Correlation IDs (#986)

- Every response carries `X-Correlation-Id`.
- A client-supplied `X-Correlation-Id` is reused only if it is 1–64 characters
  of `[A-Za-z0-9._:-]` and starts with a letter or digit. Anything else
  (whitespace, control characters, quotes, overlong values) is replaced with a
  new UUID v4, so untrusted header content never reaches the logs.
- The ID is held in AsyncLocalStorage for the life of the request. Every
  `logger.*` call made while serving it gets `correlationId` / `requestId`
  added automatically, and error envelopes include it as `correlation_id`.
- `EventProcessingQueue` captures the ID at enqueue time and restores it when
  the job runs. For other deferred work, wrap the callback with
  `bindCorrelationContext()` from `src/utils/correlation-context.ts`.

## Scoped API Credentials (#988)

### Scopes

| Scope | Grants |
|-------|--------|
| `events:read` | Read event data (needed with `notifications:read` for `/api/export`) |
| `events:write` | Reserved for event write endpoints (none exist yet) |
| `stats:read` | Reserved for statistics endpoints (currently public) |
| `notifications:read` | `/api/notifications/history`, `/api/notifications/:id/receipts` |
| `notifications:write` | `POST /api/notifications/import` |
| `webhooks:manage` | Reserved for webhook management endpoints (none exist yet) |
| `credentials:manage` | Manage credentials via `/api/credentials` |

Static keys from the `apiKeys` config keep full access, so existing
integrations keep working. Credentials issued through the API are limited to
their scopes; a missing scope returns `403 INVALID_PERMISSIONS`.

### Managing credentials

All routes need `credentials:manage`. On a deployment with no static keys
they always return `401`, so an open dev server can't be used to create the
first credential.

```bash
# Create: the only response that ever includes apiKey
curl -X POST localhost:8787/api/credentials \
  -H "X-API-Key: $ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"name":"grafana","scopes":["stats:read","events:read"]}'
# → 201 { "success": true, "data": { "id": "…", "apiKey": "nck_<id>_<secret>", … } }

curl localhost:8787/api/credentials -H "X-API-Key: $ADMIN_KEY"            # list (no secrets)
curl localhost:8787/api/credentials/<id> -H "X-API-Key: $ADMIN_KEY"       # get (no secrets)
curl -X DELETE localhost:8787/api/credentials/<id> -H "X-API-Key: $ADMIN_KEY"  # revoke
```

A scoped caller holding `credentials:manage` can only grant scopes it already
holds.

### Secret handling

- Keys look like `nck_<16-hex id>_<43-char secret>`. The id is a lookup handle.
  The secret is 256 bits from `crypto.randomBytes`.
- Only an scrypt hash (N=16384, r=8, p=1, 16-byte per-key salt) is stored.
  Comparisons use `timingSafeEqual`, and unknown ids still do the same scrypt
  work so response timing doesn't reveal which ids exist.
- Successful verifications are cached for 60 s under a SHA-256 of the key, so
  scrypt doesn't run on every request. Revoking a key clears its cache entry
  right away.

### Limitations

- The default `InMemoryApiCredentialStore` loses credentials when the process
  restarts. For durable storage, implement `ApiCredentialStore` and pass it to
  `new ApiCredentialService({ store })`.
- Scope checks apply only to endpoints that already require authentication.
  Public read endpoints such as `GET /api/events` stay unauthenticated.
