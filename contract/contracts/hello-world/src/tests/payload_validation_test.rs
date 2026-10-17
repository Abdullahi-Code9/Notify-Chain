//! Tests for payload validation logic (AGENTS.md — payload validation / event
//! type filtering).
//!
//! Acceptance criteria verified here:
//! - Invalid payloads are rejected with appropriate errors.
//! - Edge cases (boundary values, empty inputs, overflow) are covered.
//! - Event category/priority metadata is present on every emitted event so
//!   off-chain consumers can identify notification types directly.

use crate::base::events::{NotificationCategory, NotificationPriority};
use crate::test_utils::{create_test_group, setup_test_env};
use crate::AutoShareContractClient;

use soroban_sdk::testutils::{Address as _, Events};
use soroban_sdk::{Address, BytesN, Env, String, Symbol, TryFromVal, Vec};

// ── helpers ─────────────────────────────────────────────────────────────────

fn make_title(env: &Env) -> String {
    String::from_str(env, "Test Notification")
}

fn make_id(env: &Env, tag: u8) -> BytesN<32> {
    let mut bytes = [0u8; 32];
    bytes[0] = tag;
    BytesN::from_array(env, &bytes)
}

/// Returns the topic list of the most recently emitted event whose first topic
/// matches `event_name`.
fn topics_of(env: &Env, event_name: &str) -> Option<Vec<soroban_sdk::Val>> {
    use soroban_sdk::Val;
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

fn category_of(env: &Env, event_name: &str) -> Option<NotificationCategory> {
    let topics = topics_of(env, event_name)?;
    let n = topics.len();
    if n < 2 {
        return None;
    }
    NotificationCategory::try_from_val(env, &topics.get(n - 2)?).ok()
}

fn priority_of(env: &Env, event_name: &str) -> Option<NotificationPriority> {
    let topics = topics_of(env, event_name)?;
    let last = topics.last()?;
    NotificationPriority::try_from_val(env, &last).ok()
}

// ============================================================================
// Invalid payload rejection — group creation
// ============================================================================

#[test]
fn test_create_rejects_zero_usage_count() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let creator = test_env.users.get(0).unwrap().clone();
    let token = test_env.mock_tokens.get(0).unwrap().clone();
    let id = make_id(&test_env.env, 1);

    crate::test_utils::mint_tokens(&test_env.env, &token, &creator, 1_000_000);
    let result = client.try_create(
        &id,
        &String::from_str(&test_env.env, "Test"),
        &creator,
        &0u32,
        &token,
    );
    assert!(result.is_err(), "zero usage count must be rejected");
}

#[test]
fn test_create_rejects_name_over_max_length() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let creator = test_env.users.get(0).unwrap().clone();
    let token = test_env.mock_tokens.get(0).unwrap().clone();

    crate::test_utils::mint_tokens(&test_env.env, &token, &creator, 1_000_000);

    // Exactly MAX_NAME_LENGTH (100) — must succeed.
    let ok_id = make_id(&test_env.env, 2);
    let ok_name = String::from_str(&test_env.env, &"X".repeat(100));
    client.create(&ok_id, &ok_name, &creator, &1u32, &token);

    // 101 chars — must fail.
    let long_id = make_id(&test_env.env, 3);
    let long_name = String::from_str(&test_env.env, &"X".repeat(101));
    let result = client.try_create(&long_id, &long_name, &creator, &1u32, &token);
    assert!(result.is_err(), "name > 100 chars must be rejected");
}

#[test]
fn test_create_rejects_unsupported_token() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let creator = test_env.users.get(0).unwrap().clone();
    let id = make_id(&test_env.env, 4);

    let bad_token = crate::test_utils::deploy_mock_token(
        &test_env.env,
        &String::from_str(&test_env.env, "Bad"),
        &String::from_str(&test_env.env, "BAD"),
    );
    crate::test_utils::mint_tokens(&test_env.env, &bad_token, &creator, 1_000_000);

    let result = client.try_create(
        &id,
        &String::from_str(&test_env.env, "T"),
        &creator,
        &1u32,
        &bad_token,
    );
    assert!(result.is_err(), "unsupported token must be rejected");
}

