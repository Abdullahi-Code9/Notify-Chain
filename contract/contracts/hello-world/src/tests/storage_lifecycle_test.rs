//! Persistent storage lifecycle & cleanup tests (Task 2).
//!
//! Covers [`AutoShareContract::cleanup_expired_records`]:
//! - Authorized admin can prune **expired** ephemeral records.
//! - Non-admin / unauthorized callers are rejected with `Unauthorized`.
//! - Pruned records are archived first, so immutable history survives.
//! - Live records are never removed (their TTL is refreshed instead).
//! - Unknown ids are ignored.
//! - A `RecordsCleanedUp` event reports the number of pruned records.

use crate::base::errors::Error;
use crate::base::events::NotificationPriority;
use crate::test_utils::setup_test_env;
use crate::AutoShareContractClient;

use soroban_sdk::testutils::{Address as _, Events, Ledger};
use soroban_sdk::{Address, BytesN, Env, String, Symbol, TryFromVal, Val, Vec};

const ONE_HOUR: u64 = 3_600;
const ONE_DAY: u64 = 86_400;

fn make_id(env: &Env, tag: u8) -> BytesN<32> {
    let mut bytes = [0u8; 32];
    bytes[0] = tag;
    BytesN::from_array(env, &bytes)
}

fn set_now(env: &Env, timestamp: u64) {
    env.ledger().set_timestamp(timestamp);
}

fn schedule(client: &AutoShareContractClient, env: &Env, id: &BytesN<32>, creator: &Address, ttl: u64) {
    client.schedule_notification(
        id,
        creator,
        &ttl,
        &String::from_str(env, "lifecycle"),
        &NotificationPriority::Medium,
    );
}

/// Returns the topic list of the most recently emitted event whose first topic
/// symbol matches `event_name`.
fn topics_of(env: &Env, event_name: &str) -> Option<Vec<Val>> {
    let target = Symbol::new(env, event_name);
    let mut found: Option<Vec<Val>> = None;
    for (_addr, topics, _data) in env.events().all().iter() {
        if topics.is_empty() {
            continue;
        }
        if let Ok(name) = Symbol::try_from_val(env, &topics.get(0).unwrap()) {
            if name == target {
                found = Some(topics);
            }
        }
    }
    found
}

/// Returns the data payload of the most recently emitted `event_name`.
fn data_of(env: &Env, event_name: &str) -> Option<Val> {
    let target = Symbol::new(env, event_name);
    let mut found: Option<Val> = None;
    for (_addr, topics, data) in env.events().all().iter() {
        if topics.is_empty() {
            continue;
        }
        if let Ok(name) = Symbol::try_from_val(env, &topics.get(0).unwrap()) {
            if name == target {
                found = Some(data);
            }
        }
    }
    found
}

// ============================================================================
// Happy path — expired records are pruned and archived
// ============================================================================

#[test]
fn test_cleanup_prunes_expired_records_and_archives_them() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let creator = test_env.users.get(0).unwrap().clone();

    set_now(&test_env.env, 1_000);
    let id1 = make_id(&test_env.env, 1);
    let id2 = make_id(&test_env.env, 2);
    schedule(&client, &test_env.env, &id1, &creator, ONE_HOUR);
    schedule(&client, &test_env.env, &id2, &creator, ONE_HOUR);

    // Move past both expiries.
    set_now(&test_env.env, 1_000 + ONE_HOUR + 1);

    let mut ids = Vec::new(&test_env.env);
    ids.push_back(id1.clone());
    ids.push_back(id2.clone());

    let removed = client.cleanup_expired_records(&test_env.admin, &ids);
    assert_eq!(removed, 2, "both expired records must be pruned");

    // Active storage is cleared.
    assert!(
        client.try_get_notification(&id1).is_err(),
        "expired notification must be removed from active storage"
    );
    assert!(client.try_get_notification(&id2).is_err());

    // History is preserved in the immutable archive.
    let archived = client.get_archived_notification(&id1);
    assert_eq!(archived.id, id1);
    assert_eq!(
        archived.archive_reason,
        String::from_str(&test_env.env, "expired")
    );
}

#[test]
fn test_cleanup_emits_records_cleaned_up_event() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let creator = test_env.users.get(0).unwrap().clone();

    set_now(&test_env.env, 1_000);
    let id = make_id(&test_env.env, 3);
    schedule(&client, &test_env.env, &id, &creator, ONE_HOUR);
    set_now(&test_env.env, 1_000 + ONE_HOUR + 1);

    let mut ids = Vec::new(&test_env.env);
    ids.push_back(id);

    let removed = client.cleanup_expired_records(&test_env.admin, &ids);
    assert_eq!(removed, 1);

    let topics = topics_of(&test_env.env, "records_cleaned_up").expect("cleanup event");
    // name + admin + category + priority
    assert_eq!(topics.len(), 4);
    let data = data_of(&test_env.env, "records_cleaned_up").expect("cleanup event data");
    let count = u32::try_from_val(&test_env.env, &data).expect("removed_count");
    assert_eq!(count, 1);
}

