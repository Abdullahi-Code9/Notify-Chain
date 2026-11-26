# Browser credential storage security model (#1207)

## Current architecture

The dashboard is wallet-driven and does not authenticate to the listener with
a browser-held bearer token. Listener requests use `X-API-Key` values that are
configured server-side; dashboard destination secrets are write-only and are
returned to the UI only as masks/last-four values. There is no cookie session
and no `Set-Cookie` endpoint.

Browser `localStorage` is restricted to non-sensitive UI state (selected wallet
id/address, RPC choice, sort and theme preferences). `walletStore.ts` now
rejects any storage key containing token/secret/credential/auth-like terms, so
future code cannot accidentally persist credentials where JavaScript can read
them. `sessionStorage` is not used.

## Rules

1. Never put API keys, bearer tokens, signing secrets or full credentials in
   `localStorage`, `sessionStorage`, indexedDB, URLs or frontend environment
   variables. The token itself is returned exactly once at creation and is not
   recoverable from list/get endpoints.
2. Prefer server-side integration keys delivered through the deployment secret
   manager. If a browser-authenticated mode is added later, use `Secure`,
   `HttpOnly`, `SameSite=Strict` cookies with CSRF protection rather than
   script-readable storage.
3. Credentials may carry an `expiresAt` ISO timestamp. `ApiCredentialService.verify`
   rejects expired credentials immediately, including on a verification-cache
   hit, and `hasActiveCredentials()` ignores them. Rotation means issuing a new
   key and revoking the old one; revocation clears the verification cache.
4. Tokens are sent only over TLS, and error responses redact credential-like
   values (`sanitizeCredentials`).

## Remaining exposure risks

- An `X-API-Key` held by a script (for example in a third-party integration)
  remains readable by that script; this is why the dashboard holds none.
- `HttpOnly` cookies are not available in the current header-auth architecture.
  Introducing them requires a login endpoint and CSRF defenses.
- `localStorage` UI state is not confidential; it must never be upgraded to
  hold credentials.
- Static `API_KEYS` in configuration have no per-key expiry. Use scoped,
  expiring `nck_...` credentials where lifetime limits are required.
