# SSRF Protection for Notification Destinations (issue #1205)

User-configured webhook destinations are validated at three points:

1. **Ingestion** — `NotificationAPI.scheduleNotification` calls
   `validateNotificationDestinationUrl` before persisting a schedule.
   Only `http:` and `https:` URLs are accepted; embedded credentials,
   local-only hostnames (`localhost`, `*.local`, `*.internal`) and IP literals
   in loopback/private/link-local/reserved ranges are rejected.
2. **Every outbound request** — `sendWebhook` resolves DNS and validates all
   A/AAAA records with the DNS rebinding guard immediately before delivery.
   A hostname that changes to an internal address is blocked.
3. **Every redirect hop** — redirects are followed manually (`redirect: 'manual'`)
   with the same URL and DNS checks, up to five hops. A 3xx response cannot
   bounce a request to an internal address or a non-HTTP scheme.

## Limitations

- DNS validation and the outbound request are separate operations; a fast
  rebinding attacker could still race them. Enforce outbound firewall /
  egress-proxy rules that block RFC 1918, loopback, link-local (including
  `169.254.169.254`) and IPv6 ULA addresses as an additional layer.
- Hostnames that resolve to public addresses are permitted, including public
  IP literals.
- Provider health checks using the shared `sendWebhook` path inherit the
  same protections.

Tests: `listener/src/utils/ssrf-url-validation.test.ts` and
`listener/src/services/webhook-sender-ssrf.test.ts`.
