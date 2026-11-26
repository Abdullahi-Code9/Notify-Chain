//! Event correlation identifiers (issue #1194).
//!
//! All lifecycle events for one notification share that notification's unique
//! 32-byte id, while unrelated notifications have different identifiers.

use crate::base::events::NotificationPriority;
use crate::test_utils::setup_test_env;
use crate::AutoShareContractClient;
use soroban_sdk::{
    testutils::{Address as _, Events},
    Bytes, BytesN, String, Symbol, TryIntoVal, Vec,
};

/// Correlation events emitted by the most recent contract invocation.
fn operations_for(env: &soroban_sdk::Env, id: &BytesN<32>) -> Vec<String> {
    let mut operations = Vec::new(env);
    let name = Symbol::new(env, "operation_correlated");
    let expected_bytes = id.to_array();
    for (_contract, topics, data) in env.events().all().iter() {
        let emitted: Symbol = match topics.get(0).unwrap().try_into_val(env) {
            Ok(value) => value,
            Err(_) => continue,
        };
        if emitted != name {
            continue;
        }
        let correlation_id: Bytes = match topics.get(1).unwrap().try_into_val(env) {
            Ok(value) => value,
            Err(_) => continue,
        };
        let mut actual_bytes = [0u8; 32];
        correlation_id.copy_into_slice(&mut actual_bytes);
        if actual_bytes != expected_bytes {
            continue;
        }
        if let Ok(operation) = data.try_into_val(env) {
            operations.push_back(operation);
        }
    }
    operations
}

fn make_id(env: &soroban_sdk::Env, tag: u8) -> BytesN<32> {
    let mut bytes = [0u8; 32];
    bytes[0] = tag;
    BytesN::from_array(env, &bytes)
}

#[test]
fn related_events_share_a_correlation_id() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let creator = test_env.users.get(0).unwrap().clone();
    let id = make_id(&test_env.env, 1);
    let other_id = make_id(&test_env.env, 2);
    let scheduled = String::from_str(&test_env.env, "notification_scheduled");
    let delivered = String::from_str(&test_env.env, "notification_delivered");

    client.schedule_notification(
        &id,
        &creator,
        &3_600,
        &String::from_str(&test_env.env, "correlated"),
        &NotificationPriority::Medium,
    );
    assert!(operations_for(&test_env.env, &id).contains(scheduled.clone()));

    client.confirm_notification_delivery(&id, &creator);
    assert!(operations_for(&test_env.env, &id).contains(delivered.clone()));

    client.schedule_notification(
        &other_id,
        &creator,
        &3_600,
        &String::from_str(&test_env.env, "unrelated"),
        &NotificationPriority::Medium,
    );
    let other_operations = operations_for(&test_env.env, &other_id);
    assert!(other_operations.contains(scheduled));
    assert!(!other_operations.contains(delivered));
}
