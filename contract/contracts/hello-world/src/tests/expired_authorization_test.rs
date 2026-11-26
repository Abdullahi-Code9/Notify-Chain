//! Safe handling of expired authorization records — issue #1202.

use crate::base::errors::Error;
use crate::base::nonce::NonceOperation;
use crate::test_utils::setup_test_env;
use crate::AutoShareContractClient;
use soroban_sdk::testutils::Ledger;

const NOW: u64 = 20_000;

fn setup() -> crate::test_utils::TestEnv {
    let t = setup_test_env();
    t.env.ledger().set_timestamp(NOW);
    t
}

#[test]
fn missing_authorization_fails_safely() {
    let t = setup();
    let client = AutoShareContractClient::new(&t.env, &t.autoshare_contract);

    assert_eq!(
        client.try_is_authorization_expired(&t.admin, &NonceOperation::Pause, &0),
        Err(Ok(Error::NotFound))
    );
    assert!(!client.is_nonce_consumed(&t.admin, &NonceOperation::Pause, &0));
}

#[test]
fn expiry_boundary_is_deterministic() {
    let t = setup();
    let contract = t.autoshare_contract.clone();
    let client = AutoShareContractClient::new(&t.env, &t.autoshare_contract);
    let deadline = NOW + 100;

    client.pause_with_nonce(&t.admin, &0, &contract, &deadline);
    assert_eq!(
        client.is_authorization_expired(&t.admin, &NonceOperation::Pause, &0),
        false,
        "deadline equal to now must still be valid"
    );

    t.env.ledger().set_timestamp(deadline);
    assert!(!client.is_authorization_expired(&t.admin, &NonceOperation::Pause, &0));

    t.env.ledger().set_timestamp(deadline + 1);
    assert!(client.is_authorization_expired(&t.admin, &NonceOperation::Pause, &0));

    let result = client.try_unpause_with_nonce(&t.admin, &0, &contract, &deadline);
    assert_eq!(result, Err(Ok(Error::NonceExpired)));
    assert!(client.get_paused_status());
}

#[test]
fn cleanup_removes_only_expired_records() {
    let t = setup();
    let contract = t.autoshare_contract.clone();
    let client = AutoShareContractClient::new(&t.env, &t.autoshare_contract);

    client.pause_with_nonce(&t.admin, &0, &contract, &(NOW + 10));
    client.unpause_with_nonce(&t.admin, &0, &contract, &(NOW + 10));
    t.env.ledger().set_timestamp(NOW + 11);
    client.pause_with_nonce(&t.admin, &1, &contract, &(NOW + 500));

    let removed = client.prune_expired_authorizations(
        &t.admin,
        &NonceOperation::Pause,
        &50,
    );
    assert_eq!(removed, 1);
    assert!(!client.is_nonce_consumed(&t.admin, &NonceOperation::Pause, &0));
    assert!(client.is_nonce_consumed(&t.admin, &NonceOperation::Pause, &1));
    assert!(!client.is_authorization_expired(&t.admin, &NonceOperation::Pause, &1));
    assert_eq!(client.get_next_nonce(&t.admin, &NonceOperation::Pause), 2);
    assert!(client.get_paused_status());

    // Cleanup never makes an expired authorization usable again.
    let replay = client.try_pause_with_nonce(&t.admin, &0, &contract, &(NOW + 500));
    assert_eq!(replay, Err(Ok(Error::NonceAlreadyUsed)));
}

#[test]
fn cleanup_is_bounded_and_preserves_active_records() {
    let t = setup();
    let contract = t.autoshare_contract.clone();
    let client = AutoShareContractClient::new(&t.env, &t.autoshare_contract);

    client.pause_with_nonce(&t.admin, &0, &contract, &(NOW + 1));
    client.unpause_with_nonce(&t.admin, &0, &contract, &(NOW + 1));
    client.pause_with_nonce(&t.admin, &1, &contract, &(NOW + 1000));
    t.env.ledger().set_timestamp(NOW + 2);

    // A zero bound is a no-op, so active authorizations cannot be pruned by
    // accident.
    assert_eq!(
        client.prune_expired_authorizations(&t.admin, &NonceOperation::Pause, &0),
        0
    );
    assert!(client.is_nonce_consumed(&t.admin, &NonceOperation::Pause, &0));
    assert!(client.is_nonce_consumed(&t.admin, &NonceOperation::Pause, &1));
}
