# Event Compatibility Reference Example

This example demonstrates how to introduce new event types in the NotifyChain ecosystem without breaking existing consumers (listeners, indexers, and third-party integrations).

## Overview

Event schema evolution is inevitable as the platform grows. This reference shows **backward-compatible event versioning patterns** that preserve the existing event stream while adding new capabilities.

## Core Compatibility Principle

> **Additive changes only**: New fields are appended as trailing topics or added to the data payload. Existing topic positions and data structure remain unchanged.

## What's Included

### 1. Reference Contract (`reference-contract.rs`)

A minimal Soroban contract demonstrating:
- `NotificationCreatedV1` — original event with 3 topics
- `NotificationCreatedV2` — enhanced event with an extra trailing topic

Both events are emitted side-by-side to show coexistence.

### 2. Listener Decoder (`event-decoder.ts`)

TypeScript decoder showing:
- **Graceful degradation**: consumers that only read the first 3 topics continue working unchanged
- **Progressive enhancement**: new consumers can opt into reading the 4th topic
- **Version detection**: how to distinguish v1 from v2 payloads

### 3. Event Fixtures (`fixtures/`)

- `v1-notification-created.json` — sample RPC event for v1 schema
- `v2-notification-created.json` — sample RPC event for v2 schema (with extra topic)
- `mixed-stream.json` — a realistic event stream containing both versions

### 4. Compatibility Tests (`compatibility.test.ts`)

Automated verification that:
- v1 consumers can process v2 events (ignoring the new field)
- v2 consumers can process v1 events (with sensible defaults)
- the decoder never throws on either version

## Running the Example

### Prerequisites

- Rust 1.75+ with `wasm32-unknown-unknown` target
- Node.js 18+ and npm
- Stellar CLI (`stellar` or `soroban`)

### Compile the Contract

```bash
cd reference-contract
cargo build --target wasm32-unknown-unknown --release
```

The WASM artifact is in `target/wasm32-unknown-unknown/release/event_compatibility_reference.wasm`.

### Run the Tests

```bash
cd listener-decoder
npm install
npm test
```

All tests should pass, proving that both old and new fixtures are decoded correctly.

## Compatibility Decisions Explained

### Decision 1: Trailing Topics for Indexable Fields

**Why trailing?**

Stellar RPC and most indexers match on topic positions. If you insert a new topic in the middle, existing queries break:

```rust
// ❌ BREAKS existing listeners that read topic[1] expecting `creator`
event.publish((symbol_short!("NotifV2"), priority, creator, id));

// ✅ SAFE: existing listeners still find `creator` at topic[1]
event.publish((symbol_short!("NotifV2"), creator, id, priority));
```

**Rule**: Always append new indexed fields as the **last topic**.

### Decision 2: Extend Data Payload for Complex Fields

Topics are limited to simple types (Address, Symbol, u32, BytesN). For structured data, extend the `value` map:

```rust
// v1 payload (Map)
let data_v1 = map![
    &env,
    (symbol_short!("msg"), message),
];

// v2 payload (same map + new keys)
let data_v2 = map![
    &env,
    (symbol_short!("msg"), message),
    (symbol_short!("retry"), retry_count),  // ✅ new field
];
```

Older decoders ignore unknown keys. Newer decoders check for their presence and use defaults when missing.

### Decision 3: Payload Version Field

Every versioned event carries a `payload_version` field in its data map:

```rust
let data = map![
    &env,
    (symbol_short!("version"), 2_u32),  // explicit version marker
    // ... rest of fields
];
```

**Why?**

- Lets decoders branch on schema version without guessing
- Future-proofs against incompatible changes (if you ever need v3 with a different structure)
- Aligns with Soroban's `ScVal` introspection capabilities

**Default**: Events without a `payload_version` field are treated as **v1** for backward compatibility.

### Decision 4: Event Name Stays the Same

You might be tempted to publish `NotificationCreatedV2` as a new event name. **Don't.**

```rust
// ❌ Creates a separate event stream; existing consumers miss these entirely
env.events().publish((symbol_short!("NotifV2"), ...), ...);

// ✅ Same event name; consumers see all notifications
env.events().publish((symbol_short!("NotifCrtd"), ...), ...);
```

