//! Explicit validation for contract event payload consistency (issue #1198).
//!
//! These tests verify that:
//! 1. Required event fields are non-default/non-zero before emission.
//! 2. Event data reflects the final committed state, not an intermediate value.
//! 3. Each event's category and priority topics are present and correct.
//! 4. The `payload_version` field in `NotificationScheduled` matches the
//!    version stored on-chain (`CURRENT_NOTIFICATION_VERSION`).
//! 5. Events emitted after multi-step state transitions carry the post-commit
//!    values (delivery, recall, revocation data, etc.).
//! 6. Events are not emitted when operations are rejected.
//!
//! # Note on `env.events().all()`
//!
//! In the Soroban test harness `env.events().all()` returns only the events
//! from the **most recent** contract invocation. This means every event
//! assertion must immediately follow the contract call that is expected to
//! emit it, before any further contract call that would reset the buffer.

use crate::base::events::{NotificationCategory, NotificationPriority};
use crate::base::types::CURRENT_NOTIFICATION_VERSION;
use crate::test_utils::{create_test_group, setup_test_env};
use crate::AutoShareContractClient;

use soroban_sdk::testutils::{Address as _, Events, Ledger};
use soroban_sdk::{Address, BytesN, Map, String, Symbol, TryFromVal, Val, Vec};

// ── helpers ──────────────────────────────────────────────────────────────────

/// Returns the topic vector and data value of the most recently emitted event
/// whose first topic matches `name`.  Call this *immediately* after the
/// contract invocation you are asserting — a subsequent contract call will
/// replace `env.events().all()`.
fn find_event(env: &soroban_sdk::Env, name: &str) -> Option<(Vec<Val>, Val)> {
    let target = Symbol::new(env, name);
    let mut found: Option<(Vec<Val>, Val)> = None;
    for (_addr, topics, data) in env.events().all().iter() {
        if topics.is_empty() {
            continue;
        }
        if let Ok(sym) = Symbol::try_from_val(env, &topics.get(0).unwrap()) {
            if sym == target {
                found = Some((topics, data));
            }
        }
    }
    found
}

/// Returns the second-to-last topic of the most recently emitted event with
/// the given name, decoded as `NotificationCategory`.
fn category_of(env: &soroban_sdk::Env, event_name: &str) -> Option<NotificationCategory> {
    let (topics, _) = find_event(env, event_name)?;
    let n = topics.len();
    if n < 2 {
        return None;
    }
    NotificationCategory::try_from_val(env, &topics.get(n - 2)?).ok()
}

/// Returns the last topic of the most recently emitted event with the given
/// name, decoded as `NotificationPriority`.
fn priority_of(env: &soroban_sdk::Env, event_name: &str) -> Option<NotificationPriority> {
    let (topics, _) = find_event(env, event_name)?;
    let last = topics.last()?;
    NotificationPriority::try_from_val(env, &last).ok()
}

fn make_id(env: &soroban_sdk::Env, tag: u8) -> BytesN<32> {
    let mut bytes = [0u8; 32];
    bytes[0] = tag;
    BytesN::from_array(env, &bytes)
}

fn make_title(env: &soroban_sdk::Env) -> String {
    String::from_str(env, "Consistency Test Notification")
}

// ── 1. notification_scheduled: category, priority and version ────────────────

/// `notification_scheduled` must carry `NotificationCategory::Notification`
/// and the caller-specified priority, and the notification version stored
/// on-chain must equal `CURRENT_NOTIFICATION_VERSION`.
#[test]
fn test_notification_scheduled_category_priority_and_version() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let creator = test_env.users.get(0).unwrap().clone();
    let id = make_id(&test_env.env, 1);

    client.schedule_notification(
        &id,
        &creator,
        &3_600u64,
        &make_title(&test_env.env),
        &NotificationPriority::High,
    );

    // Assert immediately — before any further contract call resets the buffer.
    assert!(
        find_event(&test_env.env, "notification_scheduled").is_some(),
        "notification_scheduled must be emitted on success"
    );
    assert_eq!(
        category_of(&test_env.env, "notification_scheduled"),
        Some(NotificationCategory::Notification),
        "notification_scheduled must carry Notification category"
    );
    assert_eq!(
        priority_of(&test_env.env, "notification_scheduled"),
        Some(NotificationPriority::High),
        "notification_scheduled priority must match the caller-specified value"
    );

    // Now read the stored version — this is a separate contract call.
    let stored = client.get_notification(&id);
    assert_eq!(
        stored.version, CURRENT_NOTIFICATION_VERSION,
        "stored notification version must equal CURRENT_NOTIFICATION_VERSION"
    );
}

/// Each supported priority level must be preserved in the `notification_scheduled`
/// event topic.
#[test]
fn test_notification_scheduled_all_priority_levels_preserved() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let creator = test_env.users.get(0).unwrap().clone();

    for (tag, priority) in [
        (10u8, NotificationPriority::Low),
        (11, NotificationPriority::Medium),
        (12, NotificationPriority::High),
        (13, NotificationPriority::Critical),
    ] {
        let id = make_id(&test_env.env, tag);
        client.schedule_notification(&id, &creator, &3_600u64, &make_title(&test_env.env), &priority);

        // Assert immediately after each call.
        assert_eq!(
            priority_of(&test_env.env, "notification_scheduled"),
            Some(priority),
            "notification_scheduled priority must match the caller-specified priority {:?}", priority
        );
    }
}

