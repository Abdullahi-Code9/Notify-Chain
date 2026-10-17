//! Extended coverage tests (AGENTS.md acceptance criteria).
//!
//! Fills gaps not covered by existing test files:
//!
//! Payload validation:
//!   - configure_notification_limits boundary validation
//!   - batch per-entry TTL overflow rejection
//!   - audit helpers reject unknown notification ids
//!   - delivery attempt / failure on non-existent notification
//!
//! Event type filtering:
//!   - CategoryRegistered event carries category and priority topics
//!   - NotificationRevoked event has Notification category
//!   - AuditRecordAppended event carries Notification category
//!   - Every emitted event has at least 2 trailing topics (category + priority)
//!
//! Audit logging:
//!   - delivery attempt on a revoked notification is rejected
//!   - delivery failure on a non-existent notification is rejected
//!   - acknowledgment on an expired notification is rejected
//!   - audit log grows monotonically across independent notifications

use crate::base::events::{AuditAction, NotificationCategory, NotificationPriority};
use crate::test_utils::setup_test_env;
use crate::AutoShareContractClient;

use soroban_sdk::testutils::{Address as _, Events, Ledger};
use soroban_sdk::{Address, BytesN, Env, String, Symbol, TryFromVal, Val, Vec};

const ONE_HOUR: u64 = 3_600;

// ── helpers ─────────────────────────────────────────────────────────────────

fn make_id(env: &Env, tag: u8) -> BytesN<32> {
    let mut b = [0u8; 32];
    b[0] = tag;
    b[1] = 0xEC; // namespace: extended_coverage
    BytesN::from_array(env, &b)
}

fn title(env: &Env) -> String {
    String::from_str(env, "EC Test")
}

fn set_ts(env: &Env, ts: u64) {
    env.ledger().set_timestamp(ts);
}

/// Returns all topics of the most recently emitted event named `name`.
fn topics_of(env: &Env, name: &str) -> Option<Vec<Val>> {
    let target = Symbol::new(env, name);
    let mut found: Option<Vec<Val>> = None;
    for (_addr, topics, _data) in env.events().all().iter() {
        if topics.is_empty() {
            continue;
        }
        if let Ok(sym) = Symbol::try_from_val(env, &topics.get(0).unwrap()) {
            if sym == target {
                found = Some(topics);
            }
        }
    }
    found
}

fn last_category(env: &Env) -> Option<NotificationCategory> {
    let (_addr, topics, _data) = env.events().all().last()?;
    let n = topics.len();
    if n < 2 {
        return None;
    }
    NotificationCategory::try_from_val(env, &topics.get(n - 2)?).ok()
}

fn last_priority(env: &Env) -> Option<NotificationPriority> {
    let (_addr, topics, _data) = env.events().all().last()?;
    NotificationPriority::try_from_val(env, &topics.last()?).ok()
}

// ============================================================================
// Payload validation — configure_notification_limits
// ============================================================================

#[test]
fn test_configure_limits_valid_values_accepted() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);

    // Valid: min < max, all non-zero
    client.configure_notification_limits(
        &test_env.admin,
        &1024u32,   // max_payload_size
        &86_400u64, // max_expiration_seconds (1 day)
        &60u64,     // min_expiration_seconds (1 min)
        &50u32,     // max_batch_size
    );

    let limits = client.get_notification_limits();
    assert_eq!(limits.max_payload_size, 1024);
    assert_eq!(limits.max_expiration_seconds, 86_400);
    assert_eq!(limits.min_expiration_seconds, 60);
    assert_eq!(limits.max_batch_size, 50);
}

#[test]
fn test_configure_limits_emits_event_with_admin_category() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);

    client.configure_notification_limits(
        &test_env.admin,
        &512u32,
        &3_600u64,
        &1u64,
        &10u32,
    );

    assert!(
        topics_of(&test_env.env, "notification_limits_configured").is_some(),
        "notification_limits_configured event must be emitted"
    );
    assert_eq!(
        last_category(&test_env.env),
        Some(NotificationCategory::Admin),
        "limits config event must carry Admin category"
    );
}

