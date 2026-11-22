//! Nonce-based replay protection for authorized operations — issue #1126.
//!
//! See [`crate::base::nonce`] for the binding model. This module owns the
//! validation and persistence of consumed nonces.
use crate::base::clock::current_time;
use crate::base::errors::Error;
use crate::base::nonce::{
    NonceConsumed, NonceKey, NonceOperation, NonceRecord, MAX_NONCE_VALIDITY_SECONDS,
};
use soroban_sdk::{Address, Env};

/// Returns the next nonce `signer` must use for `operation`.
pub fn get_next_nonce(env: &Env, signer: &Address, operation: NonceOperation) -> u64 {
    env.storage()
        .persistent()
        .get(&NonceKey::Next(signer.clone(), operation))
        .unwrap_or(0)
}

/// Returns whether `nonce` has already been consumed by `signer` for `operation`.
pub fn is_nonce_consumed(
    env: &Env,
    signer: &Address,
    operation: NonceOperation,
    nonce: u64,
) -> bool {
    env.storage()
        .persistent()
        .has(&NonceKey::Consumed(signer.clone(), operation, nonce))
}

/// Returns the consumed-nonce record, if any.
pub fn get_nonce_record(
    env: &Env,
    signer: &Address,
    operation: NonceOperation,
    nonce: u64,
) -> Option<NonceRecord> {
    env.storage()
        .persistent()
        .get(&NonceKey::Consumed(signer.clone(), operation, nonce))
}

/// Validates and consumes a nonce for `(signer, operation)`.
///
/// Validation order (first failure wins):
/// 1. `contract` must be the executing contract → [`Error::NonceContractMismatch`].
/// 2. `valid_until` must not be in the past → [`Error::NonceExpired`].
/// 3. `valid_until` must not exceed `now + MAX_NONCE_VALIDITY_SECONDS`
///    → [`Error::InvalidNonce`].
/// 4. A previously consumed (or lower-than-expected) nonce → [`Error::NonceAlreadyUsed`].
/// 5. A nonce ahead of the expected sequence → [`Error::InvalidNonce`].
///
/// The caller is responsible for authenticating `signer` (protected entry
/// points call the underlying logic, which invokes `require_auth`). All
/// writes performed here are rolled back if the surrounding invocation fails,
/// so a nonce is only consumed when the protected operation succeeds.
pub fn consume_nonce(
    env: &Env,
    signer: &Address,
    operation: NonceOperation,
    nonce: u64,
    contract: &Address,
    valid_until: u64,
) -> Result<(), Error> {
    if *contract != env.current_contract_address() {
        return Err(Error::NonceContractMismatch);
    }

    let now = current_time(env);
    if valid_until < now {
        return Err(Error::NonceExpired);
    }
    if valid_until > now.saturating_add(MAX_NONCE_VALIDITY_SECONDS) {
        return Err(Error::InvalidNonce);
    }

    let expected = get_next_nonce(env, signer, operation);
    if nonce < expected || is_nonce_consumed(env, signer, operation, nonce) {
        return Err(Error::NonceAlreadyUsed);
    }
    if nonce != expected {
        return Err(Error::InvalidNonce);
    }

    let next = expected.checked_add(1).ok_or(Error::InvalidNonce)?;
    let storage = env.storage().persistent();
    storage.set(&NonceKey::Next(signer.clone(), operation), &next);
    storage.set(
        &NonceKey::Consumed(signer.clone(), operation, nonce),
        &NonceRecord {
            signer: signer.clone(),
            operation,
            nonce,
            contract: contract.clone(),
            consumed_at: now,
            valid_until,
        },
    );

    NonceConsumed {
        signer: signer.clone(),
        operation,
        nonce,
    }
    .publish(env);

    Ok(())
}