Use the `payload_version` field to distinguish schemas within the same event name.

**Exception**: If the semantic meaning changes significantly (e.g., `GroupCreated` vs. `GroupUpdated`), use a new event name. For schema evolution of the *same* lifecycle event, keep the name.

### Decision 5: Decoder Fallback Strategy

The TypeScript decoder demonstrates **three-tier fallback**:

1. **Optimistic decode**: try parsing as the latest version
2. **Fallback to v1**: if a field is missing, use the v1 schema
3. **Validation**: reject only if *required* v1 fields are also missing

```typescript
function decodeNotificationCreated(event: RpcEvent): Notification {
  const version = event.value.payload_version ?? 1; // default to v1
  
  if (version === 2) {
    return {
      creator: event.topics[1],
      id: event.topics[2],
      priority: event.topics[3], // ✅ new field
      message: event.value.msg,
    };
  }
  
  // v1 path
  return {
    creator: event.topics[1],
    id: event.topics[2],
    priority: 'medium',  // ✅ sensible default for missing field
    message: event.value.msg,
  };
}
```

This pattern ensures:
- **Zero downtime**: deploy the contract upgrade first, then update the listener
- **Gradual rollout**: old listeners keep running while new ones are tested
- **No event loss**: the stream is continuous across the migration

## Integration with NotifyChain Listener

The NotifyChain listener already implements this pattern for all AutoShare events. See:

- `listener/src/services/event-normalization.ts` — version detection and normalization
- `listener/src/utils/event-utils.ts` — `parseEventVersion` and validation
- `CONTRACT_EVENT_REFERENCE.md` — documented schema for all event types

When adding a **new event type**:

1. Define the v1 schema in the contract
2. Emit it with `payload_version: 1` in the data map
3. Add the event name to `SUPPORTED_EVENT_NAMES` in `event-utils.ts`
4. Write a fixture in `listener/src/test-utils/notification-fixture-builder.ts`
5. Add an entry to `CONTRACT_EVENT_REFERENCE.md`

When **evolving an existing event**:

1. Increment `payload_version` to 2
2. Append new topics to the end
3. Add new keys to the data map (don't remove old ones)
4. Update the decoder to handle both versions
5. Add a v2 fixture and update the reference doc

## Testing Your Own Event Changes

Use the provided fixtures as templates:

```bash
# Test v1 compatibility
npm test -- --testNamePattern="processes v1 events"

# Test v2 compatibility
npm test -- --testNamePattern="processes v2 events"

# Test mixed stream (realistic scenario)
npm test -- --testNamePattern="handles mixed version stream"
```

Fixtures are JSON files that mirror the structure returned by `stellar rpc getEvents`. Copy `v1-notification-created.json`, modify the fields, and the test suite will validate your changes.

## Common Pitfalls

### ❌ Removing Fields

```rust
// v1
let data_v1 = map![&env, (symbol_short!("msg"), message), (symbol_short!("sender"), sender)];

// v2 — BREAKS v1 consumers expecting `sender`
let data_v2 = map![&env, (symbol_short!("msg"), message)];
```

**Fix**: Mark fields as deprecated in docs, but keep emitting them. Remove only in a major version (v3+).

### ❌ Changing Topic Order

```rust
// v1
event.publish((symbol_short!("Notif"), creator, id), data);

// v2 — BREAKS existing indexers querying topic[1] for creator
event.publish((symbol_short!("Notif"), id, creator), data);
```

**Fix**: Never reorder topics. Add new ones at the end.

### ❌ Changing Field Types

```rust
// v1: id is BytesN<32>
let id: BytesN<32> = ...;

// v2: id is String — BREAKS all existing decoders
let id: String = "notif-12345".into();
```

**Fix**: Introduce a new field name (`id_string`) and keep `id` as-is.

## Resources

- [NotifyChain Event Reference](../../CONTRACT_EVENT_REFERENCE.md) — all supported events
- [Notification Lifecycle](../../NOTIFICATION_LIFECYCLE.md) — end-to-end flow
- [Soroban Events Guide](https://soroban.stellar.org/docs/learn/events) — official docs

## License

MIT — same as the NotifyChain project.