#[test]
fn test_create_rejects_duplicate_id() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let creator = test_env.users.get(0).unwrap().clone();
    let token = test_env.mock_tokens.get(0).unwrap().clone();

    // Create the group once — succeeds.
    create_test_group(
        &test_env.env,
        &test_env.autoshare_contract,
        &creator,
        &Vec::new(&test_env.env),
        1,
        &token,
    );

    // A second create with the same id bytes must fail.
    crate::test_utils::mint_tokens(&test_env.env, &token, &creator, 1_000_000);
    let mut dup_id_bytes = [0u8; 32];
    dup_id_bytes[0..4].copy_from_slice(&1u32.to_be_bytes());
    let dup_id = BytesN::from_array(&test_env.env, &dup_id_bytes);

    let result = client.try_create(
        &dup_id,
        &String::from_str(&test_env.env, "Dup"),
        &creator,
        &1u32,
        &token,
    );
    assert!(result.is_err(), "duplicate id must be rejected");
}

// ============================================================================
// Invalid payload rejection — notification scheduling
// ============================================================================

#[test]
fn test_schedule_rejects_zero_ttl() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let creator = test_env.users.get(0).unwrap().clone();
    let id = make_id(&test_env.env, 10);

    let result = client.try_schedule_notification(&id, &creator, &0u64, &make_title(&test_env.env), &NotificationPriority::Medium);
    assert!(result.is_err(), "zero TTL must be rejected");
}

#[test]
fn test_schedule_rejects_duplicate_id() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let creator = test_env.users.get(0).unwrap().clone();
    let id = make_id(&test_env.env, 11);

    client.schedule_notification(&id, &creator, &3_600u64, &make_title(&test_env.env), &NotificationPriority::Medium);
    let result =
        client.try_schedule_notification(&id, &creator, &3_600u64, &make_title(&test_env.env), &NotificationPriority::Medium);
    assert!(
        result.is_err(),
        "duplicate notification id must be rejected"
    );
}

#[test]
fn test_schedule_rejects_overflow_ttl() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let creator = test_env.users.get(0).unwrap().clone();
    let id = make_id(&test_env.env, 12);

    // Set a non-zero timestamp so u64::MAX + timestamp overflows.
    use soroban_sdk::testutils::Ledger;
    test_env.env.ledger().set_timestamp(1_000);

    let result =
        client.try_schedule_notification(&id, &creator, &u64::MAX, &make_title(&test_env.env), &NotificationPriority::Medium);
    assert!(result.is_err(), "overflow TTL must be rejected");
}

// ============================================================================
// Invalid payload rejection — member management
// ============================================================================

#[test]
fn test_update_members_rejects_empty_list() {
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

    let result = client.try_update_members(&id, &creator, &Vec::new(&test_env.env));
    assert!(result.is_err(), "empty member list must be rejected");
}

#[test]
fn test_update_members_rejects_percentages_not_summing_to_100() {
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

    let mut bad_members: Vec<crate::base::types::GroupMember> = Vec::new(&test_env.env);
    bad_members.push_back(crate::base::types::GroupMember {
        address: Address::generate(&test_env.env),
        percentage: 60,
    });
    // Sum = 60, not 100.
    let result = client.try_update_members(&id, &creator, &bad_members);
    assert!(
        result.is_err(),
        "member percentages not summing to 100 must be rejected"
    );
}

#[test]
fn test_update_members_rejects_duplicate_addresses() {
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

    let dup = Address::generate(&test_env.env);
    let mut bad_members: Vec<crate::base::types::GroupMember> = Vec::new(&test_env.env);
    bad_members.push_back(crate::base::types::GroupMember {
        address: dup.clone(),
        percentage: 50,
    });
    bad_members.push_back(crate::base::types::GroupMember {
        address: dup.clone(),
        percentage: 50,
    });

    let result = client.try_update_members(&id, &creator, &bad_members);
    assert!(
        result.is_err(),
        "duplicate member addresses must be rejected"
    );
}

#[test]
fn test_update_members_rejects_over_max_members() {
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

    let mut members: Vec<crate::base::types::GroupMember> = Vec::new(&test_env.env);
    for _ in 0..51u32 {
        members.push_back(crate::base::types::GroupMember {
            address: Address::generate(&test_env.env),
            percentage: 1,
        });
    }
    let result = client.try_update_members(&id, &creator, &members);
    assert!(result.is_err(), "51 members must be rejected (max is 50)");
}

