# Stellar Event Decoding and Interpretation Cookbook

This guide shows how to retrieve and interpret Soroban contract events using
Stellar RPC and the Stellar JavaScript SDK used by NotifyChain
(`@stellar/stellar-sdk` 15.x). It complements the
[contract event reference](CONTRACT_EVENT_REFERENCE.md), which lists the
NotifyChain event names and fields.

## 1. What an RPC event contains

`getEvents` returns an event envelope with ledger and transaction context, an
ordered `topic` array, and one `value`. In the default base64 XDR format, each
topic and the value are serialized `ScVal`s.

```json
{
  "type": "contract",
  "ledger": 123456,
  "ledgerClosedAt": "2025-01-02T03:04:05Z",
  "contractId": "C...contract-address",
  "id": "0000000000000123456-0000000001",
  "transactionIndex": 2,
  "operationIndex": 0,
  "txHash": "...transaction-hash...",
  "topic": ["...base64 ScVal...", "...base64 ScVal..."],
  "value": "...base64 ScVal...",
  "cursor": "...opaque paging cursor..."
}
```

The abbreviated values above are placeholders, not valid XDR. The fields have
different purposes:

| Field | Interpretation |
|---|---|
| `type` | Event emission type, commonly `contract` for contract events. |
| `ledger`, `ledgerClosedAt` | Ledger sequence and its close time. |
| `contractId` | Contract address that emitted the event. |
| `id` | Unique event identifier. Use it to deduplicate RPC results. |
| `transactionIndex`, `operationIndex` | Position of the transaction and operation in the ledger. |
| `txHash` | Transaction that caused the event; multiple events may share it. |
| `topic` | Ordered indexed `ScVal`s used for event identity and filtering. |
| `value` | Event payload as one serialized `ScVal`. |
| `cursor` | Opaque continuation token; persist and return it unchanged. |

Do not treat the transaction hash as an event identifier, infer event order
from timestamps alone, or parse the opaque cursor as a ledger number.

## 2. Decode raw JSON-RPC XDR

The raw RPC JSON uses base64 strings. Decode each string as an XDR `ScVal`
before interpreting it; base64 decoding alone only produces binary XDR.

```typescript
import { scValToNative, xdr } from '@stellar/stellar-sdk';

function decodeScValBase64(encoded: string): unknown {
  return scValToNative(xdr.ScVal.fromXDR(encoded, 'base64'));
}

function decodeRawEvent(event: {
  id: string;
  contractId: string;
  ledger: number;
  txHash: string;
  topic: string[];
  value: string;
}) {
  const topics = event.topic.map(decodeScValBase64);
  const data = decodeScValBase64(event.value);

  return {
    id: event.id,
    contractId: event.contractId,
    ledger: event.ledger,
    txHash: event.txHash,
    topics,
    data,
  };
}
```

For example, the topic list for the `AutoshareCreated` contract event is
ordered by the event definition in
[`base/events.rs`](contract/contracts/hello-world/src/base/events.rs):

1. Event name symbol (`autoshare_created`).
2. `creator` address.
3. `category` enum value.
4. `priority` enum value.

Its payload is the `id` (`BytesN<32>`). The actual XDR representation of
addresses, enums, byte arrays, and struct payloads is type-dependent. Decode
with the SDK or generated contract bindings; do not assume every value is a
string, integer, or JSON object.

## 3. Decode events returned by the JavaScript SDK

When using `rpc.Server.getEvents`, the SDK exposes the topic and value as
`ScVal` objects. Pass those objects directly to `scValToNative`; do not decode
their base64 representation a second time.

```typescript
import { rpc, scValToNative } from '@stellar/stellar-sdk';

const rpcUrl = process.env.STELLAR_RPC_URL;
const contractId = process.env.CONTRACT_ID;
const startLedger = Number(process.env.START_LEDGER);

if (!rpcUrl || !contractId || !Number.isSafeInteger(startLedger) || startLedger < 1) {
  throw new Error('Set STELLAR_RPC_URL, CONTRACT_ID, and a positive START_LEDGER');
}

const server = new rpc.Server(rpcUrl);
const page = await server.getEvents({
  startLedger,
  filters: [{ type: 'contract', contractIds: [contractId] }],
  limit: 100,
});

for (const event of page.events) {
  console.log({
    id: event.id,
    ledger: event.ledger,
    ledgerClosedAt: event.ledgerClosedAt,
    contractId: event.contractId,
    txHash: event.txHash,
    transactionIndex: event.transactionIndex,
    operationIndex: event.operationIndex,
    topics: event.topic.map((topic) => scValToNative(topic)),
    data: scValToNative(event.value),
    cursor: event.cursor,
  });
}
```

Run this from the `listener` directory after dependencies are installed. Set
the RPC URL and contract address for the intended network. `startLedger` is
inclusive. To retrieve a bounded interval, add `endLedger` (exclusive) to the
first request. To continue pagination, send the last event's `cursor` in a
subsequent request and omit `startLedger`/`endLedger`; keep the cursor opaque.
The RPC response also reports the current `oldestLedger` and `latestLedger`.
History is bounded by the server's retention policy, so a request older than
`oldestLedger` may fail.

## 4. Event-name filters and topic interpretation

For NotifyChain AutoShare events, topic zero is the event-name symbol. The
remaining indexed fields follow the order of the `#[topic]` fields in the
contract event definition. Payload fields are encoded in `value`, not appended
to `topic`.

For example, an AutoShare event can be interpreted by first decoding topic
zero, then selecting the matching event definition from
[the event reference](CONTRACT_EVENT_REFERENCE.md), then decoding the remaining
topics and payload according to those declared types. Do not assign fixed
indices to category or priority across every contract event: events may have
different primary keys and topic counts. TaskBounty events have their own
topic layouts and are documented separately in the event reference.

RPC topic filters use base64-encoded `ScVal` values, not the human-readable
strings returned by `scValToNative`. The RPC supports `*` for one topic segment
and a final `**` for zero or more remaining segments. Generate filter values
from XDR with the SDK rather than hand-writing base64.

## 5. Ledger and transaction context

- Events from the same transaction share `txHash`; use `id` to distinguish
  separate events.
- `ledger` places the event in chain history. Multiple transactions and
  operations can emit events in a single ledger.
- `transactionIndex` and `operationIndex` locate the originating transaction
  and operation; they are not substitutes for the event ID.
- `ledgerClosedAt` is the ledger close timestamp, not necessarily the time a
  listener received or persisted the event.
- `cursor` is for pagination and resumption. Persist it per stream and pass it
  back unchanged.

## 6. Common decoding mistakes

| Mistake | Correct approach |
|---|---|
| Treating base64 as readable text | Parse it as XDR `ScVal`, then use `scValToNative`. |
| Decoding SDK-returned `ScVal`s as base64 again | Use `scValToNative` directly on the SDK objects. |
| Assuming topic zero is the payload | Topic zero identifies the event; decode `value` for event data. |
| Assuming all trailing topics have the same indices | Read the specific contract event definition and its `#[topic]` field order. |
| Using `txHash` to deduplicate events | Use the RPC event `id` (scoped by contract when persisting across streams). |
| Treating a cursor as a ledger sequence | Store and replay the cursor unchanged; use ledger fields for ledger comparisons. |
| Reading beyond available RPC history | Check `oldestLedger`/`latestLedger` from RPC health or the `getEvents` response and use an archival source when necessary. |
| Assuming every decoded value is a JavaScript primitive | Respect the contract type; structs, byte arrays, addresses, and enums may need type-aware handling. |