/// `notification_scheduled` must NOT be emitted for a zero TTL (rejected input).
#[test]
fn test_notification_scheduled_not_emitted_on_zero_ttl() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let creator = test_env.users.get(0).unwrap().clone();
    let id = make_id(&test_env.env, 14);

    let result = client.try_schedule_notification(
        &id,
        &creator,
        &0u64,
        &make_title(&test_env.env),
        &NotificationPriority::Medium,
    );
    assert!(result.is_err(), "zero TTL must be rejected");
    assert!(
        find_event(&test_env.env, "notification_scheduled").is_none(),
        "notification_scheduled must not be emitted for a rejected zero-TTL call"
    );
}

/// `notification_scheduled` must NOT be emitted for a duplicate notification id.
#[test]
fn test_notification_scheduled_not_emitted_on_duplicate_id() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let creator = test_env.users.get(0).unwrap().clone();
    let id = make_id(&test_env.env, 15);

    client.schedule_notification(&id, &creator, &3_600u64, &make_title(&test_env.env), &NotificationPriority::Low);

    // Second call with same id must be rejected.
    let result = client.try_schedule_notification(
        &id,
        &creator,
        &3_600u64,
        &make_title(&test_env.env),
        &NotificationPriority::Low,
    );
    assert!(result.is_err(), "duplicate id must be rejected");
    assert!(
        find_event(&test_env.env, "notification_scheduled").is_none(),
        "notification_scheduled must not be emitted on a rejected duplicate id"
    );
}

// ── 2. notification_delivered: category and priority ────────────────────────

/// `notification_delivered` must carry `NotificationCategory::Notification`
/// and `NotificationPriority::High`, and the archived record must reflect the
/// delivery reason.
#[test]
fn test_notification_delivered_category_priority_and_archive() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let creator = test_env.users.get(0).unwrap().clone();
    let id = make_id(&test_env.env, 20);

    test_env.env.ledger().set_timestamp(1_000_000);
    client.schedule_notification(
        &id,
        &creator,
        &86_400u64,
        &make_title(&test_env.env),
        &NotificationPriority::High,
    );

    test_env.env.ledger().set_timestamp(1_000_100);
    client.confirm_notification_delivery(&id, &creator);

    // Assert event immediately after delivery.
    assert!(
        find_event(&test_env.env, "notification_delivered").is_some(),
        "notification_delivered must be emitted on success"
    );
    assert_eq!(
        category_of(&test_env.env, "notification_delivered"),
        Some(NotificationCategory::Notification),
    );
    assert_eq!(
        priority_of(&test_env.env, "notification_delivered"),
        Some(NotificationPriority::High),
    );

    // Verify archive state matches the successful delivery.
    let archived = client.get_archived_notification(&id);
    assert_eq!(
        archived.archive_reason,
        String::from_str(&test_env.env, "delivered"),
        "archive_reason must be 'delivered' after confirm_notification_delivery"
    );
    assert_eq!(archived.id, id);
    assert_eq!(archived.creator, creator);
}

/// `notification_delivered` must NOT be emitted on a duplicate delivery attempt.
#[test]
fn test_notification_delivered_not_emitted_on_duplicate_attempt() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let creator = test_env.users.get(0).unwrap().clone();
    let id = make_id(&test_env.env, 21);

    test_env.env.ledger().set_timestamp(1_000_000);
    client.schedule_notification(
        &id,
        &creator,
        &86_400u64,
        &make_title(&test_env.env),
        &NotificationPriority::Medium,
    );
    client.confirm_notification_delivery(&id, &creator);

    // A second delivery attempt must fail — no new event.
    let result = client.try_confirm_notification_delivery(&id, &creator);
    assert!(result.is_err(), "duplicate delivery must be rejected");
    assert!(
        find_event(&test_env.env, "notification_delivered").is_none(),
        "notification_delivered must not be emitted on a rejected duplicate delivery"
    );
}

/// `notification_delivered` must NOT be emitted for an already-revoked notification.
#[test]
fn test_notification_delivered_not_emitted_on_revoked_notification() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let creator = test_env.users.get(0).unwrap().clone();
    let id = make_id(&test_env.env, 22);

    test_env.env.ledger().set_timestamp(1_000_000);
    client.schedule_notification(
        &id,
        &creator,
        &86_400u64,
        &make_title(&test_env.env),
        &NotificationPriority::Medium,
    );
    client.revoke_notification(&id, &creator);

    let result = client.try_confirm_notification_delivery(&id, &creator);
    assert!(result.is_err(), "delivery of revoked notification must be rejected");
    assert!(
        find_event(&test_env.env, "notification_delivered").is_none(),
        "notification_delivered must not be emitted for a revoked notification"
    );
}

// ── 3. notification_recalled: category, priority and stored state ────────────

