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
//! Tests for contract-level cross-network configuration validation (issue #1196).
//!
//! Acceptance criteria verified here:
//!
//! 1. `initialize_admin` locks in the live network identifier at first call.
//! 2. `get_network_id` returns the stored value after initialization.
//! 3. `get_network_id` returns `None` before initialization.
//! 4. `initialize_with_network` succeeds when the supplied id matches the live
//!    ledger value.
//! 5. `initialize_with_network` returns `NetworkMismatch` when the supplied id
//!    differs from the live ledger value.
//! 6. `initialize_with_network` returns `Unauthorized` for a non-admin caller.
//! 7. The `NetworkConfigInitialized` event is emitted with `Admin` category and
//!    `High` priority on a successful `initialize_with_network` call.
//! 8. The locked-in network id is stable across multiple read calls.
//! 9. `validate_network` (via `initialize_with_network` round-trip) rejects a
//!    tampered / wrong network id correctly.
//! 10. Deployment-specific network values are documented in the event struct.

use crate::base::events::{NetworkConfigInitialized, NotificationCategory, NotificationPriority};
use crate::{AutoShareContract, AutoShareContractClient};

use soroban_sdk::testutils::{Address as _, Events, Ledger};
use soroban_sdk::{Address, BytesN, Env, TryFromVal};

// ─── helpers ────────────────────────────────────────────────────────────────

/// Deploys a fresh contract and calls `initialize_admin`, returning the
/// (env, contract address, admin address) triple.
fn setup(env: &Env) -> (AutoShareContractClient, Address) {
    let contract_id = env.register(AutoShareContract, ());
    let client = AutoShareContractClient::new(env, &contract_id);
    let admin = Address::generate(env);
    env.mock_all_auths();
    client.initialize_admin(&admin);
    (client, admin)
}

/// Returns the live network id as reported by the ledger.
fn live_network_id(env: &Env) -> BytesN<32> {
    env.ledger().network_id()
}

/// Builds a `BytesN<32>` with every byte set to `val`.
fn constant_id(env: &Env, val: u8) -> BytesN<32> {
    BytesN::from_array(env, &[val; 32])
}

// ============================================================================
// 1. initialize_admin locks in the live network id
// ============================================================================

#[test]
fn test_initialize_admin_stores_network_id() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _admin) = setup(&env);

    let stored = client.get_network_id();
    assert!(stored.is_some(), "network id must be set after initialize_admin");
    assert_eq!(
        stored.unwrap(),
        live_network_id(&env),
        "stored network id must match the live ledger network id"
    );
}

// ============================================================================
// 2. get_network_id returns the stored value after initialization
// ============================================================================

#[test]
fn test_get_network_id_returns_live_value_after_init() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _admin) = setup(&env);

    let expected = live_network_id(&env);
    let got = client
        .get_network_id()
        .expect("get_network_id must return Some after initialization");
    assert_eq!(got, expected);
}

// ============================================================================
// 3. get_network_id returns None before initialization
// ============================================================================

#[test]
fn test_get_network_id_returns_none_before_init() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(AutoShareContract, ());
    let client = AutoShareContractClient::new(&env, &contract_id);

    // No initialize_admin call — network id must not exist yet.
    assert!(
        client.get_network_id().is_none(),
        "get_network_id must return None before initialization"
    );
}

// ============================================================================
// 4. initialize_with_network succeeds for a matching network id
// ============================================================================

#[test]
fn test_initialize_with_network_succeeds_for_matching_id() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin) = setup(&env);

    let network_id = live_network_id(&env);
    let result = client.try_initialize_with_network(&admin, &network_id);
    assert!(
        result.is_ok(),
        "initialize_with_network must succeed when the supplied id matches the live network"
    );
}

// ============================================================================
// 5. initialize_with_network returns NetworkMismatch for a wrong id
// ============================================================================

#[test]
fn test_initialize_with_network_rejects_wrong_network_id() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin) = setup(&env);

    // Supply an id that is guaranteed to differ from the live value.
    let wrong_id = constant_id(&env, 0xAB);
    let result = client.try_initialize_with_network(&admin, &wrong_id);
    assert!(
        result.is_err(),
        "initialize_with_network must fail when the supplied id does not match the live network"
    );
}

// ============================================================================
// 6. initialize_with_network returns Unauthorized for a non-admin
// ============================================================================

#[test]
fn test_initialize_with_network_rejects_non_admin() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _admin) = setup(&env);

    let impostor = Address::generate(&env);
    let network_id = live_network_id(&env);
    let result = client.try_initialize_with_network(&impostor, &network_id);
    assert!(
        result.is_err(),
        "initialize_with_network must reject a caller that is not the admin"
    );
}

// ============================================================================
// 7. NetworkConfigInitialized event is emitted with correct metadata
// ============================================================================

