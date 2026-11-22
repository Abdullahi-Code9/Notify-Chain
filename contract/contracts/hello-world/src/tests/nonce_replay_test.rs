//! Tests for nonce-based replay protection (issue #1126).
//!
//! Covers:
//! - sequential, operation-scoped nonces for authorized operations,
//! - replayed, stale, out-of-sequence and expired nonces being rejected,
//! - nonces being bound to the executing contract,
//! - consumed nonces being recorded and auditable,
//! - failed operations not consuming a nonce,
//! - legacy (non-nonce) entry points continuing to work unchanged.

use crate::base::errors::Error;
use crate::base::events::NotificationPriority;
use crate::base::nonce::{NonceOperation, MAX_NONCE_VALIDITY_SECONDS};
use crate::test_utils::setup_test_env;
use crate::AutoShareContractClient;

use soroban_sdk::testutils::{Address as _, Ledger};
use soroban_sdk::{Address, BytesN, Env, String};

const NOW: u64 = 10_000;
const VALID_UNTIL: u64 = NOW + 600;

fn make_id(env: &Env, tag: u8) -> BytesN<32> {
    let mut bytes = [0u8; 32];
    bytes[0] = tag;
    BytesN::from_array(env, &bytes)
}

fn setup() -> (crate::test_utils::TestEnv, Address) {
    let test_env = setup_test_env();
    test_env.env.ledger().set_timestamp(NOW);
    let contract = test_env.autoshare_contract.clone();
    (test_env, contract)
}

#[test]
fn test_next_nonce_starts_at_zero() {
    let (t, _) = setup();
    let client = AutoShareContractClient::new(&t.env, &t.autoshare_contract);
    assert_eq!(client.get_next_nonce(&t.admin, &NonceOperation::Pause), 0);
    assert!(!client.is_nonce_consumed(&t.admin, &NonceOperation::Pause, &0));
    assert_eq!(client.get_nonce_record(&t.admin, &NonceOperation::Pause, &0), None);
}

#[test]
fn test_valid_nonce_is_consumed_and_recorded() {
    let (t, contract) = setup();
    let client = AutoShareContractClient::new(&t.env, &t.autoshare_contract);

    client.pause_with_nonce(&t.admin, &0, &contract, &VALID_UNTIL);

    assert!(client.get_paused_status());
    assert_eq!(client.get_next_nonce(&t.admin, &NonceOperation::Pause), 1);
    assert!(client.is_nonce_consumed(&t.admin, &NonceOperation::Pause, &0));

    let record = client
        .get_nonce_record(&t.admin, &NonceOperation::Pause, &0)
        .expect("consumed nonce must be recorded");
    assert_eq!(record.signer, t.admin);
    assert_eq!(record.operation, NonceOperation::Pause);
    assert_eq!(record.nonce, 0);
    assert_eq!(record.contract, contract);
    assert_eq!(record.consumed_at, NOW);
    assert_eq!(record.valid_until, VALID_UNTIL);
}

#[test]
fn test_replayed_nonce_is_rejected() {
    let (t, contract) = setup();
    let client = AutoShareContractClient::new(&t.env, &t.autoshare_contract);

    client.pause_with_nonce(&t.admin, &0, &contract, &VALID_UNTIL);
    client.unpause_with_nonce(&t.admin, &0, &contract, &VALID_UNTIL);

    // Replaying the original pause authorization must fail even though the
    // contract is back in a state where pausing would otherwise succeed.
    let replay = client.try_pause_with_nonce(&t.admin, &0, &contract, &VALID_UNTIL);
    assert_eq!(replay, Err(Ok(Error::NonceAlreadyUsed)));
    assert!(!client.get_paused_status());
}

#[test]
fn test_stale_nonce_is_rejected() {
    let (t, contract) = setup();
    let client = AutoShareContractClient::new(&t.env, &t.autoshare_contract);

    client.pause_with_nonce(&t.admin, &0, &contract, &VALID_UNTIL);
    client.unpause_with_nonce(&t.admin, &0, &contract, &VALID_UNTIL);
    client.pause_with_nonce(&t.admin, &1, &contract, &VALID_UNTIL);
    client.unpause_with_nonce(&t.admin, &1, &contract, &VALID_UNTIL);

    assert_eq!(client.get_next_nonce(&t.admin, &NonceOperation::Pause), 2);
    let stale = client.try_pause_with_nonce(&t.admin, &1, &contract, &VALID_UNTIL);
    assert_eq!(stale, Err(Ok(Error::NonceAlreadyUsed)));
}

#[test]
fn test_out_of_sequence_nonce_is_rejected() {
    let (t, contract) = setup();
    let client = AutoShareContractClient::new(&t.env, &t.autoshare_contract);

    let skipped = client.try_pause_with_nonce(&t.admin, &5, &contract, &VALID_UNTIL);
    assert_eq!(skipped, Err(Ok(Error::InvalidNonce)));
    assert!(!client.get_paused_status());
    assert_eq!(client.get_next_nonce(&t.admin, &NonceOperation::Pause), 0);
}

#[test]
fn test_expired_nonce_is_rejected() {
    let (t, contract) = setup();
    let client = AutoShareContractClient::new(&t.env, &t.autoshare_contract);

    let expired = client.try_pause_with_nonce(&t.admin, &0, &contract, &(NOW - 1));
    assert_eq!(expired, Err(Ok(Error::NonceExpired)));
    assert!(!client.is_nonce_consumed(&t.admin, &NonceOperation::Pause, &0));
}

#[test]
fn test_deadline_at_current_time_is_accepted() {
    let (t, contract) = setup();
    let client = AutoShareContractClient::new(&t.env, &t.autoshare_contract);

    client.pause_with_nonce(&t.admin, &0, &contract, &NOW);
    assert!(client.get_paused_status());
}

