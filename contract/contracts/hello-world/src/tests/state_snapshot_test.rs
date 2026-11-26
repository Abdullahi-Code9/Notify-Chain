//! Contract state snapshot queries — issue #1201.
//!
//! Verifies that related configuration can be read atomically, that the
//! response shape is stable, and that snapshot reads never mutate storage.

use crate::{AutoShareContract, AutoShareContractClient};
use soroban_sdk::{testutils::Address as _, testutils::Events as _, Address, Env};

fn fresh_client(env: &Env) -> (Address, AutoShareContractClient<'_>) {
    let id = env.register(AutoShareContract, ());
    let client = AutoShareContractClient::new(env, &id);
    (id, client)
}

#[test]
fn snapshot_has_documented_defaults_before_initialization() {
    let env = Env::default();
    let (_, client) = fresh_client(&env);

    let snapshot = client.get_state_snapshot();
    assert_eq!(snapshot.admin, None);
    assert_eq!(snapshot.pending_owner, None);
    assert!(!snapshot.paused);
    assert_eq!(snapshot.schema_version, 0);
    assert_eq!(snapshot.notification_version, crate::base::types::CURRENT_NOTIFICATION_VERSION);
    assert_eq!(snapshot.limits.max_payload_size, 10_000);
    assert_eq!(snapshot.limits.max_expiration_seconds, 365 * 24 * 60 * 60);
    assert_eq!(snapshot.limits.min_expiration_seconds, 60);
    assert_eq!(snapshot.limits.max_batch_size, 1000);
}

#[test]
fn snapshot_groups_related_state_after_updates() {
    let env = Env::default();
    env.mock_all_auths();
    let (_, client) = fresh_client(&env);
    let admin = Address::generate(&env);
    client.initialize_admin(&admin);
    client.set_schema_version(&admin, &1);
    client.configure_notification_limits(&admin, &1024, &86_400, &60, &25);

    let snapshot = client.get_state_snapshot();
    assert_eq!(snapshot.admin, Some(admin.clone()));
    assert_eq!(snapshot.pending_owner, None);
    assert_eq!(snapshot.schema_version, 1);
    assert_eq!(snapshot.limits.max_payload_size, 1024);
    assert_eq!(snapshot.limits.max_expiration_seconds, 86_400);
    assert_eq!(snapshot.limits.min_expiration_seconds, 60);
    assert_eq!(snapshot.limits.max_batch_size, 25);

    client.initiate_ownership_transfer(&admin, &Address::generate(&env));
    let snapshot = client.get_state_snapshot();
    assert!(snapshot.pending_owner.is_some());
}

#[test]
fn snapshot_query_is_read_only() {
    let env = Env::default();
    env.mock_all_auths();
    let (contract_id, client) = fresh_client(&env);
    let admin = Address::generate(&env);
    client.initialize_admin(&admin);

    let before = client.get_state_snapshot();
    let events_before = env.events().all().len();
    let after = client.get_state_snapshot();
    let events_after = env.events().all().len();

    assert_eq!(before, after);
    assert_eq!(events_before, events_after, "snapshot must not emit events");
    assert_eq!(env.events().all().len(), events_before);
    assert_eq!(client.get_admin(), admin);
    let _ = contract_id;
}
