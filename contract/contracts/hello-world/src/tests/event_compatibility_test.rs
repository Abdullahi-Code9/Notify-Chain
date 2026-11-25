//! Contract-level event emission compatibility tests — issue #1203.
//!
//! Event schema v1 is documented in `docs/CONTRACT_EVENT_COMPATIBILITY.md`.
//! These assertions fail if an event name, topic count, topic order, or required
//! payload field changes, so downstream indexers detect breaking changes.

use crate::base::errors::Error;
use crate::base::events::{NotificationCategory, NotificationPriority};
use crate::base::types::CURRENT_NOTIFICATION_VERSION;
use crate::test_utils::setup_test_env;
use crate::AutoShareContractClient;
use soroban_sdk::{
    testutils::{Address as _, Events as _, Ledger as _},
    Address, BytesN, Env, Map, Symbol, TryFromVal, TryIntoVal, Val, Vec,
};
use std::string::ToString;

/// Documented compatibility version of the event schemas asserted here.
pub const EVENT_SCHEMA_VERSION: u32 = 1;

#[derive(Clone, Copy)]
struct EventSchema {
    name: &'static str,
    topic_count: u32,
    /// Required data keys for map-format payloads (empty for scalar/unit).
    data_fields: &'static [&'static str],
}

const SCHEDULED: EventSchema = EventSchema {
    name: "notification_scheduled",
    topic_count: 4,
    data_fields: &["notification_id", "payload_version"],
};
const PAUSED: EventSchema = EventSchema {
    name: "contract_paused",
    topic_count: 4,
    data_fields: &[],
};
const TRANSFERRED: EventSchema = EventSchema {
    name: "admin_transferred",
    topic_count: 4,
    data_fields: &[],
};

fn find_event(env: &Env, contract: &Address, name: &str) -> Option<(Vec<Val>, Val)> {
    let events = env.events().all();
    for i in (0..events.len()).rev() {
        let (emitter, topics, data) = events.get(i).unwrap();
        if emitter != *contract || topics.is_empty() {
            continue;
        }
        let topic0: Symbol = topics.get(0).unwrap().try_into_val(env).unwrap();
        if topic0.to_string() == name {
            return Some((topics, data));
        }
    }
    None
}

fn assert_event(
    env: &Env,
    contract: &Address,
    schema: EventSchema,
) -> (Vec<Val>, Val) {
    let (topics, data) = find_event(env, contract, schema.name)
        .unwrap_or_else(|| panic!("missing event: {}", schema.name));
    assert_eq!(
        topics.len(),
        schema.topic_count,
        "{} topic count changed",
        schema.name
    );
    let topic0: Symbol = topics.get(0).unwrap().try_into_val(env).unwrap();
    assert_eq!(topic0.to_string(), schema.name);

    if !schema.data_fields.is_empty() {
        let fields = Map::<Symbol, Val>::try_from_val(env, &data)
            .unwrap_or_else(|_| panic!("{} payload is no longer a map", schema.name));
        for field in schema.data_fields {
            assert!(
                fields.contains_key(Symbol::new(env, field)),
                "{} payload lost required field '{}'",
                schema.name,
                field
            );
        }
    }
    (topics, data)
}

fn topic<T>(env: &Env, topics: &Vec<Val>, index: u32) -> T
where
    Val: TryIntoVal<Env, T>,
{
    topics
        .get(index)
        .unwrap_or_else(|| panic!("missing topic {}", index))
        .try_into_val(env)
        .unwrap()
}

#[test]
fn scheduled_event_matches_documented_v1_schema() {
    let t = setup_test_env();
    let client = AutoShareContractClient::new(&t.env, &t.autoshare_contract);
    let creator = t.users.get(0).unwrap();
    let id = BytesN::from_array(&t.env, &[7u8; 32]);

    client.schedule_notification(
        &id,
        &creator,
        &3_600u64,
        &soroban_sdk::String::from_str(&t.env, "compat"),
        &NotificationPriority::Medium,
    );

    let (topics, data) = assert_event(&t.env, &t.autoshare_contract, SCHEDULED);
    let event_creator: Address = topic(&t.env, &topics, 1);
    assert_eq!(event_creator, creator);
    let category: NotificationCategory = topic(&t.env, &topics, 2);
    assert_eq!(category, NotificationCategory::Notification);
    let priority: NotificationPriority = topic(&t.env, &topics, 3);
    assert_eq!(priority, NotificationPriority::Medium);

    let fields = Map::<Symbol, Val>::try_from_val(&t.env, &data).unwrap();
    let event_id: BytesN<32> = fields
        .get(Symbol::new(&t.env, "notification_id"))
        .unwrap()
        .try_into_val(&t.env)
        .unwrap();
    assert_eq!(event_id, id);
    let payload_version: u32 = fields
        .get(Symbol::new(&t.env, "payload_version"))
        .unwrap()
        .try_into_val(&t.env)
        .unwrap();
    assert_eq!(payload_version, EVENT_SCHEMA_VERSION);
    assert_eq!(payload_version, CURRENT_NOTIFICATION_VERSION);
}

#[test]
fn pause_and_transfer_events_match_documented_v1_schema() {
    let t = setup_test_env();
    let client = AutoShareContractClient::new(&t.env, &t.autoshare_contract);

    client.pause(&t.admin);
    let (topics, _) = assert_event(&t.env, &t.autoshare_contract, PAUSED);
    let admin: Address = topic(&t.env, &topics, 1);
    assert_eq!(admin, t.admin);
    let category: NotificationCategory = topic(&t.env, &topics, 2);
    assert_eq!(category, NotificationCategory::Admin);
    let priority: NotificationPriority = topic(&t.env, &topics, 3);
    assert_eq!(priority, NotificationPriority::High);

    client.unpause(&t.admin);
    let new_admin = Address::generate(&t.env);
    client.transfer_admin(&t.admin, &new_admin);
    let (topics, data) = assert_event(&t.env, &t.autoshare_contract, TRANSFERRED);
    let old_admin: Address = topic(&t.env, &topics, 1);
    assert_eq!(old_admin, t.admin);
    let category: NotificationCategory = topic(&t.env, &topics, 2);
    assert_eq!(category, NotificationCategory::Admin);
    let priority: NotificationPriority = topic(&t.env, &topics, 3);
    assert_eq!(priority, NotificationPriority::Critical);
    let data_new_admin: Address = data.try_into_val(&t.env).unwrap();
    assert_eq!(data_new_admin, new_admin);
}

#[test]
fn failed_operation_emits_no_success_event_and_no_state_change() {
    let t = setup_test_env();
    t.env.ledger().set_timestamp(10_000);
    let contract = t.autoshare_contract.clone();
    let client = AutoShareContractClient::new(&t.env, &t.autoshare_contract);

    let result = client.try_pause_with_nonce(&t.admin, &0, &contract, &9_999);
    assert_eq!(result, Err(Ok(Error::NonceExpired)));

    // A failed state transition must not publish the success event, and the
    // nonce-consumed event must not be retained either.
    assert!(find_event(&t.env, &contract, "contract_paused").is_none());
    assert!(find_event(&t.env, &contract, "nonce_consumed").is_none());
    assert!(!client.get_paused_status());
    assert_eq!(client.get_next_nonce(&t.admin, &crate::base::nonce::NonceOperation::Pause), 0);
}