#[test]
fn test_configure_limits_non_admin_rejected() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let non_admin = Address::generate(&test_env.env);

    let result = client.try_configure_notification_limits(
        &non_admin,
        &1024u32,
        &3_600u64,
        &1u64,
        &10u32,
    );
    assert!(result.is_err(), "non-admin must not configure limits");
}

#[test]
fn test_configure_limits_min_greater_than_max_rejected() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);

    // min_expiration_seconds > max_expiration_seconds — invalid
    let result = client.try_configure_notification_limits(
        &test_env.admin,
        &1024u32,
        &60u64,     // max = 60s
        &3_600u64,  // min = 1h — greater than max
        &10u32,
    );
    assert!(result.is_err(), "min > max expiration must be rejected");
}

#[test]
fn test_configure_limits_zero_batch_size_rejected() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);

    let result = client.try_configure_notification_limits(
        &test_env.admin,
        &1024u32,
        &3_600u64,
        &1u64,
        &0u32, // zero batch size invalid
    );
    assert!(result.is_err(), "zero max_batch_size must be rejected");
}

// ============================================================================
// Payload validation — batch per-entry TTL overflow
// ============================================================================

#[test]
fn test_batch_ttl_overflow_rejected() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let creator = test_env.users.get(0).unwrap().clone();

    // Set a non-zero timestamp so u64::MAX + timestamp overflows.
    set_ts(&test_env.env, 1_000);

    let mut ids: Vec<BytesN<32>> = Vec::new(&test_env.env);
    let mut ttls: Vec<u64> = Vec::new(&test_env.env);
    let mut titles: Vec<String> = Vec::new(&test_env.env);
    let mut priorities: Vec<NotificationPriority> = Vec::new(&test_env.env);
    ids.push_back(make_id(&test_env.env, 1));
    ttls.push_back(u64::MAX); // will overflow when added to timestamp
    titles.push_back(title(&test_env.env));
    priorities.push_back(NotificationPriority::Medium);

    let result =
        client.try_batch_schedule_notifications(&ids, &creator, &ttls, &titles, &priorities);
    assert!(
        result.is_err(),
        "batch with overflow TTL must be rejected"
    );
}

// ============================================================================
// Payload validation — audit helpers on unknown notifications
// ============================================================================

#[test]
fn test_record_delivery_attempt_on_unknown_id_rejected() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let actor = test_env.users.get(0).unwrap().clone();

    let ghost = make_id(&test_env.env, 10);
    let result = client.try_record_delivery_attempt(&ghost, &actor);
    assert!(
        result.is_err(),
        "delivery attempt on unknown notification must be rejected"
    );
}

#[test]
fn test_record_delivery_failure_on_unknown_id_rejected() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let actor = test_env.users.get(0).unwrap().clone();

    let ghost = make_id(&test_env.env, 11);
    let result = client.try_record_delivery_failure(&ghost, &actor);
    assert!(
        result.is_err(),
        "delivery failure on unknown notification must be rejected"
    );
}

#[test]
fn test_record_acknowledgment_on_unknown_id_rejected() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let actor = test_env.users.get(0).unwrap().clone();

    let ghost = make_id(&test_env.env, 12);
    let result = client.try_record_acknowledgment(&ghost, &actor);
    assert!(
        result.is_err(),
        "acknowledgment on unknown notification must be rejected"
    );
}

// ============================================================================
// Payload validation — audit helpers on revoked / expired notifications
// ============================================================================

#[test]
fn test_delivery_attempt_on_revoked_notification_rejected() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let creator = test_env.users.get(0).unwrap().clone();
    let relay = test_env.users.get(1).unwrap().clone();

    let id = make_id(&test_env.env, 20);
    client.schedule_notification(&id, &creator, &ONE_HOUR, &title(&test_env.env), &NotificationPriority::Medium);
    client.revoke_notification(&id, &creator);

    let result = client.try_record_delivery_attempt(&id, &relay);
    assert!(
        result.is_err(),
        "delivery attempt on revoked notification must be rejected"
    );
}

