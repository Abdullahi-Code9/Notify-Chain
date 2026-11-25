# Contract State Snapshot (issue #1201)

`get_state_snapshot() -> ContractStateSnapshot` is a read-only contract query
that returns the following stable structure in a single invocation:

| Field | Type | Meaning when absent |
| --- | --- | --- |
| `admin` | `Option<Address>` | `None` until `initialize_admin` succeeds |
| `pending_owner` | `Option<Address>` | `None` when no ownership transfer is in progress |
| `paused` | `bool` | `false` when the contract has never been paused |
| `schema_version` | `u32` | `0` when no schema version was configured |
| `notification_version` | `u32` | Current notification payload protocol version (constant) |
| `limits` | `NotificationLimits` | Documented defaults (`10_000`, 1 year, `60`, `1000`) when unconfigured |

`NotificationLimits` contains `max_payload_size`, `max_expiration_seconds`,
`min_expiration_seconds`, and `max_batch_size`.

The query writes no storage and emits no events, so repeated calls in the same
ledger state always return the same value. Tests:
`contract/contracts/hello-world/src/tests/state_snapshot_test.rs`.
