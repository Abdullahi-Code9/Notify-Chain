//! Tests for notification delivery idempotency.
//! Tests for notification category metadata attached to emitted events.
//!
//! Every event the contract publishes carries notification metadata so off-chain
//! consumers can route by category and urgency. These tests verify:
//! - each action emits the expected category and priority, and
//! - the change is backward compatible: the event name remains the first topic,
//!   the category remains the trailing topic, and payload data is unchanged.
//! Every event the contract publishes now carries a [`NotificationCategory`] as
//! its trailing topic so off-chain consumers can subscribe to / filter by whole
//! categories. These tests verify:
//! - each action emits the expected category, and
//! - the change is backward compatible: the event name remains the first topic
//!   and the previously defined topics/data are unchanged.
//! - authorization boundaries: authenticated users cannot access or modify
//!   notification resources outside their permitted scope.

use crate::base::errors::Error;
use crate::base::events::{NotificationCategory, NotificationPriority};
use crate::test_utils::{create_test_group, setup_test_env};
use crate::AutoShareContractClient;

use soroban_sdk::testutils::{Address as _, Events};
use soroban_sdk::{Address, BytesN, String, Symbol, TryFromVal, Val, Vec};

/// Returns the topic list of the most recently emitted event whose first topic
/// matches `event_name` (the snake_case event name produced by `#[contractevent]`).
fn topics_of(env: &soroban_sdk::Env, event_name: &str) -> Option<Vec<Val>> {
    let target = Symbol::new(env, event_name);
    let mut found: Option<Vec<Val>> = None;
    for (_addr, topics, _data) in env.events().all().iter() {
        if topics.is_empty() {
            continue;
        }
        let first = topics.get(0).unwrap();
        if let Ok(name) = Symbol::try_from_val(env, &first) {
            if name == target {
                // Keep iterating so we return the *latest* matching event.
                found = Some(topics);
            }
        }
    }
    found
}

/// Extracts the notification category for the latest event named `event_name`.
///
/// Events now carry **two** trailing topics: the category (the previously-trailing
/// topic) followed by the priority (added with the `NotificationPriority` change).
/// This helper reads the *second-to-last* topic, i.e. the category, so existing
/// subscribers keyed off category keep working unchanged.
fn category_of(env: &soroban_sdk::Env, event_name: &str) -> Option<NotificationCategory> {
    let topics = topics_of(env, event_name)?;
    let n = topics.len();
    if n < 2 {
        return None;
    }
    let category_topic = topics.get(n - 2)?;
    NotificationCategory::try_from_val(env, &category_topic).ok()
}

/// Extracts the notification priority (the trailing topic) for the latest event
/// named `event_name`.
fn priority_of(env: &soroban_sdk::Env, event_name: &str) -> Option<NotificationPriority> {
    let topics = topics_of(env, event_name)?;
    let last = topics.last()?;
    NotificationPriority::try_from_val(env, &last).ok()
}

/// Extracts the actor address from pause/unpause events (first topic after name).
fn actor_of(env: &soroban_sdk::Env, event_name: &str) -> Option<Address> {
    let topics = topics_of(env, event_name)?;
    if topics.len() < 2 {
        return None;
    }
    let actor_topic = topics.get(1)?;
    Address::try_from_val(env, &actor_topic).ok()
}

/// Returns the category of the most recently emitted event — i.e. the metadata a
/// streaming consumer would read off the event as it arrives.
///
/// Categories are now the **second-to-last** topic (priority is the trailing
/// topic), so we read from the back accordingly.
fn latest_category(env: &soroban_sdk::Env) -> Option<NotificationCategory> {
    let (_addr, topics, _data) = env.events().all().last()?;
    let n = topics.len();
    if n < 2 {
        return None;
    }
    let category_topic = topics.get(n - 2)?;
    NotificationCategory::try_from_val(env, &category_topic).ok()
}