#[test]
fn test_acknowledgment_on_expired_notification_rejected() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let creator = test_env.users.get(0).unwrap().clone();
    let recipient = test_env.users.get(2).unwrap().clone();

    set_ts(&test_env.env, 1_000);
    let id = make_id(&test_env.env, 21);
    client.schedule_notification(&id, &creator, &ONE_HOUR, &title(&test_env.env), &NotificationPriority::Medium);

    // Advance past expiry and finalise.
    set_ts(&test_env.env, 1_000 + ONE_HOUR);
    client.expire_notification(&id);

    let result = client.try_record_acknowledgment(&id, &recipient);
    assert!(
        result.is_err(),
        "acknowledgment on expired notification must be rejected"
    );
}

// ============================================================================
// Event type filtering — CategoryRegistered carries category + priority
// ============================================================================

#[test]
fn test_category_registered_event_carries_category_and_priority() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);

    client.register_category(&test_env.admin, &NotificationCategory::System);

    let topics = topics_of(&test_env.env, "category_registered")
        .expect("category_registered event must be emitted");

    // topics: [0] name, [1] admin, [2] category, [3] priority
    assert_eq!(topics.len(), 4, "category_registered must have 4 topics");

    let category =
        NotificationCategory::try_from_val(&test_env.env, &topics.get(2).unwrap())
            .expect("topic[2] must be a NotificationCategory");
    assert_eq!(
        category,
        NotificationCategory::System,
        "registered category must match"
    );

    let _priority =
        NotificationPriority::try_from_val(&test_env.env, &topics.get(3).unwrap())
            .expect("topic[3] must be a NotificationPriority");
}

// ============================================================================
// Event type filtering — NotificationRevoked has Notification category
// ============================================================================

#[test]
fn test_revoke_notification_event_has_notification_category() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let creator = test_env.users.get(0).unwrap().clone();

    let id = make_id(&test_env.env, 30);
    client.schedule_notification(&id, &creator, &ONE_HOUR, &title(&test_env.env), &NotificationPriority::Medium);
    client.revoke_notification(&id, &creator);

    assert_eq!(
        last_category(&test_env.env),
        Some(NotificationCategory::Notification),
        "notification_revoked must carry Notification category"
    );
}

// ============================================================================
// Event type filtering — AuditRecordAppended carries Notification category
// ============================================================================

#[test]
fn test_audit_record_appended_event_has_notification_category() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let creator = test_env.users.get(0).unwrap().clone();
    let relay = test_env.users.get(1).unwrap().clone();

    let id = make_id(&test_env.env, 40);
    client.schedule_notification(&id, &creator, &ONE_HOUR, &title(&test_env.env), &NotificationPriority::Medium);

    // The AuditRecordAppended event is emitted alongside NotificationScheduled.
    // After a delivery attempt it should again carry the Notification category.
    client.record_delivery_attempt(&id, &relay);

    let topics = topics_of(&test_env.env, "audit_record_appended")
        .expect("audit_record_appended must be emitted");

    // topics: [0] name, [1] notification_id, [2] action, [3] category
    assert_eq!(topics.len(), 4);
    let category =
        NotificationCategory::try_from_val(&test_env.env, &topics.get(3).unwrap())
            .expect("topic[3] must be NotificationCategory");
    assert_eq!(
        category,
        NotificationCategory::Notification,
        "audit_record_appended must carry Notification category"
    );
}

#[test]
fn test_audit_record_appended_carries_correct_action_topic() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let creator = test_env.users.get(0).unwrap().clone();
    let relay = test_env.users.get(1).unwrap().clone();

    let id = make_id(&test_env.env, 41);
    client.schedule_notification(&id, &creator, &ONE_HOUR, &title(&test_env.env), &NotificationPriority::Medium);
    client.record_delivery_failure(&id, &relay);

    let topics = topics_of(&test_env.env, "audit_record_appended").unwrap();
    let action =
        AuditAction::try_from_val(&test_env.env, &topics.get(2).unwrap())
            .expect("topic[2] must be AuditAction");
    // Most recent audit_record_appended should be for the delivery failure.
    assert_eq!(
        action,
        AuditAction::DeliveryFailed,
        "most recent audit event action must be DeliveryFailed"
    );
}

