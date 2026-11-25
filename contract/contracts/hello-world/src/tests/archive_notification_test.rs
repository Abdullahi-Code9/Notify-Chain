//! Tests for on-chain archiving of processed notifications.
//!
//! When a notification is expired, cancelled, or delivered it is moved out of
//! active storage into an immutable archive. Archived records remain queryable
//! via `get_archived_notification` so no data is lost.

use crate::base::events::NotificationPriority;
use crate::test_utils::setup_test_env;
use crate::AutoShareContractClient;

extern crate std;

use soroban_sdk::testutils::{Events, Ledger};
use soroban_sdk::{BytesN, Env, String, Symbol, TryFromVal, Val, Vec};

const ONE_HOUR: u64 = 3_600;

fn make_id(env: &Env, tag: u8) -> BytesN<32> {
    let mut bytes = [0u8; 32];
    bytes[0] = tag;
    BytesN::from_array(env, &bytes)
}

fn set_now(env: &Env, timestamp: u64) {
    env.ledger().set_timestamp(timestamp);
}

fn topics_of(env: &Env, event_name: &str) -> Option<Vec<Val>> {
    let target = Symbol::new(env, event_name);
    let mut found: Option<Vec<Val>> = None;
    for (_addr, topics, _data) in env.events().all().iter() {
        if topics.is_empty() {
            continue;
        }
        let first = topics.get(0).unwrap();
        if let Ok(name) = Symbol::try_from_val(env, &first) {
            if name == target {
                found = Some(topics);
            }
        }
    }
    found
}

#[test]
fn test_expire_archives_notification() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let creator = test_env.users.get(0).unwrap().clone();

    set_now(&test_env.env, 1_000);
    let id = make_id(&test_env.env, 1);
    client.schedule_notification(
        &id,
        &creator,
        &ONE_HOUR,
        &String::from_str(&test_env.env, "Will expire"),
        &NotificationPriority::Medium,
    );

    set_now(&test_env.env, 1_000 + ONE_HOUR + 1);
    client.expire_notification(&id);

    // Gone from active storage.
    let active = client.try_get_notification(&id);
    assert!(active.is_err());

    // Still accessible from archive — no data loss.
    let archived = client.get_archived_notification(&id);
    assert_eq!(archived.id, id);
    assert_eq!(
        archived.title,
        String::from_str(&test_env.env, "Will expire")
    );
    assert_eq!(
        archived.archive_reason,
        String::from_str(&test_env.env, "expired")
    );
    assert!(archived.archived_at >= 1_000 + ONE_HOUR);
}

#[test]
fn test_cancel_archives_notification() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let creator = test_env.users.get(0).unwrap().clone();

    let id = make_id(&test_env.env, 2);
    client.schedule_notification(
        &id,
        &creator,
        &ONE_HOUR,
        &String::from_str(&test_env.env, "Will cancel"),
        &NotificationPriority::Medium,
    );

    client.cancel_notification(&id, &creator);

    let archived = client.get_archived_notification(&id);
    assert_eq!(
        archived.archive_reason,
        String::from_str(&test_env.env, "cancelled")
    );
    assert_eq!(
        archived.title,
        String::from_str(&test_env.env, "Will cancel")
    );
}

#[test]
fn test_delivery_archives_notification() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let creator = test_env.users.get(0).unwrap().clone();

    let id = make_id(&test_env.env, 3);
    client.schedule_notification(
        &id,
        &creator,
        &ONE_HOUR,
        &String::from_str(&test_env.env, "Will deliver"),
        &NotificationPriority::Medium,
    );

    client.confirm_notification_delivery(&id, &creator);

    let active = client.try_get_notification(&id);
    assert!(active.is_err());

    let archived = client.get_archived_notification(&id);
    assert_eq!(
        archived.archive_reason,
        String::from_str(&test_env.env, "delivered")
    );
}