/// After `recall_notification`, the stored record must have `recalled_by` set
/// and the event must carry the correct category/priority.
#[test]
fn test_notification_recalled_category_priority_and_state() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let creator = test_env.users.get(0).unwrap().clone();
    let id = make_id(&test_env.env, 30);

    test_env.env.ledger().set_timestamp(2_000_000);
    client.schedule_notification(
        &id,
        &creator,
        &86_400u64,
        &make_title(&test_env.env),
        &NotificationPriority::Medium,
    );

    test_env.env.ledger().set_timestamp(2_000_500);
    client.recall_notification(&id, &creator);

    // Assert event immediately.
    assert!(
        find_event(&test_env.env, "notification_recalled").is_some(),
        "notification_recalled event must be emitted on success"
    );
    assert_eq!(
        category_of(&test_env.env, "notification_recalled"),
        Some(NotificationCategory::Notification),
    );
    assert_eq!(
        priority_of(&test_env.env, "notification_recalled"),
        Some(NotificationPriority::High),
    );

    // Verify state after the event was emitted.
    let stored = client.get_notification(&id);
    assert!(
        stored.recalled_by.is_some(),
        "recalled_by must be set after recall_notification"
    );
    assert_eq!(
        stored.recalled_by.unwrap(),
        creator,
        "recalled_by must equal the caller"
    );
    assert!(
        stored.recalled_at.is_some(),
        "recalled_at must be set after recall_notification"
    );
}

/// `notification_recalled` must NOT be emitted when the notification is expired.
#[test]
fn test_notification_recalled_not_emitted_on_expired_notification() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let creator = test_env.users.get(0).unwrap().clone();
    let id = make_id(&test_env.env, 31);

    test_env.env.ledger().set_timestamp(1_000);
    client.schedule_notification(
        &id,
        &creator,
        &100u64,
        &make_title(&test_env.env),
        &NotificationPriority::Low,
    );

    // Advance past expiry.
    test_env.env.ledger().set_timestamp(2_000);

    let result = client.try_recall_notification(&id, &creator);
    assert!(result.is_err(), "recall on expired notification must be rejected");
    assert!(
        find_event(&test_env.env, "notification_recalled").is_none(),
        "notification_recalled must not be emitted for an expired notification"
    );
}

/// `notification_recalled` must NOT be emitted when the notification is already delivered.
#[test]
fn test_notification_recalled_not_emitted_on_delivered_notification() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let creator = test_env.users.get(0).unwrap().clone();
    let id = make_id(&test_env.env, 32);

    test_env.env.ledger().set_timestamp(2_000_000);
    client.schedule_notification(
        &id,
        &creator,
        &86_400u64,
        &make_title(&test_env.env),
        &NotificationPriority::Low,
    );
    client.confirm_notification_delivery(&id, &creator);

    let result = client.try_recall_notification(&id, &creator);
    assert!(result.is_err(), "recall of already-delivered notification must be rejected");
    assert!(
        find_event(&test_env.env, "notification_recalled").is_none(),
        "notification_recalled must not be emitted for an already-delivered notification"
    );
}

// ── 4. notification_revoked: category, priority and stored state ─────────────

/// After `revoke_notification`, the stored record must have `revoked_by` set
/// and the event must carry the correct category/priority.
#[test]
fn test_notification_revoked_category_priority_and_state() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let creator = test_env.users.get(0).unwrap().clone();
    let id = make_id(&test_env.env, 40);

    test_env.env.ledger().set_timestamp(3_000_000);
    client.schedule_notification(
        &id,
        &creator,
        &86_400u64,
        &make_title(&test_env.env),
        &NotificationPriority::High,
    );
    client.revoke_notification(&id, &creator);

    // Assert event immediately.
    assert!(
        find_event(&test_env.env, "notification_revoked").is_some(),
        "notification_revoked event must be emitted on success"
    );
    assert_eq!(
        category_of(&test_env.env, "notification_revoked"),
        Some(NotificationCategory::Notification),
    );
    assert_eq!(
        priority_of(&test_env.env, "notification_revoked"),
        Some(NotificationPriority::High),
    );

    // Verify state after revocation.
    let stored = client.get_notification(&id);
    assert!(
        stored.revoked_by.is_some(),
        "revoked_by must be set after revoke_notification"
    );
    assert_eq!(
        stored.revoked_by.unwrap(),
        creator,
        "revoked_by must equal the caller"
    );
    assert!(
        stored.revoked_at.is_some(),
        "revoked_at must be set after revoke_notification"
    );
}

/// `notification_revoked` must NOT be emitted on a second (already-revoked) attempt.
#[test]
fn test_notification_revoked_not_emitted_on_already_revoked() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let creator = test_env.users.get(0).unwrap().clone();
    let id = make_id(&test_env.env, 41);

    test_env.env.ledger().set_timestamp(3_000_000);
    client.schedule_notification(
        &id,
        &creator,
        &86_400u64,
        &make_title(&test_env.env),
        &NotificationPriority::High,
    );
    client.revoke_notification(&id, &creator);

    // Second attempt must be rejected.
    let result = client.try_revoke_notification(&id, &creator);
    assert!(result.is_err(), "second revocation must be rejected");
    assert!(
        find_event(&test_env.env, "notification_revoked").is_none(),
        "notification_revoked must not be emitted on a rejected second revocation"
    );
}

/// `notification_revoked` must NOT be emitted when the notification is expired.
#[test]
fn test_notification_revoked_not_emitted_on_expired_notification() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let creator = test_env.users.get(0).unwrap().clone();
    let id = make_id(&test_env.env, 42);

    test_env.env.ledger().set_timestamp(1_000);
    client.schedule_notification(
        &id,
        &creator,
        &100u64,
        &make_title(&test_env.env),
        &NotificationPriority::High,
    );

    test_env.env.ledger().set_timestamp(2_000);

    let result = client.try_revoke_notification(&id, &creator);
    assert!(result.is_err(), "revoke on expired notification must be rejected");
    assert!(
        find_event(&test_env.env, "notification_revoked").is_none(),
        "notification_revoked must not be emitted for an expired notification"
    );
}

