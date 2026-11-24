//! Tests for cross-network configuration validation (Issue #1196).
//!
//! Acceptance criteria verified here:
//! - Network configuration is explicit: `set_network_id` stores the passphrase.
//! - Invalid configuration is rejected: empty passphrase → `InvalidNetworkId`,
//!   mismatched passphrase → `NetworkMismatch`, duplicate different value → `AlreadyExists`.
//! - `get_network_id` returns the stored value or `None`.
//! - `validate_network_id` returns `true` on match, `false` when unset, error on mismatch.
//! - Existing valid deployments (no network ID set) remain supported.
//! - Non-admin callers are rejected with `Unauthorized`.

use crate::base::errors::Error;
use crate::test_utils::setup_test_env;
use crate::AutoShareContractClient;
use soroban_sdk::testutils::Address as _;
use soroban_sdk::{Address, String};

fn testnet(env: &soroban_sdk::Env) -> String {
    String::from_str(env, "Test SDF Network ; September 2015")
}

fn mainnet(env: &soroban_sdk::Env) -> String {
    String::from_str(env, "Public Global Stellar Network ; September 2015")
}

fn futurenet(env: &soroban_sdk::Env) -> String {
    String::from_str(env, "Test SDF Future Network ; October 2022")
}

// ============================================================================
// get_network_id — before any value is set
// ============================================================================

#[test]
fn test_get_network_id_returns_none_before_set() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);

    assert!(client.get_network_id().is_none());
}

// ============================================================================
// set_network_id — happy paths
// ============================================================================

#[test]
fn test_set_network_id_stores_testnet_passphrase() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);

    client.set_network_id(&test_env.admin, &testnet(&test_env.env)).unwrap();
    assert_eq!(client.get_network_id(), Some(testnet(&test_env.env)));
}

#[test]
fn test_set_network_id_stores_mainnet_passphrase() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);

    client.set_network_id(&test_env.admin, &mainnet(&test_env.env)).unwrap();
    assert_eq!(client.get_network_id(), Some(mainnet(&test_env.env)));
}

#[test]
fn test_set_network_id_stores_futurenet_passphrase() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);

    client.set_network_id(&test_env.admin, &futurenet(&test_env.env)).unwrap();
    assert_eq!(client.get_network_id(), Some(futurenet(&test_env.env)));
}

#[test]
fn test_set_network_id_idempotent_same_value() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);

    // Calling twice with the same value must not error.
    client.set_network_id(&test_env.admin, &testnet(&test_env.env)).unwrap();
    client.set_network_id(&test_env.admin, &testnet(&test_env.env)).unwrap();
    assert_eq!(client.get_network_id(), Some(testnet(&test_env.env)));
}

// ============================================================================
// set_network_id — error paths
// ============================================================================

#[test]
fn test_set_network_id_empty_passphrase_rejected() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);

    let empty = String::from_str(&test_env.env, "");
    let result = client.try_set_network_id(&test_env.admin, &empty);
    assert_eq!(result, Err(Ok(Error::InvalidNetworkId)));
}

#[test]
fn test_set_network_id_non_admin_rejected() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);

    let stranger = Address::generate(&test_env.env);
    let result = client.try_set_network_id(&stranger, &testnet(&test_env.env));
    assert_eq!(result, Err(Ok(Error::Unauthorized)));
}

#[test]
fn test_set_network_id_different_value_rejected_after_set() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);

    client.set_network_id(&test_env.admin, &testnet(&test_env.env)).unwrap();

    // Attempting to overwrite with a different passphrase is rejected.
    let result = client.try_set_network_id(&test_env.admin, &mainnet(&test_env.env));
    assert_eq!(result, Err(Ok(Error::AlreadyExists)));

    // Original value is unchanged.
    assert_eq!(client.get_network_id(), Some(testnet(&test_env.env)));
}

// ============================================================================
// validate_network_id — happy paths
// ============================================================================

#[test]
fn test_validate_network_id_returns_false_when_unset() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);

    // No network ID set → backward-compatible: treated as valid (returns false, not error).
    let result = client.validate_network_id(&testnet(&test_env.env));
    assert_eq!(result, false);
}

#[test]
fn test_validate_network_id_returns_true_on_match() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);

    client.set_network_id(&test_env.admin, &testnet(&test_env.env)).unwrap();
    assert!(client.validate_network_id(&testnet(&test_env.env)));
}

#[test]
fn test_validate_network_id_mainnet_match() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);

    client.set_network_id(&test_env.admin, &mainnet(&test_env.env)).unwrap();
    assert!(client.validate_network_id(&mainnet(&test_env.env)));
}

// ============================================================================
// validate_network_id — error paths
// ============================================================================

#[test]
fn test_validate_network_id_mismatch_returns_error() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);

    client.set_network_id(&test_env.admin, &testnet(&test_env.env)).unwrap();

    let result = client.try_validate_network_id(&mainnet(&test_env.env));
    assert_eq!(result, Err(Ok(Error::NetworkMismatch)));
}

#[test]
fn test_validate_network_id_empty_passphrase_rejected() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);

    let empty = String::from_str(&test_env.env, "");
    let result = client.try_validate_network_id(&empty);
    assert_eq!(result, Err(Ok(Error::InvalidNetworkId)));
}

#[test]
fn test_validate_network_id_futurenet_vs_testnet_mismatch() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);

    client.set_network_id(&test_env.admin, &futurenet(&test_env.env)).unwrap();

    let result = client.try_validate_network_id(&testnet(&test_env.env));
    assert_eq!(result, Err(Ok(Error::NetworkMismatch)));
}

// ============================================================================
// Existing deployments: no network ID set, all other operations unaffected
// ============================================================================

#[test]
fn test_existing_deployment_without_network_id_still_works() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);

    // No set_network_id call — contract functions as before.
    assert!(client.get_network_id().is_none());

    // Validation with no stored ID returns false (not an error).
    assert!(!client.validate_network_id(&testnet(&test_env.env)));
}
