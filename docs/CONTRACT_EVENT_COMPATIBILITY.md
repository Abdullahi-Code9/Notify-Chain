# Contract Event Compatibility Schema v1 (issue #1203)

The contract tests in `contract/contracts/hello-world/src/tests/event_compatibility_test.rs`
pin the following event schemas. An event name, topic count, topic order, or
required data field change is a breaking change and must be reviewed by
off-chain consumers.

All events have the event name as topic 0. Category and priority are trailing
topics so consumers can filter without decoding the payload.

| Event | Topics after name | Payload |
| --- | --- | --- |
| `notification_scheduled` | creator, category (`Notification`), priority | map: `notification_id: BytesN<32>`, `payload_version: u32` (v1) |
| `contract_paused` | admin, category (`Admin`), priority (`High`) | unit |
| `admin_transferred` | old_admin, category (`Admin`), priority (`Critical`) | `new_admin: Address` |
| `nonce_consumed` | signer, operation | `nonce: u64` |

Failed operations revert their events. The compatibility tests assert that a
rejected nonce-protected pause publishes no `contract_paused` or
`nonce_consumed` event and leaves contract state unchanged.