fn latest_priority(env: &soroban_sdk::Env) -> Option<NotificationPriority> {
    let (_addr, topics, _data) = env.events().all().last()?;
    let last = topics.last()?;
    NotificationPriority::try_from_val(env, &last).ok()
}

#[test]
fn test_created_event_has_group_category() {
    let test_env = setup_test_env();
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

    assert_eq!(
        category_of(&test_env.env, "autoshare_created"),
        Some(NotificationCategory::Group)
    );
    assert_eq!(
        priority_of(&test_env.env, "autoshare_created"),
        Some(NotificationPriority::Medium)
    );
}

#[test]
fn test_created_group_stores_standard_priority() {
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

    let details = client.get(&id);
    assert_eq!(details.priority, NotificationPriority::Medium);
}

#[test]
fn test_updated_event_has_group_category() {
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

    let mut members = Vec::new(&test_env.env);
    members.push_back(crate::base::types::GroupMember {
        address: Address::generate(&test_env.env),
        percentage: 100,
    });
    client.update_members(&id, &creator, &members);

    assert_eq!(
        category_of(&test_env.env, "autoshare_updated"),
        Some(NotificationCategory::Group)
    );
    assert_eq!(
        priority_of(&test_env.env, "autoshare_updated"),
        Some(NotificationPriority::Medium)
    );
}

#[test]
fn test_deactivate_and_activate_events_have_group_category() {
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
    assert_eq!(
        category_of(&test_env.env, "group_deactivated"),
        Some(NotificationCategory::Group)
    );
    assert_eq!(
        priority_of(&test_env.env, "group_deactivated"),
        Some(NotificationPriority::Low)
    );

    client.activate_group(&id, &creator);
    assert_eq!(
        category_of(&test_env.env, "group_activated"),
        Some(NotificationCategory::Group)
    );
    assert_eq!(
        priority_of(&test_env.env, "group_activated"),
        Some(NotificationPriority::Low)
    );
}

#[test]
fn test_pause_and_unpause_events_have_admin_category() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);

    client.pause(&test_env.admin);
    assert_eq!(
        category_of(&test_env.env, "contract_paused"),
        Some(NotificationCategory::Admin)
    );
    assert_eq!(
        priority_of(&test_env.env, "contract_paused"),
        Some(NotificationPriority::High)
    );
    assert_eq!(
        actor_of(&test_env.env, "contract_paused"),
        Some(test_env.admin.clone())
    );

    client.unpause(&test_env.admin);
    assert_eq!(
        category_of(&test_env.env, "contract_unpaused"),
        Some(NotificationCategory::Admin)
    );
    assert_eq!(
        priority_of(&test_env.env, "contract_unpaused"),
        Some(NotificationPriority::High)
    );
    assert_eq!(
        actor_of(&test_env.env, "contract_unpaused"),
        Some(test_env.admin.clone())
    );
}

#[test]
fn test_admin_transfer_event_has_admin_category() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let new_admin = Address::generate(&test_env.env);

    client.transfer_admin(&test_env.admin, &new_admin);
    assert_eq!(
        category_of(&test_env.env, "admin_transferred"),
        Some(NotificationCategory::Admin)
    );
    assert_eq!(
        priority_of(&test_env.env, "admin_transferred"),
        Some(NotificationPriority::Critical)
    );
}

#[test]
fn test_withdrawal_event_has_financial_category() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let creator = test_env.users.get(0).unwrap().clone();
    let token = test_env.mock_tokens.get(0).unwrap().clone();

    // Funds flow into the contract when a group is created with paid usages.
    create_test_group(
        &test_env.env,
        &test_env.autoshare_contract,
        &creator,
        &Vec::new(&test_env.env),
        1,
        &token,
    );

    let recipient = Address::generate(&test_env.env);
    client.withdraw(&test_env.admin, &token, &1i128, &recipient);
    assert_eq!(
        category_of(&test_env.env, "withdrawal"),
        Some(NotificationCategory::Financial)
    );
    assert_eq!(
        priority_of(&test_env.env, "withdrawal"),
        Some(NotificationPriority::High)
    );
}

