//! Explicit initialization-state validation (issue #1195).
//!
//! Before `initialize_admin` runs, protected entry points must fail without
//! writing storage. A second initialization must be rejected explicitly.

use crate::{AutoShareContract, AutoShareContractClient};
use crate::base::events::NotificationPriority;
use soroban_sdk::{testutils::Address as _, Address, BytesN, Env, String};

fn setup() -> (Env, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(AutoShareContract, ());
    let admin = Address::generate(&env);
    (env, contract_id, admin)
}

#[test]
#[should_panic(expected = "NotInitialized")]
fn admin_configuration_rejected_before_initialization() {
    let (env, contract_id, admin) = setup();
    AutoShareContractClient::new(&env, &contract_id).set_usage_fee(&25, &admin);
}

#[test]
#[should_panic(expected = "NotInitialized")]
fn protected_notification_operation_rejected_before_initialization() {
    let (env, contract_id, creator) = setup();
    let mut id = [0u8; 32];
    id[0] = 1;
    AutoShareContractClient::new(&env, &contract_id).schedule_notification(
        &BytesN::from_array(&env, &id),
        &creator,
        &3_600,
        &String::from_str(&env, "hello"),
        &NotificationPriority::Medium,
    );
}

#[test]
#[should_panic(expected = "AlreadyInitialized")]
fn repeated_initialization_by_a_different_admin_is_rejected() {
    let (env, contract_id, admin) = setup();
    let client = AutoShareContractClient::new(&env, &contract_id);
    client.initialize_admin(&admin);
    client.initialize_admin(&Address::generate(&env));
}

#[test]
fn failed_operations_leave_storage_unchanged() {
    let (env, contract_id, admin) = setup();
    let client = AutoShareContractClient::new(&env, &contract_id);
    assert!(client.try_set_usage_fee(&25, &admin).is_err());

    client.initialize_admin(&admin);
    assert_eq!(client.get_usage_fee(), 10);

    let other_admin = Address::generate(&env);
    assert!(client.try_initialize_admin(&other_admin).is_err());
    assert_eq!(client.get_usage_fee(), 10);
}
