# Session Lifecycle and Expiration Policy (#1140)

This document defines how dashboard sessions are created, validated, expired,
and revoked in the Notify-Chain listener service.

---

## Overview

Sessions are short-lived tokens that tie a client HTTP request to a specific
API credential.  They are distinct from the credential itself: a credential
can be long-lived (or even permanent), whereas a session expires after a
configured TTL so that compromised tokens have a bounded effective window.

---

## Token Format

```
ncs_<43-char base64url random secret>
```

- Prefix `ncs` identifies this as a Notify-Chain Session token.
- The secret is 32 random bytes encoded as base64url (43 characters).

Tokens are opaque to callers.  Do not parse their structure.

---

## Session States

```
           create()
              │
              ▼
           ACTIVE
        (valid, not revoked,
          expiresAt in future)
            │      │
      TTL elapsed  revoke() / revokeByCredential()
            │      │
            ▼      ▼
         EXPIRED  REVOKED
         (auto-revoked on first
          detection; identical
          terminal state)
```

| State   | `validate()` result | Reason          |
|---------|---------------------|-----------------|
| Active  | `valid: true`       | —               |
| Expired | `valid: false`      | `'expired'`     |
| Revoked | `valid: false`      | `'revoked'`     |
| Unknown | `valid: false`      | `'missing'`     |

---

## Expiration Policy

- Default TTL: **1 hour** (`SESSION_TTL_MS = 3 600 000 ms`).
- The TTL is configured at `SessionManager` construction time.
- Expiry is enforced **server-side on every access** via `SessionManager.validate()`.
  Clients do not control or extend the TTL.
- On first detection of expiry, the session is **automatically revoked** so
  subsequent accesses return `revoked` rather than `expired`; this ensures
  the terminal state is always consistent.

---

## Revocation

### Single session

```ts
sessionManager.revoke(sessionId);
```

- Sets `revokedAt` to the current wall-clock time.
- Idempotent: a second call keeps the original `revokedAt` timestamp.
- Subsequent `validate()` calls return `{ valid: false, reason: 'revoked' }`.

### All sessions for a credential

```ts
sessionManager.revokeByCredential(credentialId);
```

This is the **documented invalidation behavior** that must be triggered
whenever a credential is rotated or deleted.  It revokes every active
session that was minted from that credential.

Callers responsible for triggering this:
- `ApiCredentialService.revoke(id)` — the service layer should call
  `sessionManager.revokeByCredential(id)` after revoking the credential.
- Credential rotation (delete + re-create) — call `revokeByCredential`
  on the old credential id before issuing the new one.

---

## HTTP Authentication

### Request header

```
Authorization: Session ncs_<token>
```

Fallback (for clients that cannot set `Authorization`):

```
X-Session-Token: ncs_<token>
```

### Response on failure

All session-validation failures return `401 Unauthorized` with:

| Failure | `error.code`   | `error.message`                               |
|---------|----------------|-----------------------------------------------|
| Missing | `UNAUTHORIZED` | `Unauthorized: session not found or invalid`  |
| Expired | `UNAUTHORIZED` | `Unauthorized: session has expired`           |
| Revoked | `UNAUTHORIZED` | `Unauthorized: session has been revoked`      |

The `WWW-Authenticate` response header is set to:

```
WWW-Authenticate: Session realm="Notify-Chain"
```

---

## Implementation Reference

| File | Purpose |
|------|---------|
| `listener/src/services/session-manager.ts` | Core lifecycle — create, validate, revoke, purge |
| `listener/src/middleware/session-auth.ts` | HTTP gate — `requireValidSession()` helper |
| `listener/src/services/session-manager.test.ts` | Unit tests covering all states |

---

## Security Notes

- Session tokens are generated with `crypto.randomBytes(32)` (256-bit entropy).
- Tokens are never logged: the logger's redaction engine treats `sessionid`
  and `session_id` as sensitive keys and replaces their values with `[REDACTED]`.
- Credential revocation propagates to sessions atomically within a single
  `SessionManager` instance.  In a multi-process deployment, the
  `SessionStore` must be backed by a shared store (Redis, database) so
  revocations are visible across all instances.
- Expired sessions are auto-revoked rather than deleted so that audit queries
  can distinguish "never existed" from "existed but expired".
