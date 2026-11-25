//! Deterministic clock tests — #1047.
//!
//! Validates that all time-sensitive contract logic reads the ledger clock
//! through `crate::base::clock::current_time`, and that tests can control
//! time precisely via `env.ledger().set_timestamp()`.
//!
//! Covered:
//! (a) expiry fires exactly at the threshold (boundary-inclusive).
//! (b) expiry does NOT fire one tick before the threshold.
//! (c) expiry fires one tick after the threshold.
//! (d) `advance_by` helper correctly advances the ledger clock forward.
//! (e) scheduling records the correct `created_at` and `expires_at` for a
//!     given ledger time.
//! (f) audit records capture the ledger timestamp at creation time.
//! (g) reputation `last_update` reflects the ledger time at update time.
//! (h) template `created_at` and `updated_at` reflect the ledger clock.

extern crate std;

use crate::base::clock::current_time;
use crate::base::events::NotificationPriority;
use crate::test_utils::setup_test_env;
use crate::AutoShareContractClient;
use soroban_sdk::testutils::Ledger;
use soroban_sdk::{BytesN, Env, String};

// ---------------------------------------------------------------------------
// Helpers — thin wrappers that name the time-control pattern clearly.
// ---------------------------------------------------------------------------

/// Sets the ledger timestamp to an absolute value (seconds since epoch).
fn set_now(env: &Env, timestamp: u64) {
    env.ledger().set_timestamp(timestamp);
}

/// Advances the ledger timestamp by `seconds` relative to its current value.
fn advance_by(env: &Env, seconds: u64) {
    let current = env.ledger().timestamp();
    env.ledger().set_timestamp(current + seconds);
}

fn make_id(env: &Env, tag: u8) -> BytesN<32> {
    let mut bytes = [0u8; 32];
    bytes[0] = tag;
    BytesN::from_array(env, &bytes)
}

fn make_title(env: &Env) -> String {
    String::from_str(env, "Clock test notification")
}

const ONE_HOUR: u64 = 3_600;

// ---------------------------------------------------------------------------
// (current_time) current_time() delegates to env.ledger().timestamp().
// ---------------------------------------------------------------------------

#[test]
fn test_current_time_returns_ledger_timestamp() {
    let env = Env::default();
    set_now(&env, 999_999);
    assert_eq!(
        current_time(&env),
        999_999,
        "current_time must return the value set via set_timestamp"
    );

    advance_by(&env, 1);
    assert_eq!(
        current_time(&env),
        1_000_000,
        "current_time must reflect advance_by changes"
    );
}

// ---------------------------------------------------------------------------
// (d) `advance_by` helper correctly moves the ledger clock forward.
// ---------------------------------------------------------------------------

#[test]
fn test_advance_by_moves_clock_forward() {
    let env = Env::default();

    set_now(&env, 1_000);
    assert_eq!(
        current_time(&env),
        1_000,
        "initial timestamp must match set_now argument"
    );

    advance_by(&env, 500);
    assert_eq!(
        current_time(&env),
        1_500,
        "after advance_by(500), timestamp must be 1_500"
    );

    advance_by(&env, ONE_HOUR);
    assert_eq!(
        current_time(&env),
        1_500 + ONE_HOUR,
        "after another advance_by(ONE_HOUR), timestamp must be 1_500 + ONE_HOUR"
    );
}

// ---------------------------------------------------------------------------
// (a) Expiry fires exactly at the threshold (boundary-inclusive).
// ---------------------------------------------------------------------------

#[test]
fn test_expiry_fires_exactly_at_threshold() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let creator = test_env.users.get(0).unwrap().clone();

    set_now(&test_env.env, 1_000);
    let id = make_id(&test_env.env, 1);
    client.schedule_notification(
        &id,
        &creator,
        &ONE_HOUR,
        &make_title(&test_env.env),
        &NotificationPriority::Medium,
    );

    // One tick before the threshold: not yet expired.
    set_now(&test_env.env, 1_000 + ONE_HOUR - 1);
    assert!(
        !client.is_notification_expired(&id),
        "notification must not be expired one tick before threshold"
    );

    // Exactly at the threshold: expired
    // (`is_expired` uses `>=`, so boundary is inclusive).
    set_now(&test_env.env, 1_000 + ONE_HOUR);
    assert!(
        client.is_notification_expired(&id),
        "notification must be expired exactly at threshold"
    );
}