// ============================================================================
// Live records are preserved
// ============================================================================

#[test]
fn test_cleanup_keeps_live_notifications() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let creator = test_env.users.get(0).unwrap().clone();

    set_now(&test_env.env, 1_000);
    let id = make_id(&test_env.env, 4);
    schedule(&client, &test_env.env, &id, &creator, ONE_DAY);

    let mut ids = Vec::new(&test_env.env);
    ids.push_back(id.clone());

    let removed = client.cleanup_expired_records(&test_env.admin, &ids);
    assert_eq!(removed, 0, "a live record must not be pruned");

    // Still present and queryable.
    assert_eq!(client.get_notification(&id).creator, creator);
    assert!(
        client.try_get_archived_notification(&id).is_err(),
        "a live record must not be archived"
    );
}

#[test]
fn test_cleanup_mixed_batch_only_prunes_expired() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let creator = test_env.users.get(0).unwrap().clone();

    set_now(&test_env.env, 1_000);
    let live = make_id(&test_env.env, 5);
    let expiring = make_id(&test_env.env, 6);
    schedule(&client, &test_env.env, &live, &creator, ONE_DAY);
    schedule(&client, &test_env.env, &expiring, &creator, ONE_HOUR);

    // Past the short expiry but well inside the long one.
    set_now(&test_env.env, 1_000 + ONE_HOUR + 1);

    let unknown = make_id(&test_env.env, 99);
    let mut ids = Vec::new(&test_env.env);
    ids.push_back(live.clone());
    ids.push_back(expiring.clone());
    ids.push_back(unknown);

    let removed = client.cleanup_expired_records(&test_env.admin, &ids);
    assert_eq!(removed, 1, "only the expired record is pruned");

    assert_eq!(client.get_notification(&live).creator, creator);
    assert!(client.try_get_notification(&expiring).is_err());
}

// ============================================================================
// Unknown ids / empty input are no-ops
// ============================================================================

#[test]
fn test_cleanup_ignores_unknown_ids() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);

    let mut ids = Vec::new(&test_env.env);
    ids.push_back(make_id(&test_env.env, 200));
    ids.push_back(make_id(&test_env.env, 201));

    let removed = client.cleanup_expired_records(&test_env.admin, &ids);
    assert_eq!(removed, 0);
}

#[test]
fn test_cleanup_empty_list_is_ok() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);

    let removed = client.cleanup_expired_records(&test_env.admin, &Vec::new(&test_env.env));
    assert_eq!(removed, 0);
}

// ============================================================================
// Access control
// ============================================================================

#[test]
fn test_cleanup_rejects_non_admin() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let non_admin = test_env.users.get(0).unwrap().clone();

    let result = client.try_cleanup_expired_records(&non_admin, &Vec::new(&test_env.env));
    assert_eq!(result, Err(Ok(Error::Unauthorized)));
}

#[test]
fn test_cleanup_rejects_arbitrary_address() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let stranger = Address::generate(&test_env.env);

    let result = client.try_cleanup_expired_records(&stranger, &Vec::new(&test_env.env));
    assert_eq!(result, Err(Ok(Error::Unauthorized)));
}

// ============================================================================
// Historical / immutable records survive cleanup
// ============================================================================

#[test]
fn test_cleanup_preserves_existing_archives() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let creator = test_env.users.get(0).unwrap().clone();

    // Archive a notification the normal way (via expiry).
    set_now(&test_env.env, 1_000);
    let id = make_id(&test_env.env, 7);
    schedule(&client, &test_env.env, &id, &creator, ONE_HOUR);
    set_now(&test_env.env, 1_000 + ONE_HOUR + 1);
    client.expire_notification(&id);

    let before = client.get_archived_notification(&id);

    // Running cleanup over the already-archived id must not disturb history.
    let mut ids = Vec::new(&test_env.env);
    ids.push_back(id.clone());
    let removed = client.cleanup_expired_records(&test_env.admin, &ids);
    assert_eq!(removed, 0, "the active entry was already reclaimed");

    let after = client.get_archived_notification(&id);
    assert_eq!(after.id, before.id);
    assert_eq!(after.archived_at, before.archived_at);
    assert_eq!(after.archive_reason, before.archive_reason);
    assert_eq!(after.title, before.title);
}