// ============================================================================
// Edge cases — boundary values
// ============================================================================

#[test]
fn test_usage_fee_boundary_one_is_valid() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);

    // Fee of 1 is the minimum valid value.
    client.set_usage_fee(&1u32, &test_env.admin);
    assert_eq!(client.get_usage_fee(), 1u32);
}

#[test]
fn test_usage_fee_zero_is_rejected() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);

    let result = client.try_set_usage_fee(&0u32, &test_env.admin);
    assert!(result.is_err(), "usage fee of 0 must be rejected");
}

#[test]
fn test_single_member_at_100_percent_is_valid() {
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

    let mut members: Vec<crate::base::types::GroupMember> = Vec::new(&test_env.env);
    members.push_back(crate::base::types::GroupMember {
        address: Address::generate(&test_env.env),
        percentage: 100,
    });
    // Must not panic.
    client.update_members(&id, &creator, &members);
}

#[test]
fn test_ttl_of_one_second_is_valid() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let creator = test_env.users.get(0).unwrap().clone();
    let id = make_id(&test_env.env, 20);

    // TTL = 1 second is the minimum valid value.
    client.schedule_notification(&id, &creator, &1u64, &make_title(&test_env.env), &NotificationPriority::Medium);
    let stored = client.get_notification(&id);
    assert_eq!(stored.expires_at, stored.created_at + 1);
}

// ============================================================================
// Event metadata — every event carries category and priority
// ============================================================================

#[test]
fn test_every_event_carries_category_and_priority() {
    // Verify that each event type carries category and priority topics.
    // We check each event immediately after the action that produces it,
    // so we never miss an event due to env accumulation ordering.

    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let creator = test_env.users.get(0).unwrap().clone();
    let token = test_env.mock_tokens.get(0).unwrap().clone();

    // --- autoshare_created ---
    create_test_group(
        &test_env.env,
        &test_env.autoshare_contract,
        &creator,
        &Vec::new(&test_env.env),
        1,
        &token,
    );
    assert!(
        category_of(&test_env.env, "autoshare_created").is_some(),
        "autoshare_created must carry a NotificationCategory topic"
    );
    assert!(
        priority_of(&test_env.env, "autoshare_created").is_some(),
        "autoshare_created must carry a NotificationPriority topic"
    );

    // --- notification_scheduled ---
    let id = make_id(&test_env.env, 30);
    client.schedule_notification(&id, &creator, &3_600u64, &make_title(&test_env.env), &NotificationPriority::Medium);
    assert!(
        category_of(&test_env.env, "notification_scheduled").is_some(),
        "notification_scheduled must carry a NotificationCategory topic"
    );
    assert!(
        priority_of(&test_env.env, "notification_scheduled").is_some(),
        "notification_scheduled must carry a NotificationPriority topic"
    );

    // --- scheduled_notification_cancelled ---
    client.cancel_notification(&id, &creator);
    assert!(
        category_of(&test_env.env, "scheduled_notification_cancelled").is_some(),
        "scheduled_notification_cancelled must carry a NotificationCategory topic"
    );
    assert!(
        priority_of(&test_env.env, "scheduled_notification_cancelled").is_some(),
        "scheduled_notification_cancelled must carry a NotificationPriority topic"
    );

    // --- contract_paused ---
    client.pause(&test_env.admin);
    assert!(
        category_of(&test_env.env, "contract_paused").is_some(),
        "contract_paused must carry a NotificationCategory topic"
    );
    assert!(
        priority_of(&test_env.env, "contract_paused").is_some(),
        "contract_paused must carry a NotificationPriority topic"
    );

    // --- contract_unpaused ---
    client.unpause(&test_env.admin);
    assert!(
        category_of(&test_env.env, "contract_unpaused").is_some(),
        "contract_unpaused must carry a NotificationCategory topic"
    );
    assert!(
        priority_of(&test_env.env, "contract_unpaused").is_some(),
        "contract_unpaused must carry a NotificationPriority topic"
    );
}

