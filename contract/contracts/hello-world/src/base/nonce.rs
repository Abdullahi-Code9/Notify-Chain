//! Operation-scoped nonces for replay protection — issue #1126.
//!
//! Every nonce-protected entry point takes a `(nonce, contract, valid_until)`
//! triple alongside its normal arguments. Because Soroban's `require_auth`
//! signs over the full argument list of the invoked function, the signer's
//! authorization is cryptographically bound to:
//!
//! * the **operation** (the function being invoked, mirrored by
//!   [`NonceOperation`] in storage),
//! * the **contract** (the `contract` argument must equal the executing
//!   contract's own address),
//! * the **nonce** (must equal the signer's next expected nonce for that
//!   operation), and
//! * a **freshness deadline** (`valid_until`, a ledger timestamp).
//!
//! Nonces are sequential per `(signer, operation)` pair. Once consumed, a
//! [`NonceRecord`] is persisted so replays are rejected deterministically and
//! consumed nonces remain auditable.
use soroban_sdk::{contractevent, contracttype, Address};

/// Upper bound (seconds) on how far into the future `valid_until` may be set.
///
/// Bounding the window keeps signed authorizations short-lived so that a
/// leaked-but-unsubmitted authorization cannot be held indefinitely.
pub const MAX_NONCE_VALIDITY_SECONDS: u64 = 86_400;

/// The authorized operations that participate in nonce-based replay
/// protection. Nonce sequences are independent per operation, so a nonce
/// signed for one operation can never be used for another.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum NonceOperation {
    /// `pause_with_nonce`.
    Pause = 0,
    /// `unpause_with_nonce`.
    Unpause = 1,
    /// `transfer_admin_with_nonce`.
    TransferAdmin = 2,
    /// `revoke_notification_with_nonce`.
    RevokeNotification = 3,
}

/// Persisted record of a consumed nonce.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NonceRecord {
    /// Address whose authorization consumed the nonce.
    pub signer: Address,
    /// Operation the nonce was bound to.
    pub operation: NonceOperation,
    /// The consumed nonce value.
    pub nonce: u64,
    /// Contract the nonce was bound to (always the executing contract).
    pub contract: Address,
    /// Ledger timestamp when the nonce was consumed.
    pub consumed_at: u64,
    /// Freshness deadline that accompanied the authorization.
    pub valid_until: u64,
}

/// Storage keys for nonce tracking.
#[contracttype]
#[derive(Clone)]
pub enum NonceKey {
    /// Next expected nonce for `(signer, operation)`.
    Next(Address, NonceOperation),
    /// Consumed nonce record for `(signer, operation, nonce)`.
    Consumed(Address, NonceOperation, u64),
}

/// Emitted whenever a nonce is consumed by a protected operation.
#[contractevent]
#[derive(Clone)]
pub struct NonceConsumed {
    #[topic]
    pub signer: Address,
    #[topic]
    pub operation: NonceOperation,
    pub nonce: u64,
}
