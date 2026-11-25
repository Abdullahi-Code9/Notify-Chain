//! Tests for notification payload versioning.
//!
//! Every scheduled notification carries a protocol `version` field so off-chain
//! consumers can gate parsing logic. The current version is documented as
//! [`CURRENT_NOTIFICATION_VERSION`] (currently `1`).

use crate::base::events::NotificationPriority;
use crate::base::types::CURRENT_NOTIFICATION_VERSION;
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
fn test_current_notification_version_is_documented() {
    // Current protocol version — bump CURRENT_NOTIFICATION_VERSION when making
    // breaking payload changes and update the table in types.rs.
    assert_eq!(CURRENT_NOTIFICATION_VERSION, 1);
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    assert_eq!(client.get_notification_version(), CURRENT_NOTIFICATION_VERSION);
}

#[test]
fn test_scheduled_notification_includes_version() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let creator = test_env.users.get(0).unwrap().clone();

    let id = make_id(&test_env.env, 1);
    client.schedule_notification(
        &id,
        &creator,
        &ONE_HOUR,
        &String::from_str(&test_env.env, "Versioned notice"),
        &NotificationPriority::Medium,
    );

    let stored = client.get_notification(&id);
    assert_eq!(stored.version, CURRENT_NOTIFICATION_VERSION);
    assert_eq!(stored.version, 1);
}

#[test]
fn test_batch_scheduled_notifications_include_version() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let creator = test_env.users.get(0).unwrap().clone();

    let mut ids = soroban_sdk::Vec::new(&test_env.env);
    let mut ttls = soroban_sdk::Vec::new(&test_env.env);
    let mut titles = soroban_sdk::Vec::new(&test_env.env);
    let mut priorities = soroban_sdk::Vec::new(&test_env.env);

    for i in 0u8..3 {
        ids.push_back(make_id(&test_env.env, 20 + i));
        ttls.push_back(ONE_HOUR);
        titles.push_back(String::from_str(&test_env.env, "batch item"));
        priorities.push_back(NotificationPriority::Medium);
    }

    client.batch_schedule_notifications(&ids, &creator, &ttls, &titles, &priorities);

    for i in 0..3 {
        let stored = client.get_notification(&ids.get(i).unwrap());
        assert_eq!(stored.version, CURRENT_NOTIFICATION_VERSION);
    }
}