#[test]
fn test_group_events_have_group_category() {
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

    assert_eq!(
        category_of(&test_env.env, "autoshare_created"),
        Some(NotificationCategory::Group)
    );

    client.deactivate_group(&id, &creator);
    assert_eq!(
        category_of(&test_env.env, "group_deactivated"),
        Some(NotificationCategory::Group)
    );

    client.activate_group(&id, &creator);
    assert_eq!(
        category_of(&test_env.env, "group_activated"),
        Some(NotificationCategory::Group)
    );
}

#[test]
fn test_admin_events_have_admin_category() {
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

    client.unpause(&test_env.admin);
    assert_eq!(
        category_of(&test_env.env, "contract_unpaused"),
        Some(NotificationCategory::Admin)
    );
}

#[test]
fn test_notification_events_have_notification_category() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let creator = test_env.users.get(0).unwrap().clone();

    let id = make_id(&test_env.env, 40);
    client.schedule_notification(&id, &creator, &3_600u64, &make_title(&test_env.env), &NotificationPriority::Medium);

    assert_eq!(
        category_of(&test_env.env, "notification_scheduled"),
        Some(NotificationCategory::Notification)
    );

    client.cancel_notification(&id, &creator);
    assert_eq!(
        category_of(&test_env.env, "scheduled_notification_cancelled"),
        Some(NotificationCategory::Notification)
    );
}

#[test]
fn test_financial_events_have_financial_category() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let creator = test_env.users.get(0).unwrap().clone();
    let token = test_env.mock_tokens.get(0).unwrap().clone();

    // Fund the contract by creating a group.
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

#[test]
fn test_admin_transfer_has_critical_priority() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let new_admin = Address::generate(&test_env.env);

    client.transfer_admin(&test_env.admin, &new_admin);

    assert_eq!(
        priority_of(&test_env.env, "admin_transferred"),
        Some(NotificationPriority::Critical)
    );
}

// ============================================================================
// Consumers can filter events by notification type
// ============================================================================

#[test]
fn test_consumer_can_filter_by_category() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let creator = test_env.users.get(0).unwrap().clone();
    let token = test_env.mock_tokens.get(0).unwrap().clone();

    // Helper: get the category of the most recently emitted event (any event).
    let latest_category = |env: &Env| -> Option<NotificationCategory> {
        use soroban_sdk::Val;
        let (_addr, topics, _data) = env.events().all().last()?;
        let n = topics.len();
        if n < 2 {
            return None;
        }
        NotificationCategory::try_from_val(env, &topics.get(n - 2)?).ok()
    };

    let mut group_events = 0u32;
    let mut admin_events = 0u32;
    let mut notification_events = 0u32;
    let mut financial_events = 0u32;

    let mut tally = |env: &Env| match latest_category(env) {
        Some(NotificationCategory::Group) => group_events += 1,
        Some(NotificationCategory::Admin) => admin_events += 1,
        Some(NotificationCategory::Notification) => notification_events += 1,
        Some(NotificationCategory::Financial) => financial_events += 1,
        Some(NotificationCategory::System) => {}
        None => {}
    };

    // Group event.
    create_test_group(
        &test_env.env,
        &test_env.autoshare_contract,
        &creator,
        &Vec::new(&test_env.env),
        1,
        &token,
    );
    tally(&test_env.env);

    // Admin events.
    client.pause(&test_env.admin);
    tally(&test_env.env);
    client.unpause(&test_env.admin);
    tally(&test_env.env);

    // Notification events (schedule emits audit_record_appended + notification_scheduled).
    let id = make_id(&test_env.env, 50);
    client.schedule_notification(&id, &creator, &3_600u64, &make_title(&test_env.env), &NotificationPriority::Medium);
    tally(&test_env.env); // last event emitted = notification_scheduled (Notification)

    // Financial event.
    let recipient = Address::generate(&test_env.env);
    client.withdraw(&test_env.admin, &token, &1i128, &recipient);
    tally(&test_env.env);

    assert_eq!(group_events, 1, "one Group event expected");
    assert_eq!(
        admin_events, 2,
        "two Admin events expected (pause + unpause)"
    );
    assert!(notification_events >= 1, "at least one Notification event");
    assert_eq!(financial_events, 1, "one Financial event expected");
}
