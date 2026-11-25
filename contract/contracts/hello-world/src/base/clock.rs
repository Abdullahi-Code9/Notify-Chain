//! Clock abstraction for time-sensitive contract logic.
//!
//! All production code that needs the current ledger time **must** call
//! [`current_time`] instead of `env.ledger().timestamp()` directly.
//! This centralises the single point of contact with the ledger clock,
//! making time-dependent logic easy to locate and trivial to control in
//! tests (tests already advance time via `env.ledger().set_timestamp()`).
use soroban_sdk::Env;

/// Returns the current ledger timestamp in seconds.
///
/// This is the canonical wrapper for `env.ledger().timestamp()` used
/// throughout the contract.  Test code advances time by calling
/// `env.ledger().set_timestamp(ts)` on the Soroban test `Env`, which
/// this function then reflects automatically.
#[inline(always)]
pub fn current_time(env: &Env) -> u64 {
    env.ledger().timestamp()
}