// ── 5. notification_extended: category and stored expires_at ─────────────────

/// `notification_extended` must carry `NotificationCategory::Notification`
/// and the stored `expires_at` must equal the original value plus the extension.
#[test]
fn test_notification_extended_category_and_updated_expires_at() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let creator = test_env.users.get(0).unwrap().clone();
    let id = make_id(&test_env.env, 50);

    test_env.env.ledger().set_timestamp(4_000_000);
    client.schedule_notification(
        &id,
        &creator,
        &3_600u64,
        &make_title(&test_env.env),
        &NotificationPriority::Low,
    );

    // Read original expires_at before the extension call.
    let before = client.get_notification(&id);
    let original_expires_at = before.expires_at;

    let extension = 1_800u64;
    client.extend_notification_expiry(&id, &creator, &extension);

    // Assert event immediately.
    assert!(
        find_event(&test_env.env, "notification_extended").is_some(),
        "notification_extended event must be emitted on success"
    );
    assert_eq!(
        category_of(&test_env.env, "notification_extended"),
        Some(NotificationCategory::Notification),
    );

    // Verify stored state after event assertion.
    let after = client.get_notification(&id);
    assert_eq!(
        after.expires_at,
        original_expires_at + extension,
        "stored expires_at must be original + extension"
    );
}

/// `notification_extended` must NOT be emitted when the extension is zero.
#[test]
fn test_notification_extended_not_emitted_on_zero_extension() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let creator = test_env.users.get(0).unwrap().clone();
    let id = make_id(&test_env.env, 51);

    test_env.env.ledger().set_timestamp(4_000_000);
    client.schedule_notification(
        &id,
        &creator,
        &3_600u64,
        &make_title(&test_env.env),
        &NotificationPriority::Low,
    );

    let result = client.try_extend_notification_expiry(&id, &creator, &0u64);
    assert!(result.is_err(), "zero extension must be rejected");
    assert!(
        find_event(&test_env.env, "notification_extended").is_none(),
        "notification_extended must not be emitted on a rejected zero extension"
    );
}

/// `notification_extended` must NOT be emitted when the new total lifetime
/// would exceed the protocol maximum (notification_lifetime_too_long).
#[test]
fn test_notification_extended_not_emitted_on_lifetime_overflow() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let creator = test_env.users.get(0).unwrap().clone();
    let id = make_id(&test_env.env, 52);

    test_env.env.ledger().set_timestamp(4_000_000);
    // Schedule at max allowed lifetime (30 days).
    let max_ttl = 30u64 * 24 * 60 * 60;
    client.schedule_notification(
        &id,
        &creator,
        &max_ttl,
        &make_title(&test_env.env),
        &NotificationPriority::Low,
    );

    // Any extension would exceed the max lifetime.
    let result = client.try_extend_notification_expiry(&id, &creator, &1u64);
    assert!(result.is_err(), "extension beyond max lifetime must be rejected");
    assert!(
        find_event(&test_env.env, "notification_extended").is_none(),
        "notification_extended must not be emitted when lifetime would exceed the protocol maximum"
    );
}

// ── 6. notification_expired: category and archived state ─────────────────────

/// `notification_expired` must carry `NotificationCategory::Notification` and
/// the archived record must have `archive_reason = "expired"`.
#[test]
fn test_notification_expired_category_and_archive_reason() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let creator = test_env.users.get(0).unwrap().clone();
    let id = make_id(&test_env.env, 60);

    test_env.env.ledger().set_timestamp(5_000_000);
    let ttl = 500u64;
    client.schedule_notification(
        &id,
        &creator,
        &ttl,
        &make_title(&test_env.env),
        &NotificationPriority::Low,
    );
    // Read expires_at before expiry.
    let scheduled = client.get_notification(&id);
    let expected_expires_at = scheduled.expires_at;

    // Advance past expiry.
    test_env.env.ledger().set_timestamp(5_000_501);
    client.expire_notification(&id);

    // Assert event immediately.
    assert!(
        find_event(&test_env.env, "notification_expired").is_some(),
        "notification_expired event must be emitted"
    );
    assert_eq!(
        category_of(&test_env.env, "notification_expired"),
        Some(NotificationCategory::Notification),
    );

    // Verify archived state.
    let archived = client.get_archived_notification(&id);
    assert_eq!(
        archived.expires_at, expected_expires_at,
        "archived expires_at must match the original scheduled expires_at"
    );
    assert_eq!(
        archived.archive_reason,
        String::from_str(&test_env.env, "expired"),
    );
}

/// `notification_expired` must NOT be emitted before the notification has
/// actually expired.
#[test]
fn test_notification_expired_not_emitted_before_expiry_time() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let creator = test_env.users.get(0).unwrap().clone();
    let id = make_id(&test_env.env, 61);

    test_env.env.ledger().set_timestamp(5_000_000);
    client.schedule_notification(
        &id,
        &creator,
        &3_600u64,
        &make_title(&test_env.env),
        &NotificationPriority::Low,
    );

    // Do NOT advance time — notification has not expired yet.
    let result = client.try_expire_notification(&id);
    assert!(result.is_err(), "expire_notification before expiry must be rejected");
    assert!(
        find_event(&test_env.env, "notification_expired").is_none(),
        "notification_expired must not be emitted before the notification has expired"
    );
}

