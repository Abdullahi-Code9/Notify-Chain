# Outbound Webhook Payload Versioning

Every webhook this listener delivers carries an explicit, stable payload version
so an external consumer can identify the schema it is receiving without
introspecting the body heuristically.

- Body field: `schemaVersion` (e.g. `"1.0"`)
- Request header: `x-notifychain-payload-version` (e.g. `"1.0"`)

Both are emitted by the delivery layer
(`listener/src/services/providers/webhook-provider.ts`, via
`listener/src/utils/webhook-payload-version.ts`), so producers and consumers
agree on a single source of truth.

> Note: this is **distinct** from `version` in `notification-version.ts`, which
> versions the *internal* notification protocol stored in the database. The
> webhook contract is a separate, consumer-facing surface and therefore gets its
> own identifier.

---

## Example payload

```json
{
  "schemaVersion": "1.0",
  "eventId": "evt_123",
  "contractAddress": "CXXX...",
  "notificationType": "contract_event",
  "message": "task_created",
  "occurredAt": "2026-07-26T12:00:00.000Z"
}
```

Example request headers:

```
Content-Type: application/json
x-notifychain-payload-version: 1.0
```

---

## Compatibility rules

Versions use a `MAJOR.MINOR` scheme:

- **MAJOR** is bumped for any breaking change — a removed field, a rename, a
  change of type, or a change of meaning for an existing field. A new major
  version is **not** compatible with the previous one.
- **MINOR** is bumped for additive, backward-compatible changes (new optional
  fields, new enum members). Consumers **MUST** ignore fields they do not
  recognise, so a minor bump never breaks an existing consumer.

Consumers **MUST** reject a payload whose MAJOR version they do not support, and
**SHOULD** log-and-continue on an unknown MINOR version within a supported
MAJOR. Producers always emit the current version by default; pinning an older
supported version is allowed for a migration window.

The machine-readable registry lives in
`WEBHOOK_PAYLOAD_VERSIONS` (`listener/src/utils/webhook-payload-version.ts`).
Never mutate an existing entry's `requiredFields` in a way that removes a field —
that is a breaking change and requires a new MAJOR version.

---

## Version history

| Version | Status | Released   | Required fields          |
|---------|--------|------------|--------------------------|
| `1.0`   | active | 2026-07-26 | `schemaVersion`          |

---

## Consumer guidance

1. Read `x-notifychain-payload-version` (or the body's `schemaVersion`, which
   always match).
2. Split on `.` and check the MAJOR component is one you support.
3. Ignore unknown fields — they are the mechanism by which MINOR versions stay
   backward-compatible.

Regression protection: `listener/src/utils/webhook-payload-version.test.ts`
pins representative payloads across versions, and
`listener/src/services/providers/webhook-provider.test.ts` asserts that every
delivered payload is stamped before it leaves the process.