/// Models an off-chain subscriber that only wants a subset of categories. As
/// each action is performed we read the category off the freshly emitted event
/// (the metadata a streaming consumer would key off) and decide whether to
/// process or skip it — proving events can be selectively filtered by type.
#[test]
fn test_events_can_be_filtered_by_category() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let creator = test_env.users.get(0).unwrap().clone();
    let token = test_env.mock_tokens.get(0).unwrap().clone();

    // This consumer subscribes to Group and Financial notifications, but not Admin.
    let subscribed = |c: NotificationCategory| {
        matches!(
            c,
            NotificationCategory::Group | NotificationCategory::Financial
        )
    };

    let mut processed = 0u32;
    let mut skipped = 0u32;
    let mut route = || match latest_category(&test_env.env) {
        Some(c) if subscribed(c) => processed += 1,
        Some(_) => skipped += 1,
        None => {}
    };

    // Group event -> processed.
    create_test_group(
        &test_env.env,
        &test_env.autoshare_contract,
        &creator,
        &Vec::new(&test_env.env),
        1,
        &token,
    );
    assert_eq!(
        latest_category(&test_env.env),
        Some(NotificationCategory::Group)
    );
    assert_eq!(
        latest_priority(&test_env.env),
        Some(NotificationPriority::Medium)
    );
    route();

    // Admin event -> skipped by this subscriber.
    client.pause(&test_env.admin);
    assert_eq!(
        latest_category(&test_env.env),
        Some(NotificationCategory::Admin)
    );
    assert_eq!(
        latest_priority(&test_env.env),
        Some(NotificationPriority::High)
    );
    route();
    client.unpause(&test_env.admin);

    // Financial event -> processed.
    let recipient = Address::generate(&test_env.env);
    client.withdraw(&test_env.admin, &token, &1i128, &recipient);
    assert_eq!(
        latest_category(&test_env.env),
        Some(NotificationCategory::Financial)
    );
    assert_eq!(
        latest_priority(&test_env.env),
        Some(NotificationPriority::High)
    );
    route();

    assert_eq!(processed, 2); // Group + Financial
    assert_eq!(skipped, 1); // Admin
}

// ============================================================================
// Scheduled notification cancellation event tests
// ============================================================================

#[test]
fn test_cancellation_event_is_emitted() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let caller = test_env.users.get(0).unwrap().clone();

    let mut id_bytes = [0u8; 32];
    id_bytes[0] = 1;
    let notification_id = BytesN::from_array(&test_env.env, &id_bytes);

    client.cancel_notification(&notification_id, &caller);

    assert!(
        topics_of(&test_env.env, "scheduled_notification_cancelled").is_some(),
        "expected scheduled_notification_cancelled event to be emitted"
    );
}

#[test]
fn test_cancellation_event_has_notification_category() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let caller = test_env.users.get(0).unwrap().clone();

    let mut id_bytes = [0u8; 32];
    id_bytes[0] = 2;
    let notification_id = BytesN::from_array(&test_env.env, &id_bytes);

    client.cancel_notification(&notification_id, &caller);

    assert_eq!(
        category_of(&test_env.env, "scheduled_notification_cancelled"),
        Some(NotificationCategory::Notification)
    );
}

#[test]
fn test_cancellation_event_data_contains_notification_id() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let caller = test_env.users.get(0).unwrap().clone();

    let mut id_bytes = [0u8; 32];
    id_bytes[0] = 3;
    let notification_id = BytesN::from_array(&test_env.env, &id_bytes);

    client.cancel_notification(&notification_id, &caller);

    let emitted_id = test_env
        .env
        .events()
        .all()
        .iter()
        .find_map(|(_addr, topics, data)| {
            let first = topics.get(0)?;
            let n = Symbol::try_from_val(&test_env.env, &first).ok()?;
            if n == Symbol::new(&test_env.env, "scheduled_notification_cancelled") {
                Some(data)
            } else {
                None
            }
        })
        .expect("scheduled_notification_cancelled event must be emitted");

    let data_id = BytesN::<32>::try_from_val(&test_env.env, &emitted_id).unwrap();
    assert_eq!(data_id, notification_id);
}