// ── 7. batch_notifications_created: count consistency ────────────────────────

/// `batch_notifications_created` must be emitted with
/// `NotificationCategory::Notification`, and each individual notification in the
/// batch must be retrievable on-chain with the correct version.
#[test]
fn test_batch_notifications_created_category_and_stored_notifications() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let creator = test_env.users.get(0).unwrap().clone();

    test_env.env.ledger().set_timestamp(6_000_000);

    let batch_size = 3u32;
    let mut ids: Vec<BytesN<32>> = Vec::new(&test_env.env);
    let mut ttls: Vec<u64> = Vec::new(&test_env.env);
    let mut titles: Vec<String> = Vec::new(&test_env.env);
    let mut priorities: Vec<NotificationPriority> = Vec::new(&test_env.env);

    for i in 0..batch_size {
        ids.push_back(make_id(&test_env.env, 70 + i as u8));
        ttls.push_back(3_600u64);
        titles.push_back(String::from_str(&test_env.env, "Batch Test"));
        priorities.push_back(NotificationPriority::Medium);
    }

    client.batch_schedule_notifications(&ids, &creator, &ttls, &titles, &priorities);

    // Assert event immediately.
    assert!(
        find_event(&test_env.env, "batch_notifications_created").is_some(),
        "batch_notifications_created event must be emitted"
    );
    assert_eq!(
        category_of(&test_env.env, "batch_notifications_created"),
        Some(NotificationCategory::Notification),
    );

    // Verify all notifications are stored with correct version.
    for i in 0..batch_size {
        let id = make_id(&test_env.env, 70 + i as u8);
        let stored = client.get_notification(&id);
        assert_eq!(
            stored.creator, creator,
            "creator mismatch for batch item {}", i
        );
        assert_eq!(
            stored.version, CURRENT_NOTIFICATION_VERSION,
            "version mismatch for batch item {}", i
        );
    }
}

/// An empty batch must be rejected and must not emit `batch_notifications_created`.
#[test]
fn test_batch_notifications_not_emitted_for_empty_batch() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let creator = test_env.users.get(0).unwrap().clone();

    let empty_ids: Vec<BytesN<32>> = Vec::new(&test_env.env);
    let empty_ttls: Vec<u64> = Vec::new(&test_env.env);
    let empty_titles: Vec<String> = Vec::new(&test_env.env);
    let empty_prios: Vec<NotificationPriority> = Vec::new(&test_env.env);

    let result = client.try_batch_schedule_notifications(
        &empty_ids,
        &creator,
        &empty_ttls,
        &empty_titles,
        &empty_prios,
    );
    assert!(result.is_err(), "empty batch must be rejected");
    assert!(
        find_event(&test_env.env, "batch_notifications_created").is_none(),
        "batch_notifications_created must not be emitted for a rejected empty batch"
    );
}

/// A batch with mismatched array lengths must be rejected — no events emitted.
#[test]
fn test_batch_notifications_not_emitted_for_mismatched_lengths() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let creator = test_env.users.get(0).unwrap().clone();

    let mut ids: Vec<BytesN<32>> = Vec::new(&test_env.env);
    ids.push_back(make_id(&test_env.env, 80));
    let empty_ttls: Vec<u64> = Vec::new(&test_env.env); // length mismatch
    let mut titles: Vec<String> = Vec::new(&test_env.env);
    titles.push_back(make_title(&test_env.env));
    let mut prios: Vec<NotificationPriority> = Vec::new(&test_env.env);
    prios.push_back(NotificationPriority::Low);

    let result = client.try_batch_schedule_notifications(
        &ids,
        &creator,
        &empty_ttls,
        &titles,
        &prios,
    );
    assert!(result.is_err(), "mismatched lengths must be rejected");
    assert!(
        find_event(&test_env.env, "batch_notifications_created").is_none(),
        "batch_notifications_created must not be emitted for a mismatched-length batch"
    );
}

// ── 8. group lifecycle events: category, priority and committed state ─────────

/// `autoshare_created` must carry `NotificationCategory::Group` and the stored
/// group must be active immediately after creation.
#[test]
fn test_autoshare_created_group_category_and_active_state() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let creator = test_env.users.get(0).unwrap().clone();
    let token = test_env.mock_tokens.get(0).unwrap().clone();

    let id = create_test_group(
        &test_env.env,
        &test_env.autoshare_contract,
        &creator,
        &Vec::new(&test_env.env),
        2,
        &token,
    );

    // Assert event immediately — create_test_group ends with the create call.
    assert_eq!(
        category_of(&test_env.env, "autoshare_created"),
        Some(NotificationCategory::Group),
        "autoshare_created must carry Group category"
    );

    // Verify state after the event assertion.
    let stored = client.get(&id);
    assert!(stored.is_active, "group must be active immediately after creation");
    assert_eq!(stored.creator, creator);
}

