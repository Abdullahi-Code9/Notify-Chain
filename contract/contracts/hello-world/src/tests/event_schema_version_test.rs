//! Tests for explicit contract event schema versioning (issue #1122).
//!
//! These lock in the compatibility guarantee: v1 events keep their
//! unsuffixed names and existing topic layout, and the contract exposes the
//! event schema version consumers should expect.

use crate::base::events::{EVENT_SCHEMA_VERSION, EVENT_SCHEMA_VERSION_SUFFIX};
use crate::{AutoShareContract, AutoShareContractClient};
use soroban_sdk::testutils::{Address as _, Events};
use soroban_sdk::{Address, Env, Symbol, TryFromVal};

fn setup(env: &Env) -> (Address, AutoShareContractClient<'_>) {
    env.mock_all_auths();
    let id = env.register(AutoShareContract, ());
    let client = AutoShareContractClient::new(env, &id);
    let admin = Address::generate(env);
    client.initialize_admin(&admin);
    (admin, client)
}

#[test]
fn test_event_schema_version_is_exposed() {
    let env = Env::default();
    let (_admin, client) = setup(&env);
    assert_eq!(client.get_event_schema_version(), EVENT_SCHEMA_VERSION);
    assert_eq!(client.get_event_schema_version(), 1);
}

#[test]
fn test_event_schema_version_is_independent_of_payload_schema_version() {
    let env = Env::default();
    let (admin, client) = setup(&env);
    assert_eq!(client.get_schema_version(), 0);
    client.set_schema_version(&admin, &1);
    assert_eq!(client.get_event_schema_version(), EVENT_SCHEMA_VERSION);
}

#[test]
fn test_v1_events_keep_unsuffixed_names_and_topic_layout() {
    let env = Env::default();
    let (admin, client) = setup(&env);
    client.pause(&admin);

    let mut found = false;
    for (_addr, topics, _data) in env.events().all().iter() {
        let Some(first) = topics.get(0) else { continue };
        let Ok(name) = Symbol::try_from_val(&env, &first) else { continue };
        if name == Symbol::new(&env, "contract_paused") {
            found = true;
            // v1 layout: [name, admin, category, priority] — unchanged.
            assert_eq!(topics.len(), 4);
        }
        // No v1 event may carry the versioned-name suffix.
        assert_ne!(name, Symbol::new(&env, "contract_paused_v1"));
    }
    assert!(found, "contract_paused event must be emitted under its v1 name");
    assert_eq!(EVENT_SCHEMA_VERSION_SUFFIX, "_v");
}