// ============================================================================
// Event type filtering — all emitted events have category + priority topics
// ============================================================================

#[test]
fn test_ownership_transfer_events_have_admin_category() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let new_owner = Address::generate(&test_env.env);

    client.initiate_ownership_transfer(&test_env.admin, &new_owner);
    assert_eq!(
        last_category(&test_env.env),
        Some(NotificationCategory::Admin),
        "ownership_transfer_initiated must carry Admin category"
    );
    assert_eq!(
        last_priority(&test_env.env),
        Some(NotificationPriority::Critical),
        "ownership transfer must be Critical priority"
    );

    client.accept_ownership(&new_owner);
    assert_eq!(
        last_category(&test_env.env),
        Some(NotificationCategory::Admin),
        "ownership_transferred must carry Admin category"
    );
    assert_eq!(
        last_priority(&test_env.env),
        Some(NotificationPriority::Critical),
    );
}

#[test]
fn test_notification_expired_event_has_notification_category() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let creator = test_env.users.get(0).unwrap().clone();

    set_ts(&test_env.env, 2_000);
    let id = make_id(&test_env.env, 50);
    client.schedule_notification(&id, &creator, &ONE_HOUR, &title(&test_env.env), &NotificationPriority::Medium);

    set_ts(&test_env.env, 2_000 + ONE_HOUR);
    client.expire_notification(&id);

    let topics = topics_of(&test_env.env, "notification_expired")
        .expect("notification_expired event must be emitted");
    // topics: [0] name, [1] notification_id, [2] category, [3] priority
    let category =
        NotificationCategory::try_from_val(&test_env.env, &topics.get(2).unwrap()).unwrap();
    assert_eq!(category, NotificationCategory::Notification);
}

#[test]
fn test_notification_delivered_event_has_notification_category() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let creator = test_env.users.get(0).unwrap().clone();

    let id = make_id(&test_env.env, 51);
    client.schedule_notification(&id, &creator, &ONE_HOUR, &title(&test_env.env), &NotificationPriority::Medium);
    client.confirm_notification_delivery(&id, &creator);

    assert_eq!(
        last_category(&test_env.env),
        Some(NotificationCategory::Notification),
        "notification_delivered must carry Notification category"
    );
}

#[test]
fn test_notification_recalled_event_has_notification_category() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let creator = test_env.users.get(0).unwrap().clone();

    let id = make_id(&test_env.env, 52);
    client.schedule_notification(&id, &creator, &ONE_HOUR, &title(&test_env.env), &NotificationPriority::Medium);
    client.recall_notification(&id, &creator);

    assert_eq!(
        last_category(&test_env.env),
        Some(NotificationCategory::Notification),
        "notification_recalled must carry Notification category"
    );
}

// ============================================================================
// Audit logging — log grows monotonically across multiple notifications
// ============================================================================

#[test]
fn test_audit_log_grows_across_independent_notifications() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let creator = test_env.users.get(0).unwrap().clone();
    let relay = test_env.users.get(1).unwrap().clone();

    // Interleave operations on three independent notifications.
    let ids: [BytesN<32>; 3] = [
        make_id(&test_env.env, 60),
        make_id(&test_env.env, 61),
        make_id(&test_env.env, 62),
    ];

    for id in &ids {
        client.schedule_notification(id, &creator, &ONE_HOUR, &title(&test_env.env), &NotificationPriority::Medium);
    }
    // 3 Created records.
    assert_eq!(client.get_audit_log().len(), 3);

    client.record_delivery_attempt(&ids[0], &relay);
    client.record_delivery_attempt(&ids[1], &relay);
    // 5 records total.
    assert_eq!(client.get_audit_log().len(), 5);

    client.record_delivery_failure(&ids[0], &relay);
    client.record_acknowledgment(&ids[2], &creator);
    // 7 records total.
    assert_eq!(client.get_audit_log().len(), 7);

    // Sequence numbers are strictly ascending.
    let log = client.get_audit_log();
    for i in 1..log.len() {
        assert!(log.get(i).unwrap().seq > log.get(i - 1).unwrap().seq);
    }
}