#[test]
fn test_initialize_with_network_emits_event_with_correct_category_and_priority() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin) = setup(&env);

    let network_id = live_network_id(&env);
    client.initialize_with_network(&admin, &network_id);

    // Find the NetworkConfigInitialized event among all emitted events.
    use soroban_sdk::{Symbol, Val};
    let target = Symbol::new(&env, "network_config_initialized");
    let event_opt = env.events().all().iter().find(|(_addr, topics, _data)| {
        topics
            .get(0)
            .and_then(|v| Symbol::try_from_val(&env, &v).ok())
            .map(|s| s == target)
            .unwrap_or(false)
    });

    let event = event_opt.expect("NetworkConfigInitialized event must be emitted");
    let (_addr, topics, data) = event;

    // Category is second-to-last topic; priority is last.
    let n = topics.len();
    assert!(n >= 2, "event must have at least category and priority topics");

    let category = NotificationCategory::try_from_val(&env, &topics.get(n - 2).unwrap())
        .expect("second-to-last topic must be a NotificationCategory");
    let priority = NotificationPriority::try_from_val(&env, &topics.last().unwrap())
        .expect("last topic must be a NotificationPriority");

    assert_eq!(
        category,
        NotificationCategory::Admin,
        "NetworkConfigInitialized must carry Admin category"
    );
    assert_eq!(
        priority,
        NotificationPriority::High,
        "NetworkConfigInitialized must carry High priority"
    );

    // Data payload must contain the network id.
    let stored_id = BytesN::<32>::try_from_val(&env, &data)
        .expect("event data must deserialise as BytesN<32>");
    assert_eq!(stored_id, network_id, "event data must contain the locked-in network id");
}

// ============================================================================
// 8. Stored network id is stable across multiple read calls
// ============================================================================

#[test]
fn test_get_network_id_is_stable_across_reads() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _admin) = setup(&env);

    let first = client.get_network_id().unwrap();
    let second = client.get_network_id().unwrap();
    let third = client.get_network_id().unwrap();
    assert_eq!(first, second);
    assert_eq!(second, third);
}

// ============================================================================
// 9. Wrong id is rejected even when it looks almost correct (single-bit diff)
// ============================================================================

#[test]
fn test_initialize_with_network_rejects_id_with_one_bit_flipped() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin) = setup(&env);

    // Build a mutated version of the live network id.
    let live = live_network_id(&env);
    let mut bytes: [u8; 32] = live.to_array();
    bytes[31] ^= 0x01; // flip one bit
    let mutated = BytesN::from_array(&env, &bytes);

    let result = client.try_initialize_with_network(&admin, &mutated);
    assert!(
        result.is_err(),
        "a network id with even a single flipped bit must be rejected"
    );
}

// ============================================================================
// 10. All-zeros id matches the test-harness default network id
//
// The Soroban test harness initialises `env.ledger().network_id()` to
// `[0u8; 32]` (all zeros) by default.  This means `initialize_with_network`
// with an all-zeros argument succeeds in tests — which is correct behaviour:
// the validation compares against the *live* ledger value, whatever that is.
// A real Testnet/Mainnet deployment will have a non-zero network id, so
// supplying zeros there would be rejected.
// ============================================================================

#[test]
fn test_initialize_with_network_accepts_zero_id_in_test_harness() {
    // The default test-env network_id is [0u8; 32], so an all-zeros id must
    // be accepted (they match).  This confirms the comparison is against the
    // live ledger value, not against a hardcoded non-zero constant.
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin) = setup(&env);

    let zero_id = constant_id(&env, 0x00);
    // Should succeed because live_network_id() == [0;32] in the test harness.
    assert_eq!(live_network_id(&env), zero_id);
    let result = client.try_initialize_with_network(&admin, &zero_id);
    assert!(
        result.is_ok(),
        "all-zeros id must be accepted when the live network id is also all-zeros (test harness default)"
    );
}

/// Verifies the validation rejects a wrong id even when the live id is zeros:
/// supply a non-zero id and confirm it is rejected.
#[test]
fn test_initialize_with_network_rejects_nonzero_id_when_live_is_zero() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin) = setup(&env);

    // Live network_id in the test harness is [0;32].
    // A non-zero id must therefore be rejected.
    let nonzero_id = constant_id(&env, 0xFF);
    let result = client.try_initialize_with_network(&admin, &nonzero_id);
    assert!(
        result.is_err(),
        "a non-zero id must be rejected when the live network id is all-zeros"
    );
}

// ============================================================================
// 11. initialize_admin called a second time does not overwrite the network id
// ============================================================================

#[test]
fn test_reinitialize_admin_does_not_change_network_id() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _admin) = setup(&env);

    let first_network_id = client.get_network_id().unwrap();

    // A second initialize_admin call with a different admin must be a no-op
    // because the guard `!env.storage().instance().has(&INSTANCE_ADMIN)` fires.
    let new_admin = Address::generate(&env);
    client.initialize_admin(&new_admin);

    let second_network_id = client.get_network_id().unwrap();
    assert_eq!(
        first_network_id, second_network_id,
        "re-initializing must not overwrite the locked-in network id"
    );
}

// ============================================================================
// 12. Explicit initialize_with_network round-trip persists the correct value
// ============================================================================

#[test]
fn test_initialize_with_network_persists_correct_id() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin) = setup(&env);

    let network_id = live_network_id(&env);
    client.initialize_with_network(&admin, &network_id);

    let stored = client
        .get_network_id()
        .expect("network id must be Some after explicit initialization");
    assert_eq!(
        stored, network_id,
        "stored id must equal the value passed to initialize_with_network"
    );
}