// ---------------------------------------------------------------------------
// (b) Expiry does NOT fire one tick before the threshold.
// ---------------------------------------------------------------------------

#[test]
fn test_expiry_does_not_fire_one_tick_before_threshold() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let creator = test_env.users.get(0).unwrap().clone();

    set_now(&test_env.env, 5_000);
    let id = make_id(&test_env.env, 2);
    client.schedule_notification(
        &id,
        &creator,
        &ONE_HOUR,
        &make_title(&test_env.env),
        &NotificationPriority::Medium,
    );

    set_now(&test_env.env, 5_000 + ONE_HOUR - 1);
    assert!(
        !client.is_notification_expired(&id),
        "one tick before threshold must not be expired"
    );

    // expire_notification must also be rejected one tick before threshold.
    let result = client.try_expire_notification(&id);
    assert!(
        result.is_err(),
        "expire_notification must be rejected one tick before threshold"
    );
}

// ---------------------------------------------------------------------------
// (c) Expiry fires one tick after the threshold.
// ---------------------------------------------------------------------------

#[test]
fn test_expiry_fires_one_tick_after_threshold() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let creator = test_env.users.get(0).unwrap().clone();

    set_now(&test_env.env, 2_000);
    let id = make_id(&test_env.env, 3);
    client.schedule_notification(
        &id,
        &creator,
        &ONE_HOUR,
        &make_title(&test_env.env),
        &NotificationPriority::Medium,
    );

    set_now(&test_env.env, 2_000 + ONE_HOUR + 1);
    assert!(
        client.is_notification_expired(&id),
        "notification must be expired one tick after threshold"
    );

    let result = client.try_expire_notification(&id);
    assert!(
        result.is_ok(),
        "expire_notification must succeed one tick after threshold"
    );
}

// ---------------------------------------------------------------------------
// (d-extra) advance_by across the expiry boundary triggers expiry.
// ---------------------------------------------------------------------------

#[test]
fn test_advance_by_across_expiry_triggers_expiry() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let creator = test_env.users.get(0).unwrap().clone();

    set_now(&test_env.env, 0);
    let id = make_id(&test_env.env, 4);
    client.schedule_notification(
        &id,
        &creator,
        &ONE_HOUR,
        &make_title(&test_env.env),
        &NotificationPriority::Medium,
    );

    // Advance past expiry in one call.
    advance_by(&test_env.env, ONE_HOUR + 1);
    assert!(
        client.is_notification_expired(&id),
        "advancing past expiry must result in expired notification"
    );
}

// ---------------------------------------------------------------------------
// (e) Scheduling records the correct `created_at` and `expires_at`.
// ---------------------------------------------------------------------------

#[test]
fn test_schedule_records_correct_created_at_and_expires_at() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let creator = test_env.users.get(0).unwrap().clone();

    let start: u64 = 123_456_789;
    let ttl: u64 = 7_200; // 2 hours
    set_now(&test_env.env, start);

    let id = make_id(&test_env.env, 5);
    client.schedule_notification(
        &id,
        &creator,
        &ttl,
        &make_title(&test_env.env),
        &NotificationPriority::Medium,
    );

    let stored = client.get_notification(&id);
    assert_eq!(
        stored.created_at, start,
        "created_at must equal the ledger time at scheduling"
    );
    assert_eq!(
        stored.expires_at,
        start + ttl,
        "expires_at must equal created_at + ttl_seconds"
    );
}

// ---------------------------------------------------------------------------
// (e-extra) Batch scheduling records correct timestamps for all entries.
// ---------------------------------------------------------------------------

