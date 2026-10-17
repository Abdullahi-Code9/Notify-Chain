//! Tests for batch acknowledgment of notifications.
//!
//! These tests verify:
//! - Multiple notifications can be acknowledged in a single transaction.
//! - Validates notification ownership (only creator can acknowledge).
//! - Correct `NotificationAcknowledged` events are emitted.
//! - Gas benchmarking to prove batching is more efficient than individual calls.

use crate::base::events::{NotificationCategory, NotificationPriority};
use crate::test_utils::setup_test_env;
use crate::AutoShareContractClient;

use soroban_sdk::testutils::{Address as _, Events, Ledger};
use soroban_sdk::{Address, BytesN, Env, String, Symbol, TryFromVal, Val, Vec};

const ONE_HOUR: u64 = 3_600;

fn make_id(env: &Env, tag: u8) -> BytesN<32> {
    let mut bytes = [0u8; 32];
    bytes[0] = tag;
    BytesN::from_array(env, &bytes)
}

/// Schedules a notification with the default one-hour TTL and Medium priority.
fn schedule_test_notification(
    client: &AutoShareContractClient<'_>,
    env: &Env,
    id: &BytesN<32>,
    creator: &Address,
) {
    client.schedule_notification(
        id,
        creator,
        &ONE_HOUR,
        &String::from_str(env, "Test Notification"),
        &NotificationPriority::Medium,
    );
}

fn set_now(env: &Env, timestamp: u64) {
    env.ledger().set_timestamp(timestamp);
}

fn count_events(env: &Env, event_name: &str) -> usize {
    let target = Symbol::new(env, event_name);
    let mut count = 0;
    for (_addr, topics, _data) in env.events().all().iter() {
        if topics.is_empty() {
            continue;
        }
        let first = topics.get(0).unwrap();
        if let Ok(name) = Symbol::try_from_val(env, &first) {
            if name == target {
                count += 1;
            }
        }
    }
    count
}

#[test]
fn test_acknowledge_multiple_notifications() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let creator = test_env.users.get(0).unwrap().clone();

    set_now(&test_env.env, 1_000);

    let id1 = make_id(&test_env.env, 1);
    let id2 = make_id(&test_env.env, 2);
    let id3 = make_id(&test_env.env, 3);

    schedule_test_notification(&client, &test_env.env, &id1, &creator);
    schedule_test_notification(&client, &test_env.env, &id2, &creator);
    schedule_test_notification(&client, &test_env.env, &id3, &creator);

    let mut batch = Vec::new(&test_env.env);
    batch.push_back(id1.clone());
    batch.push_back(id2.clone());
    batch.push_back(id3.clone());

    set_now(&test_env.env, 2_000);

    client.acknowledge_notifications(&creator, &batch);

    // Verify exactly 3 events were emitted
    assert_eq!(count_events(&test_env.env, "notification_acknowledged"), 3);
}

#[test]
#[should_panic]
fn test_acknowledge_unauthorized_fails() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let creator = test_env.users.get(0).unwrap().clone();
    let unauthorized = Address::generate(&test_env.env);

    set_now(&test_env.env, 1_000);

    let id1 = make_id(&test_env.env, 1);
    schedule_test_notification(&client, &test_env.env, &id1, &creator);

    let mut batch = Vec::new(&test_env.env);
    batch.push_back(id1.clone());

    // Fails because `unauthorized` does not own the notification
    client.acknowledge_notifications(&unauthorized, &batch);
}

#[test]
#[should_panic]
fn test_acknowledge_revoked_fails() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let creator = test_env.users.get(0).unwrap().clone();

    set_now(&test_env.env, 1_000);
    let id1 = make_id(&test_env.env, 1);
    schedule_test_notification(&client, &test_env.env, &id1, &creator);

    client.revoke_notification(&id1, &creator);

    let mut batch = Vec::new(&test_env.env);
    batch.push_back(id1.clone());

    // Fails because notification is revoked
    client.acknowledge_notifications(&creator, &batch);
}

#[test]
#[should_panic]
fn test_acknowledge_expired_fails() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let creator = test_env.users.get(0).unwrap().clone();

    set_now(&test_env.env, 1_000);
    let id1 = make_id(&test_env.env, 1);
    schedule_test_notification(&client, &test_env.env, &id1, &creator);

    set_now(&test_env.env, 1_000 + ONE_HOUR + 1);

    let mut batch = Vec::new(&test_env.env);
    batch.push_back(id1.clone());

    // Fails because notification is expired
    client.acknowledge_notifications(&creator, &batch);
}

#[test]
fn benchmark_gas_usage() {
    // The budget meter resets before every top-level contract invocation, so
    // `cpu_instruction_cost()` only reflects the most recent call. We therefore
    // compare the cost of a single call acknowledging one notification against
    // a single call acknowledging the remaining nine.
    let env = Env::default();
    env.mock_all_auths();
    env.cost_estimate().budget().reset_unlimited();

    let client = AutoShareContractClient::new(
        &env,
        &env.register_contract(None, crate::AutoShareContract),
    );
    let creator = Address::generate(&env);
    client.initialize_admin(&Address::generate(&env));

    set_now(&env, 1_000);

    let mut ids = Vec::new(&env);
    for i in 0..10u8 {
        let id = make_id(&env, i);
        schedule_test_notification(&client, &env, &id, &creator);
        ids.push_back(id);
    }

    // Cost of acknowledging a single notification in its own transaction.
    let mut single_batch = Vec::new(&env);
    single_batch.push_back(ids.get(0).unwrap());
    client.acknowledge_notifications(&creator, &single_batch);
    let single_cost = env.cost_estimate().budget().cpu_instruction_cost();

    // Cost of acknowledging the remaining nine in one batched transaction.
    let mut bulk_batch = Vec::new(&env);
    for i in 1..10u32 {
        bulk_batch.push_back(ids.get(i).unwrap());
    }
    let bulk_len = bulk_batch.len() as u64;
    client.acknowledge_notifications(&creator, &bulk_batch);
    let batch_cost = env.cost_estimate().budget().cpu_instruction_cost();

    // Batching must be cheaper than the equivalent number of single calls.
    assert!(
        batch_cost < single_cost * bulk_len,
        "Batch cost ({}) should be less than {} individual costs ({})",
        batch_cost,
        bulk_len,
        single_cost * bulk_len
    );
}