#[test]
fn test_audit_log_seq_starts_at_one() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let creator = test_env.users.get(0).unwrap().clone();

    let id = make_id(&test_env.env, 70);
    client.schedule_notification(&id, &creator, &ONE_HOUR, &title(&test_env.env), &NotificationPriority::Medium);

    let log = client.get_audit_log();
    assert_eq!(log.len(), 1);
    assert_eq!(log.get(0).unwrap().seq, 1, "first seq must be 1");
}

#[test]
fn test_audit_records_per_notification_match_full_log_subset() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let creator = test_env.users.get(0).unwrap().clone();
    let relay = test_env.users.get(1).unwrap().clone();

    let id_a = make_id(&test_env.env, 80);
    let id_b = make_id(&test_env.env, 81);

    client.schedule_notification(&id_a, &creator, &ONE_HOUR, &title(&test_env.env), &NotificationPriority::Medium);
    client.schedule_notification(&id_b, &creator, &ONE_HOUR, &title(&test_env.env), &NotificationPriority::Medium);
    client.record_delivery_attempt(&id_a, &relay);
    client.record_delivery_failure(&id_a, &relay);
    client.record_delivery_attempt(&id_b, &relay);

    // Full log: 5 records total.
    assert_eq!(client.get_audit_log().len(), 5);

    // Per-notification filter must match a subset of the full log.
    let records_a = client.get_notification_audit(&id_a);
    assert_eq!(records_a.len(), 3); // Created + Attempt + Failed

    let records_b = client.get_notification_audit(&id_b);
    assert_eq!(records_b.len(), 2); // Created + Attempt

    // Every record must belong to the queried notification.
    for r in records_a.iter() {
        assert_eq!(r.notification_id, id_a);
    }
    for r in records_b.iter() {
        assert_eq!(r.notification_id, id_b);
    }
}

// ============================================================================
// Payload validation — consumers can filter via category on every event type
// ============================================================================

#[test]
fn test_subscription_cancelled_has_group_category() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let creator = test_env.users.get(0).unwrap().clone();
    let token = test_env.mock_tokens.get(0).unwrap().clone();

    crate::test_utils::mint_tokens(&test_env.env, &token, &creator, 1_000_000);
    let id = crate::test_utils::create_test_group(
        &test_env.env,
        &test_env.autoshare_contract,
        &creator,
        &Vec::new(&test_env.env),
        1,
        &token,
    );

    client.cancel_subscription(&id, &creator);

    assert_eq!(
        last_category(&test_env.env),
        Some(NotificationCategory::Group),
        "subscription_cancelled must carry Group category"
    );
}

#[test]
fn test_schema_version_set_has_admin_category() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);

    client.set_schema_version(&test_env.admin, &1u32);

    assert_eq!(
        last_category(&test_env.env),
        Some(NotificationCategory::Admin),
        "schema_version_set must carry Admin category"
    );
}

#[test]
fn test_notification_accessed_has_notification_category() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let creator = test_env.users.get(0).unwrap().clone();
    let accessor = test_env.users.get(1).unwrap().clone();

    let id = make_id(&test_env.env, 90);
    client.schedule_notification(&id, &creator, &ONE_HOUR, &title(&test_env.env), &NotificationPriority::Medium);
    client.record_notification_access(&id, &accessor);

    let topics = topics_of(&test_env.env, "notification_accessed")
        .expect("notification_accessed event must be emitted");
    // topics: [0] name, [1] notification_id, [2] accessor, [3] category
    assert_eq!(topics.len(), 4);
    let category =
        NotificationCategory::try_from_val(&test_env.env, &topics.get(3).unwrap()).unwrap();
    assert_eq!(category, NotificationCategory::Notification);
}
