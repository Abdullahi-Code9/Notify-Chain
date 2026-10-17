/// Idempotency records for caller-supplied notification delivery requests.
///
/// A delivery request is uniquely identified by a caller-supplied
/// `idempotency_key`. The first successful submission persists an
/// [`IdempotencyRecord`]; any later submission carrying the same key observes
/// the recorded outcome instead of creating a duplicate delivery.
use soroban_sdk::{contracttype, Address, BytesN, String};

// ============================================================================
// Types
// ============================================================================

/// Persisted idempotency record for a notification delivery request.
///
/// A delivery request is uniquely identified by the caller-supplied
/// `idempotency_key`. The first successful submission stores this record; any
/// subsequent submission with the same key returns the recorded outcome
/// instead of creating a duplicate delivery.
///
/// # Field ordering (storage optimization — issue #371)
///
/// Fixed-width fields are grouped before the variable-length `result` string:
///
/// 1. Identity    — `key` (BytesN<32>), `notification_id` (BytesN<32>)
/// 2. Ownership   — `submitter` (Address)
/// 3. Scalars     — `created_at` (u64), `delivered` (bool)
/// 4. Variable    — `result` (String)
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct IdempotencyRecord {
    /// Caller-supplied idempotency key uniquely identifying the request.
    pub key: BytesN<32>,
    /// Notification identifier the delivery request targeted.
    pub notification_id: BytesN<32>,
    /// Address that submitted the original delivery request.
    pub submitter: Address,
    /// Ledger timestamp (seconds) when the record was first persisted.
    pub created_at: u64,
    /// Whether the original delivery request completed successfully.
    pub delivered: bool,
    /// Opaque result payload returned to duplicate callers verbatim.
    pub result: String,
}

// ============================================================================
// Storage keys
// ============================================================================

#[contracttype]
#[derive(Clone)]
pub enum IdempotencyKey {
    /// Delivery idempotency record keyed by the caller-supplied key.
    Record(BytesN<32>),
}