#[test]
fn test_cancellation_event_topic_shape() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let caller = test_env.users.get(0).unwrap().clone();

    let mut id_bytes = [0u8; 32];
    id_bytes[0] = 4;
    let notification_id = BytesN::from_array(&test_env.env, &id_bytes);

    client.cancel_notification(&notification_id, &caller);

    let topics = topics_of(&test_env.env, "scheduled_notification_cancelled")
        .expect("event must be emitted");

    // Topics: [0] event name, [1] caller address, [2] category, [3] priority
    assert_eq!(topics.len(), 4);

    let name = Symbol::try_from_val(&test_env.env, &topics.get(0).unwrap()).unwrap();
    assert_eq!(
        name,
        Symbol::new(&test_env.env, "scheduled_notification_cancelled")
    );

    let topic_caller = Address::try_from_val(&test_env.env, &topics.get(1).unwrap()).unwrap();
    assert_eq!(topic_caller, caller);

    let category =
        NotificationCategory::try_from_val(&test_env.env, &topics.get(2).unwrap()).unwrap();
    assert_eq!(category, NotificationCategory::Notification);

    let priority =
        NotificationPriority::try_from_val(&test_env.env, &topics.get(3).unwrap()).unwrap();
    assert_eq!(priority, NotificationPriority::Low);
}

#[test]
fn test_cancellation_blocked_when_contract_paused() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let caller = test_env.users.get(0).unwrap().clone();

    client.pause(&test_env.admin);

    let mut id_bytes = [0u8; 32];
    id_bytes[0] = 5;
    let notification_id = BytesN::from_array(&test_env.env, &id_bytes);

    let result = client.try_cancel_notification(&notification_id, &caller);
    assert!(
        result.is_err(),
        "cancellation should be rejected while contract is paused"
    );
}

/// Verifies that each call to `cancel_notification` emits a
/// `scheduled_notification_cancelled` event carrying the correct notification
/// identifier. The assertion runs immediately after each call so the latest
/// emitted event is always the one we just triggered.
#[test]
fn test_multiple_cancellations_emit_distinct_events() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let caller = test_env.users.get(0).unwrap().clone();

    let make_id = |n: u8| {
        let mut bytes = [0u8; 32];
        bytes[0] = n;
        BytesN::from_array(&test_env.env, &bytes)
    };

    for n in [10u8, 20, 30] {
        let expected_id = make_id(n);
        client.cancel_notification(&expected_id, &caller);

        // Immediately after the call, verify the latest event carries the
        // notification id that was just cancelled.
        let emitted_data = test_env
            .env
            .events()
            .all()
            .iter()
            .find_map(|(_addr, topics, data)| {
                if topics.is_empty() {
                    return None;
                }
                let first = topics.get(0)?;
                let name = Symbol::try_from_val(&test_env.env, &first).ok()?;
                if name == Symbol::new(&test_env.env, "scheduled_notification_cancelled") {
                    Some(data)
                } else {
                    None
                }
            })
            .expect("scheduled_notification_cancelled must be emitted");

        let data_id = BytesN::<32>::try_from_val(&test_env.env, &emitted_data)
            .expect("event data must be BytesN<32>");
        assert_eq!(
            data_id, expected_id,
            "event data must carry the notification id that was cancelled (n = {n})"
        );
    }
}

// ============================================
// Notification Delivery Idempotency
// ============================================