#[test]
fn test_deadline_beyond_validity_window_is_rejected() {
    let (t, contract) = setup();
    let client = AutoShareContractClient::new(&t.env, &t.autoshare_contract);

    let too_far = NOW + MAX_NONCE_VALIDITY_SECONDS + 1;
    let result = client.try_pause_with_nonce(&t.admin, &0, &contract, &too_far);
    assert_eq!(result, Err(Ok(Error::InvalidNonce)));

    // Exactly at the boundary is allowed.
    let boundary = NOW + MAX_NONCE_VALIDITY_SECONDS;
    client.pause_with_nonce(&t.admin, &0, &contract, &boundary);
    assert!(client.get_paused_status());
}

#[test]
fn test_nonce_bound_to_other_contract_is_rejected() {
    let (t, _) = setup();
    let client = AutoShareContractClient::new(&t.env, &t.autoshare_contract);

    let other_contract = Address::generate(&t.env);
    let result = client.try_pause_with_nonce(&t.admin, &0, &other_contract, &VALID_UNTIL);
    assert_eq!(result, Err(Ok(Error::NonceContractMismatch)));
    assert!(!client.is_nonce_consumed(&t.admin, &NonceOperation::Pause, &0));
}

#[test]
fn test_nonces_are_scoped_per_operation() {
    let (t, contract) = setup();
    let client = AutoShareContractClient::new(&t.env, &t.autoshare_contract);

    client.pause_with_nonce(&t.admin, &0, &contract, &VALID_UNTIL);
    // Nonce 0 for Unpause is independent of nonce 0 for Pause.
    client.unpause_with_nonce(&t.admin, &0, &contract, &VALID_UNTIL);

    assert_eq!(client.get_next_nonce(&t.admin, &NonceOperation::Pause), 1);
    assert_eq!(client.get_next_nonce(&t.admin, &NonceOperation::Unpause), 1);
    assert_eq!(client.get_next_nonce(&t.admin, &NonceOperation::TransferAdmin), 0);
}

#[test]
fn test_nonces_are_scoped_per_signer() {
    let (t, contract) = setup();
    let client = AutoShareContractClient::new(&t.env, &t.autoshare_contract);
    let creator = t.users.get(0).unwrap();
    let other = t.users.get(1).unwrap();

    let id_a = make_id(&t.env, 1);
    let id_b = make_id(&t.env, 2);
    let title = String::from_str(&t.env, "Nonce test");
    client.schedule_notification(&id_a, &creator, &3_600, &title, &NotificationPriority::Medium);
    client.schedule_notification(&id_b, &other, &3_600, &title, &NotificationPriority::Medium);

    client.revoke_notification_with_nonce(&id_a, &creator, &0, &contract, &VALID_UNTIL);
    client.revoke_notification_with_nonce(&id_b, &other, &0, &contract, &VALID_UNTIL);

    assert!(client.is_notification_revoked(&id_a));
    assert!(client.is_notification_revoked(&id_b));
    assert_eq!(
        client.get_next_nonce(&creator, &NonceOperation::RevokeNotification),
        1
    );
    assert_eq!(
        client.get_next_nonce(&other, &NonceOperation::RevokeNotification),
        1
    );
}

#[test]
fn test_failed_operation_does_not_consume_nonce() {
    let (t, contract) = setup();
    let client = AutoShareContractClient::new(&t.env, &t.autoshare_contract);

    // Unpausing an unpaused contract fails with NotPaused; the nonce must
    // remain available because the whole invocation is rolled back.
    let result = client.try_unpause_with_nonce(&t.admin, &0, &contract, &VALID_UNTIL);
    assert_eq!(result, Err(Ok(Error::NotPaused)));
    assert_eq!(client.get_next_nonce(&t.admin, &NonceOperation::Unpause), 0);
    assert!(!client.is_nonce_consumed(&t.admin, &NonceOperation::Unpause, &0));
}

#[test]
fn test_non_admin_cannot_use_nonce_protected_admin_operation() {
    let (t, contract) = setup();
    let client = AutoShareContractClient::new(&t.env, &t.autoshare_contract);
    let intruder = t.users.get(0).unwrap();

    let result = client.try_pause_with_nonce(&intruder, &0, &contract, &VALID_UNTIL);
    assert_eq!(result, Err(Ok(Error::Unauthorized)));
    assert_eq!(client.get_next_nonce(&intruder, &NonceOperation::Pause), 0);
}

#[test]
fn test_transfer_admin_with_nonce() {
    let (t, contract) = setup();
    let client = AutoShareContractClient::new(&t.env, &t.autoshare_contract);
    let new_admin = Address::generate(&t.env);

    client.transfer_admin_with_nonce(&t.admin, &new_admin, &0, &contract, &VALID_UNTIL);
    assert_eq!(client.get_admin(), new_admin);

    // Replaying the transfer authorization is rejected.
    let replay =
        client.try_transfer_admin_with_nonce(&t.admin, &new_admin, &0, &contract, &VALID_UNTIL);
    assert_eq!(replay, Err(Ok(Error::NonceAlreadyUsed)));
}

#[test]
fn test_legacy_entry_points_remain_unaffected() {
    let (t, contract) = setup();
    let client = AutoShareContractClient::new(&t.env, &t.autoshare_contract);

    client.pause(&t.admin);
    assert!(client.get_paused_status());
    client.unpause(&t.admin);
    assert!(!client.get_paused_status());

    // Legacy calls never touch the nonce sequence.
    assert_eq!(client.get_next_nonce(&t.admin, &NonceOperation::Pause), 0);
    client.pause_with_nonce(&t.admin, &0, &contract, &VALID_UNTIL);
    assert!(client.get_paused_status());
}
