//! Integration tests for notification metadata validation failures.
//!
//! Complements the unit tests in `metadata_validation.rs` by exercising
//! validation through the public `schedule_notification` entrypoint.

use crate::base::events::NotificationPriority;
use crate::test_utils::setup_test_env;
use crate::AutoShareContractClient;

extern crate std;

use soroban_sdk::{BytesN, Env, String};

const ONE_HOUR: u64 = 3_600;

fn make_id(env: &Env, tag: u8) -> BytesN<32> {
    let mut bytes = [0u8; 32];
    bytes[0] = tag;
    BytesN::from_array(env, &bytes)
}

#[test]
#[should_panic]
fn test_schedule_rejects_empty_title() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let creator = test_env.users.get(0).unwrap().clone();

    let id = make_id(&test_env.env, 1);
    client.schedule_notification(
        &id,
        &creator,
        &ONE_HOUR,
        &String::from_str(&test_env.env, ""),
        &NotificationPriority::Medium,
    );
}

#[test]
fn test_schedule_accepts_valid_title() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let creator = test_env.users.get(0).unwrap().clone();

    let id = make_id(&test_env.env, 2);
    client.schedule_notification(
        &id,
        &creator,
        &ONE_HOUR,
        &String::from_str(&test_env.env, "Valid title"),
        &NotificationPriority::Medium,
    );

    let stored = client.get_notification(&id);
    assert_eq!(stored.title, String::from_str(&test_env.env, "Valid title"));
}

#[test]
#[should_panic]
fn test_batch_rejects_empty_title() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let creator = test_env.users.get(0).unwrap().clone();

    let mut ids = soroban_sdk::Vec::new(&test_env.env);
    let mut ttls = soroban_sdk::Vec::new(&test_env.env);
    let mut titles = soroban_sdk::Vec::new(&test_env.env);
    let mut priorities = soroban_sdk::Vec::new(&test_env.env);

    ids.push_back(make_id(&test_env.env, 3));
    ttls.push_back(ONE_HOUR);
    titles.push_back(String::from_str(&test_env.env, ""));
    priorities.push_back(NotificationPriority::Medium);

    client.batch_schedule_notifications(&ids, &creator, &ttls, &titles, &priorities);
}