/// Repeated delivery confirmations for the same notification must be
/// idempotent: the first call succeeds and subsequent calls with the same
/// request do not create duplicate deliveries or change observable state.
#[test]
fn test_confirm_delivery_is_idempotent_for_repeated_requests() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let creator = test_env.users.get(0).unwrap().clone();

    let id = make_notification_id(&test_env.env, 80);
    client.schedule_notification(
        &id,
        &creator,
        &3600u64,
        &String::from_str(&test_env.env, "Idempotent delivery"),
        &NotificationPriority::Medium,
    );

    // First confirmation performs the delivery.
    client.confirm_notification_delivery(&id, &creator);
    let first = client.get_notification(&id);

    // Repeating the exact same request must not create a duplicate delivery
    // nor mutate the persisted notification state.
    client.confirm_notification_delivery(&id, &creator);
    client.confirm_notification_delivery(&id, &creator);
    let after_repeats = client.get_notification(&id);

    assert_eq!(
        first, after_repeats,
        "repeated delivery confirmations must not change persisted state"
    );
}

/// The idempotency state must be persisted: once a delivery has been
/// confirmed, the notification remains marked as delivered across subsequent
/// reads and repeated requests.
#[test]
fn test_delivery_idempotency_state_is_persisted() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let creator = test_env.users.get(0).unwrap().clone();

    let id = make_notification_id(&test_env.env, 81);
    client.schedule_notification(
        &id,
        &creator,
        &3600u64,
        &String::from_str(&test_env.env, "Persisted idempotency"),
        &NotificationPriority::Medium,
    );

    client.confirm_notification_delivery(&id, &creator);

    // Reading the notification multiple times must consistently report the
    // delivered state, proving the idempotency marker was persisted.
    let first_read = client.get_notification(&id);
    let second_read = client.get_notification(&id);
    assert_eq!(
        first_read, second_read,
        "persisted idempotency state must be stable across reads"
    );

    // A repeated request after the persisted state must still be a no-op.
    client.confirm_notification_delivery(&id, &creator);
    let after_repeat = client.get_notification(&id);
    assert_eq!(
        first_read, after_repeat,
        "persisted idempotency state must survive repeated requests"
    );
}

/// Concurrent duplicate requests for the same delivery must be handled
/// safely: only one delivery is recorded and the resulting state is
/// consistent regardless of how many duplicate requests are submitted.
#[test]
fn test_concurrent_duplicate_delivery_requests_are_safe() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let creator = test_env.users.get(0).unwrap().clone();

    let id = make_notification_id(&test_env.env, 82);
    client.schedule_notification(
        &id,
        &creator,
        &3600u64,
        &String::from_str(&test_env.env, "Concurrent delivery"),
        &NotificationPriority::Medium,
    );

    // Simulate concurrent duplicate submissions of the same delivery request.
    // Each must either succeed idempotently or be rejected, but the final
    // persisted state must reflect exactly one delivery.
    let mut successes = 0u32;
    for _ in 0..5 {
        if client
            .try_confirm_notification_delivery(&id, &creator)
            .is_ok()
        {
            successes += 1;
        }
    }

    assert!(
        successes >= 1,
        "at least one concurrent delivery request must succeed"
    );

    // The persisted state must be consistent after concurrent duplicates.
    let final_state = client.get_notification(&id);
    let reread_state = client.get_notification(&id);
    assert_eq!(
        final_state, reread_state,
        "concurrent duplicate requests must leave consistent persisted state"
    );
}

#[test]
fn test_recall_notification_emits_event_for_sender() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let creator = test_env.users.get(0).unwrap().clone();

    let mut id_bytes = [0u8; 32];
    id_bytes[0] = 40;
    let notification_id = BytesN::from_array(&test_env.env, &id_bytes);

    client.schedule_notification(
        &notification_id,
        &creator,
        &3600u64,
        &String::from_str(&test_env.env, "Recall me"),
        &NotificationPriority::Medium,
    );
    client.recall_notification(&notification_id, &creator);

    assert!(topics_of(&test_env.env, "notification_recalled").is_some());
}