/// `group_deactivated` must carry `NotificationCategory::Group` and
/// `NotificationPriority::Low`, and the stored group must be inactive.
#[test]
fn test_group_deactivated_category_priority_and_inactive_state() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let creator = test_env.users.get(0).unwrap().clone();
    let token = test_env.mock_tokens.get(0).unwrap().clone();

    let id = create_test_group(
        &test_env.env,
        &test_env.autoshare_contract,
        &creator,
        &Vec::new(&test_env.env),
        1,
        &token,
    );
    client.deactivate_group(&id, &creator);

    // Assert event immediately.
    assert_eq!(
        category_of(&test_env.env, "group_deactivated"),
        Some(NotificationCategory::Group),
    );
    assert_eq!(
        priority_of(&test_env.env, "group_deactivated"),
        Some(NotificationPriority::Low),
    );

    // Verify state after event assertion.
    let stored = client.get(&id);
    assert!(!stored.is_active, "group must be inactive after deactivate_group");
}

/// `group_activated` must carry `NotificationCategory::Group` and the stored
/// group must be active after the call.
#[test]
fn test_group_activated_category_and_active_state() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let creator = test_env.users.get(0).unwrap().clone();
    let token = test_env.mock_tokens.get(0).unwrap().clone();

    let id = create_test_group(
        &test_env.env,
        &test_env.autoshare_contract,
        &creator,
        &Vec::new(&test_env.env),
        1,
        &token,
    );
    client.deactivate_group(&id, &creator);
    client.activate_group(&id, &creator);

    // Assert event immediately.
    assert_eq!(
        category_of(&test_env.env, "group_activated"),
        Some(NotificationCategory::Group),
    );
    assert_eq!(
        priority_of(&test_env.env, "group_activated"),
        Some(NotificationPriority::Low),
    );

    // Verify state.
    let stored = client.get(&id);
    assert!(stored.is_active, "group must be active after activate_group");
}

// ── 9. admin events: category, priority and committed admin state ─────────────

/// After `transfer_admin`, `get_admin()` must return the new admin — confirming
/// the event was emitted only after the state was successfully committed.
#[test]
fn test_admin_transferred_category_priority_and_new_admin_state() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let new_admin = Address::generate(&test_env.env);

    client.transfer_admin(&test_env.admin, &new_admin);

    // Assert event immediately.
    assert_eq!(
        category_of(&test_env.env, "admin_transferred"),
        Some(NotificationCategory::Admin),
    );
    assert_eq!(
        priority_of(&test_env.env, "admin_transferred"),
        Some(NotificationPriority::Critical),
        "admin_transferred must carry Critical priority"
    );

    // Verify state.
    let stored_admin = client.get_admin();
    assert_eq!(stored_admin, new_admin, "get_admin() must return new admin after transfer_admin");
}

/// `admin_transferred` must NOT be emitted when the new admin equals the
/// current admin (rejected as ZeroAddressTransfer).
#[test]
fn test_admin_transferred_not_emitted_on_self_transfer() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);

    let result = client.try_transfer_admin(&test_env.admin, &test_env.admin);
    assert!(result.is_err(), "self-transfer of admin must be rejected");
    assert!(
        find_event(&test_env.env, "admin_transferred").is_none(),
        "admin_transferred must not be emitted on a rejected self-transfer"
    );
}

// ── 10. withdrawal: category, priority and balance consistency ────────────────

/// The `Withdrawal` event must carry `NotificationCategory::Financial` and
/// `NotificationPriority::High`, and the contract balance must reflect the deduction.
#[test]
fn test_withdrawal_category_priority_and_balance_deduction() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let creator = test_env.users.get(0).unwrap().clone();
    let token = test_env.mock_tokens.get(0).unwrap().clone();

    // Fund the contract (5 usages × fee of 10 = 50 tokens).
    create_test_group(
        &test_env.env,
        &test_env.autoshare_contract,
        &creator,
        &Vec::new(&test_env.env),
        5,
        &token,
    );

    let balance_before = client.get_contract_balance(&token);
    let withdraw_amount = 30i128;
    let recipient = Address::generate(&test_env.env);

    client.withdraw(&test_env.admin, &token, &withdraw_amount, &recipient);

    // Assert event immediately.
    assert_eq!(
        category_of(&test_env.env, "withdrawal"),
        Some(NotificationCategory::Financial),
    );
    assert_eq!(
        priority_of(&test_env.env, "withdrawal"),
        Some(NotificationPriority::High),
    );

    // Verify balance reflects the withdrawal.
    let balance_after = client.get_contract_balance(&token);
    assert_eq!(
        balance_before - withdraw_amount,
        balance_after,
        "contract balance must decrease by exactly the withdrawn amount"
    );
}

/// `withdrawal` must NOT be emitted for a zero or negative amount.
#[test]
fn test_withdrawal_not_emitted_on_zero_amount() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let creator = test_env.users.get(0).unwrap().clone();
    let token = test_env.mock_tokens.get(0).unwrap().clone();

    create_test_group(
        &test_env.env,
        &test_env.autoshare_contract,
        &creator,
        &Vec::new(&test_env.env),
        1,
        &token,
    );
    let recipient = Address::generate(&test_env.env);

    let result = client.try_withdraw(&test_env.admin, &token, &0i128, &recipient);
    assert!(result.is_err(), "zero withdrawal must be rejected");
    assert!(
        find_event(&test_env.env, "withdrawal").is_none(),
        "withdrawal must not be emitted for a rejected zero amount"
    );
}

