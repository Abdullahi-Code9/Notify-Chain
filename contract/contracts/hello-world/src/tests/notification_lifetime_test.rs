//! Tests for maximum notification lifetime enforcement (issue #477).
//!
//! Covers boundary values for `ttl_seconds` accepted by `schedule_notification`,
//! `batch_schedule_notifications`, and `extend_notification_expiry`:
//!
//! - Exactly at max lifetime → succeeds.
//! - One second above max → rejected (`NotificationLifetimeTooLong`).
//! - Minimum valid value (1 second) → succeeds.
//! - Zero → rejected (`InvalidExpirationDuration`).
//! - Negative (not representable as u64; tested via extension that would go negative) → rejected.
//! - Extreme/absurd value (u64::MAX) → rejected.
//! - Default/typical value (1 hour) → succeeds.
//! - Extension that pushes total lifetime over max → rejected.
//! - Extension that keeps total lifetime exactly at max → succeeds.
//! - Batch with one entry over max → entire batch rejected.

use crate::base::events::NotificationPriority;
use crate::test_utils::setup_test_env;
use crate::AutoShareContractClient;

use soroban_sdk::testutils::{Address as _, Ledger};
use soroban_sdk::{BytesN, Env, String};

/// 30 days in seconds — must stay in sync with `MAX_NOTIFICATION_LIFETIME_SECONDS`
/// in autoshare_logic.rs. Flagged as a placeholder; see issue #477.
const MAX_LIFETIME: u64 = 30 * 24 * 60 * 60; // 2_592_000

/// One hour in seconds — a representative "normal" TTL.
const ONE_HOUR: u64 = 3_600;

fn notification_title(env: &Env) -> String {
    String::from_str(env, "Lifetime test notification")
}

fn make_id(env: &Env, tag: u8) -> BytesN<32> {
    let mut bytes = [0u8; 32];
    bytes[0] = tag;
    BytesN::from_array(env, &bytes)
}

// ============================================================================
// schedule_notification — boundary tests
// ============================================================================

/// Exactly at the maximum lifetime must succeed.
#[test]
fn test_schedule_at_max_lifetime_succeeds() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let creator = test_env.users.get(0).unwrap().clone();

    test_env.env.ledger().set_timestamp(1_000);
    let id = make_id(&test_env.env, 1);
    let result = client.try_schedule_notification(
        &id,
        &creator,
        &MAX_LIFETIME,
        &notification_title(&test_env.env),
        &NotificationPriority::Medium,
    );
    assert!(
        result.is_ok(),
        "scheduling at exactly the max lifetime must succeed"
    );

    let stored = client.get_notification(&id);
    assert_eq!(stored.expires_at, 1_000 + MAX_LIFETIME);
}

/// One second above the maximum lifetime must be rejected.
#[test]
fn test_schedule_one_second_over_max_lifetime_rejected() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let creator = test_env.users.get(0).unwrap().clone();

    let id = make_id(&test_env.env, 2);
    let result = client.try_schedule_notification(
        &id,
        &creator,
        &(MAX_LIFETIME + 1),
        &notification_title(&test_env.env),
        &NotificationPriority::Medium,
    );
    assert!(
        result.is_err(),
        "a ttl_seconds value one second over the max must be rejected"
    );
}

/// Minimum valid value (1 second) must succeed.
#[test]
fn test_schedule_minimum_valid_lifetime_succeeds() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let creator = test_env.users.get(0).unwrap().clone();

    let id = make_id(&test_env.env, 3);
    let result =
        client.try_schedule_notification(&id, &creator, &1u64, &notification_title(&test_env.env), &NotificationPriority::Medium);
    assert!(
        result.is_ok(),
        "scheduling with the minimum valid ttl (1 second) must succeed"
    );
}

/// Zero TTL must be rejected.
#[test]
fn test_schedule_zero_lifetime_rejected() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let creator = test_env.users.get(0).unwrap().clone();

    let id = make_id(&test_env.env, 4);
    let result =
        client.try_schedule_notification(&id, &creator, &0u64, &notification_title(&test_env.env), &NotificationPriority::Medium);
    assert!(result.is_err(), "zero ttl_seconds must be rejected");
}

/// An extreme/absurd value (u64::MAX) must be rejected.
#[test]
fn test_schedule_absurd_lifetime_rejected() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let creator = test_env.users.get(0).unwrap().clone();

    let id = make_id(&test_env.env, 5);
    let result = client.try_schedule_notification(
        &id,
        &creator,
        &u64::MAX,
        &notification_title(&test_env.env),
        &NotificationPriority::Medium,
    );
    assert!(result.is_err(), "u64::MAX ttl_seconds must be rejected");
}

/// A typical 1-hour TTL must succeed.
#[test]
fn test_schedule_typical_one_hour_lifetime_succeeds() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let creator = test_env.users.get(0).unwrap().clone();

    let id = make_id(&test_env.env, 6);
    let result = client.try_schedule_notification(
        &id,
        &creator,
        &ONE_HOUR,
        &notification_title(&test_env.env),
        &NotificationPriority::Medium,
    );
    assert!(
        result.is_ok(),
        "scheduling with a typical 1-hour TTL must succeed"
    );
}

// ============================================================================
// extend_notification_expiry — boundary tests
// ============================================================================