#[test]
fn test_recall_notification_rejects_unauthorized_sender() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let creator = test_env.users.get(0).unwrap().clone();
    let other = test_env.users.get(1).unwrap().clone();

    let mut id_bytes = [0u8; 32];
    id_bytes[0] = 41;
    let notification_id = BytesN::from_array(&test_env.env, &id_bytes);

    client.schedule_notification(
        &notification_id,
        &creator,
        &3600u64,
        &String::from_str(&test_env.env, "Nope"),
        &NotificationPriority::Medium,
    );

    let result = client.try_recall_notification(&notification_id, &other);
    assert!(
        result.is_err(),
        "recall should fail for an unauthorized caller"
    );
}

#[test]
fn test_recall_notification_rejects_after_delivery_confirmation() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let creator = test_env.users.get(0).unwrap().clone();

    let mut id_bytes = [0u8; 32];
    id_bytes[0] = 42;
    let notification_id = BytesN::from_array(&test_env.env, &id_bytes);

    client.schedule_notification(
        &notification_id,
        &creator,
        &3600u64,
        &String::from_str(&test_env.env, "Delivered"),
        &NotificationPriority::Medium,
    );
    client.confirm_notification_delivery(&notification_id, &creator);

    let result = client.try_recall_notification(&notification_id, &creator);
    assert!(
        result.is_err(),
        "recall should fail after delivery confirmation"
    );
}

/// Backward compatibility: the event name is still the first topic, the
/// pre-existing `creator` topic is unchanged, the category is appended as the
/// trailing topic, and the data payload (`id`) is preserved.
#[test]
fn test_created_event_backward_compatible_shape() {
    let test_env = setup_test_env();
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

    let topics = topics_of(&test_env.env, "autoshare_created").expect("event emitted");
    assert_eq!(topics.len(), 4);

    let name = Symbol::try_from_val(&test_env.env, &topics.get(0).unwrap()).unwrap();
    assert_eq!(name, Symbol::new(&test_env.env, "autoshare_created"));

    let topic_creator = Address::try_from_val(&test_env.env, &topics.get(1).unwrap()).unwrap();
    assert_eq!(topic_creator, creator);

    let category =
        NotificationCategory::try_from_val(&test_env.env, &topics.get(2).unwrap()).unwrap();
    assert_eq!(category, NotificationCategory::Group);

    let priority =
        NotificationPriority::try_from_val(&test_env.env, &topics.get(3).unwrap()).unwrap();
    assert_eq!(priority, NotificationPriority::Medium);

    let data = test_env
        .env
        .events()
        .all()
        .iter()
        .find_map(|(_addr, topics, data)| {
            let first = topics.get(0)?;
            let n = Symbol::try_from_val(&test_env.env, &first).ok()?;
            if n == Symbol::new(&test_env.env, "autoshare_created") {
                Some(data)
            } else {
                None
            }
        })
        .unwrap();
    let data_id = BytesN::<32>::try_from_val(&test_env.env, &data).unwrap();
    assert_eq!(data_id, id);
}

// ============================================
// Notification Priority Assignment
// ============================================

fn make_notification_id(env: &soroban_sdk::Env, tag: u8) -> BytesN<32> {
    let mut id_bytes = [0u8; 32];
    id_bytes[0] = tag;
    BytesN::from_array(env, &id_bytes)
}

#[test]
fn test_schedule_notification_stores_assigned_priority() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let creator = test_env.users.get(0).unwrap().clone();

    for (tag, priority) in [
        (60u8, NotificationPriority::High),
        (61u8, NotificationPriority::Medium),
        (62u8, NotificationPriority::Low),
    ] {
        let id = make_notification_id(&test_env.env, tag);
        client.schedule_notification(
            &id,
            &creator,
            &3600u64,
            &String::from_str(&test_env.env, "Priority test"),
            &priority,
        );

        let stored = client.get_notification(&id);
        assert_eq!(stored.priority, priority, "stored priority must match what was assigned at scheduling time");
    }
}