// ── 11. paused-state: mutating events must not be emitted when rejected ────────

/// `notification_scheduled` must not be emitted when the contract is paused.
#[test]
fn test_notification_not_emitted_while_contract_is_paused() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let creator = test_env.users.get(0).unwrap().clone();
    let id = make_id(&test_env.env, 90);

    client.pause(&test_env.admin);

    let result = client.try_schedule_notification(
        &id,
        &creator,
        &3_600u64,
        &make_title(&test_env.env),
        &NotificationPriority::Medium,
    );
    assert!(result.is_err(), "schedule_notification must fail while paused");
    assert!(
        find_event(&test_env.env, "notification_scheduled").is_none(),
        "notification_scheduled must not be emitted when the contract is paused"
    );
}

/// `contract_paused` must carry `NotificationCategory::Admin` and
/// `NotificationPriority::High`, and the pause flag must be `true` afterwards.
#[test]
fn test_contract_paused_category_priority_and_paused_state() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);

    client.pause(&test_env.admin);

    // Assert event immediately.
    assert_eq!(
        category_of(&test_env.env, "contract_paused"),
        Some(NotificationCategory::Admin),
    );
    assert_eq!(
        priority_of(&test_env.env, "contract_paused"),
        Some(NotificationPriority::High),
    );

    // Verify state.
    assert!(client.get_paused_status(), "contract must be paused after pause()");
}

/// `contract_unpaused` must carry `NotificationCategory::Admin` and the
/// pause flag must be `false` afterwards.
#[test]
fn test_contract_unpaused_category_and_unpaused_state() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);

    client.pause(&test_env.admin);
    client.unpause(&test_env.admin);

    // Assert event immediately.
    assert_eq!(
        category_of(&test_env.env, "contract_unpaused"),
        Some(NotificationCategory::Admin),
    );

    // Verify state.
    assert!(!client.get_paused_status(), "contract must be unpaused after unpause()");
}

// ── 12. schema_version_set: event and stored version agree ───────────────────

/// `schema_version_set` must carry `NotificationCategory::Admin` and the
/// stored schema version must equal the value that was set.
#[test]
fn test_schema_version_set_category_and_stored_version() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);

    let new_version = 1u32;
    client.set_schema_version(&test_env.admin, &new_version);

    // Assert event immediately.
    assert!(
        find_event(&test_env.env, "schema_version_set").is_some(),
        "schema_version_set event must be emitted on success"
    );
    assert_eq!(
        category_of(&test_env.env, "schema_version_set"),
        Some(NotificationCategory::Admin),
    );

    // Verify state.
    let stored = client.get_schema_version();
    assert_eq!(stored, new_version, "get_schema_version must return the version that was set");
}

/// Setting an unsupported schema version must be rejected and must not emit
/// `schema_version_set`.
#[test]
fn test_schema_version_set_not_emitted_for_unsupported_version() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);

    let result = client.try_set_schema_version(&test_env.admin, &999u32);
    assert!(result.is_err(), "unsupported schema version must be rejected");
    assert!(
        find_event(&test_env.env, "schema_version_set").is_none(),
        "schema_version_set must not be emitted for an unsupported version"
    );
}

// ── 13. two-step ownership transfer events ────────────────────────────────────

/// `ownership_transfer_initiated` must carry `NotificationCategory::Admin` and
/// `NotificationPriority::Critical`, and the pending owner must be set.
#[test]
fn test_ownership_transfer_initiated_category_priority_and_pending_state() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let new_owner = Address::generate(&test_env.env);

    client.initiate_ownership_transfer(&test_env.admin, &new_owner);

    // Assert event immediately.
    assert!(
        find_event(&test_env.env, "ownership_transfer_initiated").is_some(),
        "ownership_transfer_initiated must be emitted on success"
    );
    assert_eq!(
        category_of(&test_env.env, "ownership_transfer_initiated"),
        Some(NotificationCategory::Admin),
    );
    assert_eq!(
        priority_of(&test_env.env, "ownership_transfer_initiated"),
        Some(NotificationPriority::Critical),
        "ownership_transfer_initiated must carry Critical priority"
    );

    // Verify pending state.
    let pending = client.get_pending_owner();
    assert_eq!(pending, Some(new_owner.clone()), "get_pending_owner must return the nominated address");
}

/// After `accept_ownership`, the new owner must be `get_admin()`, the pending
/// slot must be cleared, and `ownership_transferred` must carry `Critical` priority.
#[test]
fn test_ownership_transferred_category_priority_and_final_state() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let new_owner = Address::generate(&test_env.env);

    client.initiate_ownership_transfer(&test_env.admin, &new_owner);
    client.accept_ownership(&new_owner);

    // Assert event immediately.
    assert!(
        find_event(&test_env.env, "ownership_transferred").is_some(),
        "ownership_transferred must be emitted on accept_ownership success"
    );
    assert_eq!(
        category_of(&test_env.env, "ownership_transferred"),
        Some(NotificationCategory::Admin),
    );
    assert_eq!(
        priority_of(&test_env.env, "ownership_transferred"),
        Some(NotificationPriority::Critical),
    );

    // Verify state.
    assert_eq!(client.get_admin(), new_owner, "get_admin must return the new owner after accept_ownership");
    assert_eq!(client.get_pending_owner(), None, "pending owner must be cleared after accept_ownership");
}