#[test]
fn test_batch_schedule_records_correct_timestamps() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let creator = test_env.users.get(0).unwrap().clone();

    let start: u64 = 999_000;
    set_now(&test_env.env, start);

    let ttl_a: u64 = 3_600;
    let ttl_b: u64 = 7_200;

    let mut ids = soroban_sdk::Vec::new(&test_env.env);
    let mut ttls = soroban_sdk::Vec::new(&test_env.env);
    let mut titles = soroban_sdk::Vec::new(&test_env.env);
    let mut priorities = soroban_sdk::Vec::new(&test_env.env);

    ids.push_back(make_id(&test_env.env, 10));
    ids.push_back(make_id(&test_env.env, 11));
    ttls.push_back(ttl_a);
    ttls.push_back(ttl_b);
    titles.push_back(make_title(&test_env.env));
    titles.push_back(make_title(&test_env.env));
    priorities.push_back(NotificationPriority::Medium);
    priorities.push_back(NotificationPriority::High);

    client.batch_schedule_notifications(&ids, &creator, &ttls, &titles, &priorities);

    let stored_a = client.get_notification(&make_id(&test_env.env, 10));
    let stored_b = client.get_notification(&make_id(&test_env.env, 11));

    assert_eq!(stored_a.created_at, start);
    assert_eq!(stored_a.expires_at, start + ttl_a);
    assert_eq!(stored_b.created_at, start);
    assert_eq!(stored_b.expires_at, start + ttl_b);
}

// ---------------------------------------------------------------------------
// (f) Audit records capture the ledger timestamp at creation time.
// ---------------------------------------------------------------------------

#[test]
fn test_audit_record_timestamp_reflects_ledger_clock() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let creator = test_env.users.get(0).unwrap().clone();
    let relay = test_env.users.get(1).unwrap().clone();

    let schedule_ts: u64 = 42_000;
    set_now(&test_env.env, schedule_ts);
    let id = make_id(&test_env.env, 20);
    client.schedule_notification(
        &id,
        &creator,
        &ONE_HOUR,
        &make_title(&test_env.env),
        &NotificationPriority::Medium,
    );

    // Advance the clock before recording a delivery attempt.
    let attempt_ts: u64 = schedule_ts + 100;
    set_now(&test_env.env, attempt_ts);
    client.record_delivery_attempt(&id, &relay);

    let records = client.get_notification_audit(&id);
    assert_eq!(records.len(), 2);
    assert_eq!(
        records.get(0).unwrap().timestamp,
        schedule_ts,
        "Created record must carry the scheduling timestamp"
    );
    assert_eq!(
        records.get(1).unwrap().timestamp,
        attempt_ts,
        "DeliveryAttempt record must carry the attempt timestamp"
    );
}

// ---------------------------------------------------------------------------
// (g) Reputation `last_update` reflects the ledger time at update.
// ---------------------------------------------------------------------------

#[test]
fn test_reputation_last_update_reflects_ledger_clock() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let sender = test_env.users.get(0).unwrap().clone();

    let ts1: u64 = 10_000;
    set_now(&test_env.env, ts1);
    client.record_delivery_success(&sender);

    let rep = client.get_sender_reputation(&sender);
    assert_eq!(
        rep.last_update, ts1,
        "last_update after first success must equal ts1"
    );

    let ts2: u64 = 20_000;
    set_now(&test_env.env, ts2);
    client.record_delivery_success(&sender);

    let rep2 = client.get_sender_reputation(&sender);
    assert_eq!(
        rep2.last_update, ts2,
        "last_update after second success must equal ts2"
    );
}

// ---------------------------------------------------------------------------
// (h) Template `created_at` and `updated_at` reflect the ledger clock.
// ---------------------------------------------------------------------------

#[test]
fn test_template_timestamps_reflect_ledger_clock() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    use soroban_sdk::testutils::Address as _;
    let creator = soroban_sdk::Address::generate(&test_env.env);

    let create_ts: u64 = 55_000;
    set_now(&test_env.env, create_ts);

    let id = make_id(&test_env.env, 30);
    client.register_template(
        &id,
        &creator,
        &String::from_str(&test_env.env, "My Template"),
        &String::from_str(&test_env.env, "Hello, {name}!"),
    );

    let tmpl = client.get_template(&id);
    assert_eq!(
        tmpl.created_at, create_ts,
        "template created_at must equal the ledger time at registration"
    );
    assert!(
        tmpl.updated_at.is_none(),
        "updated_at must be None immediately after registration"
    );

    let update_ts: u64 = 66_000;
    set_now(&test_env.env, update_ts);
    client.update_template(
        &id,
        &creator,
        &String::from_str(&test_env.env, "My Template v2"),
        &String::from_str(&test_env.env, "Hello, {first_name}!"),
    );

    let tmpl2 = client.get_template(&id);
    assert_eq!(
        tmpl2.updated_at,
        Some(update_ts),
        "updated_at must equal the ledger time at the update call"
    );
}