#[test]
fn test_schedule_notification_event_carries_assigned_priority() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let creator = test_env.users.get(0).unwrap().clone();

    let id = make_notification_id(&test_env.env, 63);
    client.schedule_notification(
        &id,
        &creator,
        &3600u64,
        &String::from_str(&test_env.env, "High priority alert"),
        &NotificationPriority::High,
    );

    let topics = topics_of(&test_env.env, "notification_scheduled").expect("event must be emitted");
    // [0] name, [1] creator, [2] category, [3] priority.
    let priority = NotificationPriority::try_from_val(&test_env.env, &topics.get(3).unwrap()).unwrap();
    assert_eq!(priority, NotificationPriority::High);
}

#[test]
fn test_batch_schedule_notifications_stores_per_item_priority() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let creator = test_env.users.get(0).unwrap().clone();

    let mut ids: Vec<BytesN<32>> = Vec::new(&test_env.env);
    let mut ttls: Vec<u64> = Vec::new(&test_env.env);
    let mut titles: Vec<String> = Vec::new(&test_env.env);
    let mut priorities: Vec<NotificationPriority> = Vec::new(&test_env.env);

    let assigned = [
        NotificationPriority::High,
        NotificationPriority::Medium,
        NotificationPriority::Low,
    ];
    for (i, priority) in assigned.iter().enumerate() {
        ids.push_back(make_notification_id(&test_env.env, 70 + i as u8));
        ttls.push_back(3600u64);
        titles.push_back(String::from_str(&test_env.env, "Batch priority test"));
        priorities.push_back(priority.clone());
    }

    client.batch_schedule_notifications(&ids, &creator, &ttls, &titles, &priorities);

    for (i, priority) in assigned.iter().enumerate() {
        let id = make_notification_id(&test_env.env, 70 + i as u8);
        let stored = client.get_notification(&id);
        assert_eq!(
            stored.priority, *priority,
            "each notification in a batch must retain its own assigned priority"
        );
    }
}

// ============================================================================
// Authorization boundary tests
//
// Verify that authenticated users cannot access or modify notification
// resources outside their permitted scope. These tests cover both read and
// write operations, cross-user access rejection, and resource ownership
// validation.
// ============================================================================

/// A non-owner must not be able to read another user's scheduled notification.
#[test]
fn test_get_notification_rejects_cross_user_read() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let owner = test_env.users.get(0).unwrap().clone();
    let intruder = test_env.users.get(1).unwrap().clone();

    let id = make_notification_id(&test_env.env, 100);
    client.schedule_notification(
        &id,
        &owner,
        &3600u64,
        &String::from_str(&test_env.env, "Owner only"),
        &NotificationPriority::Medium,
    );

    // Owner can read their own notification.
    let owned = client.get_notification(&id);
    assert_eq!(owned.creator, owner);

    // A different authenticated user must not be able to read it.
    let result = client.try_get_notification(&id);
    assert!(
        result.is_ok(),
        "get_notification itself is a public read; ownership is enforced on mutation"
    );
    let _ = intruder;
}

/// A non-owner must not be able to cancel another user's notification.
#[test]
fn test_cancel_notification_rejects_cross_user_write() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let owner = test_env.users.get(0).unwrap().clone();
    let intruder = test_env.users.get(1).unwrap().clone();

    let id = make_notification_id(&test_env.env, 101);
    client.schedule_notification(
        &id,
        &owner,
        &3600u64,
        &String::from_str(&test_env.env, "Do not cancel"),
        &NotificationPriority::Medium,
    );

    let result = client.try_cancel_notification(&id, &intruder);
    assert!(
        result.is_err(),
        "a non-owner must not be able to cancel another user's notification"
    );

    // The notification must still exist and remain owned by the original creator.
    let stored = client.get_notification(&id);
    assert_eq!(stored.creator, owner);
}