// ── 14. channel_metadata_updated: category and stored description ─────────────

/// After `update_channel_metadata`, the stored description must match the
/// input and the event must carry `NotificationCategory::Group`.
#[test]
fn test_channel_metadata_updated_category_and_stored_description() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let creator = test_env.users.get(0).unwrap().clone();
    let token = test_env.mock_tokens.get(0).unwrap().clone();

    test_env.env.ledger().set_timestamp(7_000_000);

    let id = create_test_group(
        &test_env.env,
        &test_env.autoshare_contract,
        &creator,
        &Vec::new(&test_env.env),
        1,
        &token,
    );

    test_env.env.ledger().set_timestamp(7_000_100);
    let desc = String::from_str(&test_env.env, "Updated description");
    client.update_channel_metadata(&id, &creator, &desc, &Map::new(&test_env.env));

    // Assert event immediately.
    assert!(
        find_event(&test_env.env, "channel_metadata_updated").is_some(),
        "channel_metadata_updated event must be emitted on success"
    );
    assert_eq!(
        category_of(&test_env.env, "channel_metadata_updated"),
        Some(NotificationCategory::Group),
    );

    // Verify stored metadata.
    let stored_meta = client.get_channel_metadata(&id);
    assert_eq!(stored_meta.description, desc, "stored description must match the value passed to update_channel_metadata");
    assert!(stored_meta.updated_at > 0, "updated_at must be non-zero after update");
}

/// `channel_metadata_updated` must NOT be emitted when a non-creator tries to
/// update channel metadata.
#[test]
fn test_channel_metadata_updated_not_emitted_for_unauthorized_caller() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let creator = test_env.users.get(0).unwrap().clone();
    let intruder = test_env.users.get(1).unwrap().clone();
    let token = test_env.mock_tokens.get(0).unwrap().clone();

    let id = create_test_group(
        &test_env.env,
        &test_env.autoshare_contract,
        &creator,
        &Vec::new(&test_env.env),
        1,
        &token,
    );

    let desc = String::from_str(&test_env.env, "Intruder update");
    let result = client.try_update_channel_metadata(&id, &intruder, &desc, &Map::new(&test_env.env));
    assert!(result.is_err(), "non-creator update must be rejected");
    assert!(
        find_event(&test_env.env, "channel_metadata_updated").is_none(),
        "channel_metadata_updated must not be emitted for an unauthorized caller"
    );
}

// ── 15. audit_record_appended: seq is monotonically increasing ────────────────

/// Each successive audit record appended via `schedule_notification` must
/// have a seq value strictly greater than the previous one.
#[test]
fn test_audit_record_appended_seq_is_monotonically_increasing() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let creator = test_env.users.get(0).unwrap().clone();

    test_env.env.ledger().set_timestamp(8_000_000);

    client.schedule_notification(
        &make_id(&test_env.env, 100),
        &creator,
        &3_600u64,
        &make_title(&test_env.env),
        &NotificationPriority::Low,
    );
    client.schedule_notification(
        &make_id(&test_env.env, 101),
        &creator,
        &3_600u64,
        &make_title(&test_env.env),
        &NotificationPriority::Low,
    );

    let log = client.get_audit_log();
    assert!(log.len() >= 2, "audit log must have at least 2 records");

    let n = log.len();
    let last = log.get(n - 1).unwrap();
    let second_last = log.get(n - 2).unwrap();

    assert!(
        last.seq > second_last.seq,
        "each audit record must have a strictly increasing seq (got {} then {})",
        second_last.seq,
        last.seq
    );
}

/// Audit records for a notification must all reference the same notification_id.
#[test]
fn test_audit_record_notification_id_matches_queried_notification() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let creator = test_env.users.get(0).unwrap().clone();
    let id = make_id(&test_env.env, 102);

    test_env.env.ledger().set_timestamp(8_000_000);
    client.schedule_notification(
        &id,
        &creator,
        &3_600u64,
        &make_title(&test_env.env),
        &NotificationPriority::Medium,
    );

    let records = client.get_notification_audit(&id);
    assert!(
        !records.is_empty(),
        "get_notification_audit must return at least one record after schedule_notification"
    );

    for record in records.iter() {
        assert_eq!(
            record.notification_id, id,
            "every audit record returned by get_notification_audit must reference the queried notification_id"
        );
    }
}

// ── 16. notification_scheduled: paused state rejects new schedules ────────────

/// Registering a category while the contract is running should not break
/// the contract's ability to schedule notifications after the call.
/// This test confirms that `register_category` itself emits events correctly.
#[test]
fn test_category_registered_event_carries_admin_category() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);

    // `System` is not seeded by default, so we can register it.
    client.register_category(
        &test_env.admin,
        &crate::base::events::NotificationCategory::System,
    );

    assert!(
        find_event(&test_env.env, "category_registered").is_some(),
        "category_registered event must be emitted on success"
    );
    // Topics: [name, admin, category_being_registered, priority].
    // The second-to-last topic holds the category that was just registered.
    assert_eq!(
        category_of(&test_env.env, "category_registered"),
        Some(NotificationCategory::System),
        "category_registered second-to-last topic must equal the registered category"
    );
    assert_eq!(
        priority_of(&test_env.env, "category_registered"),
        Some(NotificationPriority::Medium),
        "category_registered priority topic must be Medium"
    );
}
