# Contract Event Schema Versioning

Issue: #1122

Every event the AutoShare contract emits has an explicit **event schema
version**. Consumers (the listener, indexers, dashboards) use it to tell event
shapes apart and to branch on them safely.

## How the version is carried

The version is encoded in the event name, which is always `topic[0]`:

| Event name (`topic[0]`)       | Schema version |
| ----------------------------- | -------------- |
| `contract_paused`             | v1             |
| `notification_scheduled`      | v1             |
| `notification_scheduled_v2`   | v2             |

* A name **without** a version suffix is **v1**. Every event emitted today is
  v1, so existing listeners and indexers keep working byte for byte. No topic
  or payload moved.
* A name **with** a `_v<N>` suffix (`N` ≥ 2, no leading zero) is **vN**.

The contract also exposes the current version through a read-only view:

```text
get_event_schema_version() -> u32   // currently 1
```

It is defined by `EVENT_SCHEMA_VERSION` in
`contract/contracts/hello-world/src/base/events.rs`.

The event schema version is separate from the *notification payload* schema
version (`set_schema_version` / `get_schema_version`). That one versions
stored notification payloads, not event shapes.

### Why the name and not an extra topic

Consumers locate topics by position, counting from both the start (name,
actor) and the end (category is second to last, priority is last). Adding a
version topic would shift those positions and break existing listeners.
Putting the version in the name changes nothing for v1 events, and the
version stays readable without decoding the payload.

## Versioning rules

**Backward-compatible changes keep the current version:**

* adding a new event type;
* adding a key to a map-format (`#[contractevent]` / `data_format = "map"`)
  payload. Consumers must ignore keys they do not know.

**Breaking changes MUST ship as a new versioned event name** and bump
`EVENT_SCHEMA_VERSION`:

* adding, removing or reordering topics;
* removing or renaming payload fields, or changing a field's type;
* changing the type of a single-value payload.

## Migration expectations

1. When a breaking version ships, the contract emits the previous version
   alongside the new one (dual emission) for at least one release.
2. The deprecation and the release that stops emitting the old version are
   recorded in this file and in `CHANGELOG.md`.
3. Consumers add the new version to their supported set before the old
   version stops being emitted.

## Consumer guarantees (listener)

* `listener/src/utils/event-schema-version.ts` parses the version
  (`parseEventSchemaVersion`). It never throws: a missing name falls back to
  v1.
* Normalized events carry `eventSchemaVersion` and `baseEventName` (the name
  without the suffix), so decoders can branch on `baseEventName` plus version.
* `SUPPORTED_EVENT_SCHEMA_VERSIONS` lists the versions the listener can
  process (currently `{1}`). It must be kept in sync with
  `EVENT_SCHEMA_VERSION`.
* An event with an unsupported version is logged and skipped rather than
  mis-decoded. It is **not** recorded as processed, so re-scanning the ledger
  range after upgrading the listener still delivers it.

## Changelog

| Version | Status  | Notes                                            |
| ------- | ------- | ------------------------------------------------ |
| v1      | Current | All events. Unsuffixed names, existing layouts.  |