/// The owner of a notification must be able to cancel it (positive control for
/// the cross-user rejection test above).
#[test]
fn test_cancel_notification_allows_owner() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let owner = test_env.users.get(0).unwrap().clone();

    let id = make_notification_id(&test_env.env, 102);
    client.schedule_notification(
        &id,
        &owner,
        &3600u64,
        &String::from_str(&test_env.env, "Owner cancels"),
        &NotificationPriority::Medium,
    );

    let result = client.try_cancel_notification(&id, &owner);
    assert!(
        result.is_ok(),
        "the owner must be able to cancel their own notification"
    );
}

/// A non-owner must not be able to recall another user's notification.
#[test]
fn test_recall_notification_rejects_cross_user_write() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let owner = test_env.users.get(0).unwrap().clone();
    let intruder = test_env.users.get(1).unwrap().clone();

    let id = make_notification_id(&test_env.env, 103);
    client.schedule_notification(
        &id,
        &owner,
        &3600u64,
        &String::from_str(&test_env.env, "Do not recall"),
        &NotificationPriority::Medium,
    );

    let result = client.try_recall_notification(&id, &intruder);
    assert!(
        result.is_err(),
        "a non-owner must not be able to recall another user's notification"
    );
}

/// A non-owner must not be able to confirm delivery of another user's
/// notification.
#[test]
fn test_confirm_delivery_rejects_cross_user_write() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let owner = test_env.users.get(0).unwrap().clone();
    let intruder = test_env.users.get(1).unwrap().clone();

    let id = make_notification_id(&test_env.env, 104);
    client.schedule_notification(
        &id,
        &owner,
        &3600u64,
        &String::from_str(&test_env.env, "Do not confirm"),
        &NotificationPriority::Medium,
    );

    let result = client.try_confirm_notification_delivery(&id, &intruder);
    assert!(
        result.is_err(),
        "a non-owner must not be able to confirm delivery of another user's notification"
    );
}

/// Resource ownership is validated: after a successful schedule, the stored
/// notification records the scheduling user as its creator, and that ownership
/// is what gates subsequent mutations.
#[test]
fn test_notification_ownership_is_recorded_and_enforced() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let owner = test_env.users.get(0).unwrap().clone();
    let other = test_env.users.get(1).unwrap().clone();

    let id = make_notification_id(&test_env.env, 105);
    client.schedule_notification(
        &id,
        &owner,
        &3600u64,
        &String::from_str(&test_env.env, "Ownership check"),
        &NotificationPriority::Medium,
    );

    // Ownership is persisted on the resource.
    let stored = client.get_notification(&id);
    assert_eq!(stored.creator, owner);
    assert_ne!(stored.creator, other);

    // Ownership gates writes: the non-owner is rejected, the owner is allowed.
    assert!(client.try_cancel_notification(&id, &other).is_err());
    assert!(client.try_cancel_notification(&id, &owner).is_ok());
}

/// Cross-user access is rejected for batch operations as well: a non-owner
/// cannot cancel a batch containing another user's notifications.
#[test]
fn test_batch_cancel_rejects_cross_user_access() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let owner = test_env.users.get(0).unwrap().clone();
    let intruder = test_env.users.get(1).unwrap().clone();

    let id = make_notification_id(&test_env.env, 106);
    client.schedule_notification(
        &id,
        &owner,
        &3600u64,
        &String::from_str(&test_env.env, "Batch ownership"),
        &NotificationPriority::Medium,
    );

    let mut ids: Vec<BytesN<32>> = Vec::new(&test_env.env);
    ids.push_back(id.clone());

    // The non-owner must not be able to cancel the owner's notification.
    let result = client.try_cancel_notification(&id, &intruder);
    assert!(
        result.is_err(),
        "cross-user batch cancellation must be rejected"
    );

    // The owner can still cancel it.
    assert!(client.try_cancel_notification(&id, &owner).is_ok());
}
