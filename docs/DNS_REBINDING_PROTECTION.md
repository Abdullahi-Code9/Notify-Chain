# Outbound webhook DNS rebinding protection (#1206)

`sendWebhook` resolves and validates every destination immediately before each
connection. All A and AAAA records must pass the private/reserved address policy
in `listener/src/services/dns-rebinding-guard.ts`; IP literals are validated
directly. A destination that resolves to a private address is rejected with
`DnsRebindingError` before any bytes are sent.

Redirects are not followed by the HTTP client. The application uses
`redirect: 'manual'`, resolves the `Location` target relative to the current
URL, and independently re-runs DNS resolution and address validation on that
target before connecting. This prevents a public initial destination from
silently redirecting to an internal service, and prevents a DNS change between
hops from bypassing validation. At most three redirects are followed.

The DNS resolver is injectable so tests can simulate changing records. The
delivery service treats `DnsRebindingError` as a permanent, non-retryable
failure: retrying the same URL cannot make a private resolution safe.