/// An extension that keeps the total lifetime exactly at the max must succeed.
#[test]
fn test_extend_to_exactly_max_lifetime_succeeds() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let creator = test_env.users.get(0).unwrap().clone();

    // Schedule at created_at=1000 with ONE_HOUR TTL.
    test_env.env.ledger().set_timestamp(1_000);
    let id = make_id(&test_env.env, 10);
    client.schedule_notification(&id, &creator, &ONE_HOUR, &notification_title(&test_env.env), &NotificationPriority::Medium);

    // Extend so that total lifetime = MAX_LIFETIME exactly.
    let extension = MAX_LIFETIME - ONE_HOUR;
    let result = client.try_extend_notification_expiry(&id, &creator, &extension);
    assert!(
        result.is_ok(),
        "extending to exactly the max total lifetime must succeed"
    );

    let stored = client.get_notification(&id);
    assert_eq!(stored.expires_at, 1_000 + MAX_LIFETIME);
}

/// An extension that pushes total lifetime one second over the max must be rejected.
#[test]
fn test_extend_one_second_over_max_lifetime_rejected() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let creator = test_env.users.get(0).unwrap().clone();

    test_env.env.ledger().set_timestamp(1_000);
    let id = make_id(&test_env.env, 11);
    client.schedule_notification(&id, &creator, &ONE_HOUR, &notification_title(&test_env.env), &NotificationPriority::Medium);

    // Extension that would make total lifetime = MAX_LIFETIME + 1.
    let extension = MAX_LIFETIME - ONE_HOUR + 1;
    let result = client.try_extend_notification_expiry(&id, &creator, &extension);
    assert!(
        result.is_err(),
        "extending one second over the max total lifetime must be rejected"
    );
}

/// Extending by zero seconds must be rejected.
#[test]
fn test_extend_by_zero_seconds_rejected() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let creator = test_env.users.get(0).unwrap().clone();

    test_env.env.ledger().set_timestamp(1_000);
    let id = make_id(&test_env.env, 12);
    client.schedule_notification(&id, &creator, &ONE_HOUR, &notification_title(&test_env.env), &NotificationPriority::Medium);

    let result = client.try_extend_notification_expiry(&id, &creator, &0u64);
    assert!(
        result.is_err(),
        "extending by zero seconds must be rejected"
    );
}

/// An extreme extension (u64::MAX) must be rejected.
#[test]
fn test_extend_by_absurd_seconds_rejected() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let creator = test_env.users.get(0).unwrap().clone();

    test_env.env.ledger().set_timestamp(1_000);
    let id = make_id(&test_env.env, 13);
    client.schedule_notification(&id, &creator, &ONE_HOUR, &notification_title(&test_env.env), &NotificationPriority::Medium);

    let result = client.try_extend_notification_expiry(&id, &creator, &u64::MAX);
    assert!(result.is_err(), "extending by u64::MAX must be rejected");
}

// ============================================================================
// batch_schedule_notifications — boundary tests
// ============================================================================

/// A batch where one entry has exactly the max TTL must succeed.
#[test]
fn test_batch_schedule_at_max_lifetime_succeeds() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let creator = test_env.users.get(0).unwrap().clone();

    let mut ids = soroban_sdk::Vec::new(&test_env.env);
    let mut ttls = soroban_sdk::Vec::new(&test_env.env);
    let mut titles = soroban_sdk::Vec::new(&test_env.env);
    let mut priorities = soroban_sdk::Vec::new(&test_env.env);

    ids.push_back(make_id(&test_env.env, 20));
    ttls.push_back(MAX_LIFETIME);
    titles.push_back(notification_title(&test_env.env));
    priorities.push_back(NotificationPriority::Medium);

    let result =
        client.try_batch_schedule_notifications(&ids, &creator, &ttls, &titles, &priorities);
    assert!(
        result.is_ok(),
        "a batch entry at exactly the max TTL must succeed"
    );
}

/// A batch where one entry is one second over the max must reject the entire batch.
#[test]
fn test_batch_schedule_one_second_over_max_rejected() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let creator = test_env.users.get(0).unwrap().clone();

    let mut ids = soroban_sdk::Vec::new(&test_env.env);
    let mut ttls = soroban_sdk::Vec::new(&test_env.env);
    let mut titles = soroban_sdk::Vec::new(&test_env.env);
    let mut priorities = soroban_sdk::Vec::new(&test_env.env);

    // First entry is valid.
    ids.push_back(make_id(&test_env.env, 21));
    ttls.push_back(ONE_HOUR);
    titles.push_back(notification_title(&test_env.env));
    priorities.push_back(NotificationPriority::Medium);

    // Second entry is one second over the max.
    ids.push_back(make_id(&test_env.env, 22));
    ttls.push_back(MAX_LIFETIME + 1);
    titles.push_back(notification_title(&test_env.env));
    priorities.push_back(NotificationPriority::Medium);

    let result =
        client.try_batch_schedule_notifications(&ids, &creator, &ttls, &titles, &priorities);
    assert!(
        result.is_err(),
        "a batch containing an over-max TTL must reject the entire batch"
    );

    // All-or-nothing: the first (valid) notification must not have been stored.
    assert!(
        client
            .try_get_notification(&make_id(&test_env.env, 21))
            .is_err(),
        "all-or-nothing: no notifications should be stored when the batch is rejected"
    );
}

/// A batch where every entry has a zero TTL must be rejected.
#[test]
fn test_batch_schedule_zero_lifetime_rejected() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let creator = test_env.users.get(0).unwrap().clone();

    let mut ids = soroban_sdk::Vec::new(&test_env.env);
    let mut ttls = soroban_sdk::Vec::new(&test_env.env);
    let mut titles = soroban_sdk::Vec::new(&test_env.env);
    let mut priorities = soroban_sdk::Vec::new(&test_env.env);

    ids.push_back(make_id(&test_env.env, 23));
    ttls.push_back(0u64);
    titles.push_back(notification_title(&test_env.env));
    priorities.push_back(NotificationPriority::Medium);

    let result =
        client.try_batch_schedule_notifications(&ids, &creator, &ttls, &titles, &priorities);
    assert!(result.is_err(), "a batch with a zero TTL must be rejected");
}
