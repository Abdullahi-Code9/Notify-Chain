//! Input-size bound enforcement tests (Task 1).
//!
//! Every entry point that accepts a variable-length input validates that input
//! against a named constant in [`crate::base::constants`] **at the very top of
//! the function** — before any storage write, TTL management, or event
//! emission.
//!
//! These tests verify:
//! - Boundary inputs (exactly at the limit) succeed.
//! - Oversized inputs fail *before* any state mutation, with a contract error.
//!   Entry points whose ABI returns `Result` (e.g. `create`, `update_members`)
//!   are asserted against the *exact* error variant; entry points that unwrap
//!   internally (e.g. `schedule_notification`) are asserted with `is_err()`,
//!   matching the existing test conventions in this crate.
//! - The limit is applied consistently across entry points.

extern crate std;

use crate::base::errors::Error;
use crate::base::events::NotificationPriority;
use crate::base::types::GroupMember;
use crate::test_utils::{create_test_group, mint_tokens, setup_test_env};
use crate::AutoShareContractClient;
use soroban_sdk::testutils::Address as _;
use soroban_sdk::{Address, BytesN, Env, Map, String, Vec};

// ── helpers ─────────────────────────────────────────────────────────────────

fn make_id(env: &Env, tag: u8) -> BytesN<32> {
    let mut bytes = [0u8; 32];
    bytes[0] = tag;
    BytesN::from_array(env, &bytes)
}

fn make_members(env: &Env, count: u32) -> Vec<GroupMember> {
    let mut members = Vec::new(env);
    if count == 0 {
        return members;
    }
    // Evenly distribute 100% across `count` members.
    let base = 100 / count;
    let mut assigned: u32 = 0;
    let mut i = 0u32;
    while i < count {
        let percentage = if i == count - 1 {
            100 - assigned
        } else {
            base
        };
        assigned += percentage;
        members.push_back(GroupMember {
            address: Address::generate(env),
            percentage,
        });
        i += 1;
    }
    members
}

// ============================================================================
// create() — group name bound
// ============================================================================

#[test]
fn test_create_name_at_bound_succeeds() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let creator = test_env.users.get(0).unwrap().clone();
    let token = test_env.mock_tokens.get(0).unwrap().clone();
    mint_tokens(&test_env.env, &token, &creator, 10_000_000);

    let id = make_id(&test_env.env, 1);
    client.create(
        &id,
        &String::from_str(&test_env.env, &"a".repeat(100)),
        &creator,
        &1u32,
        &token,
    );
    assert_eq!(client.get(&id).creator, creator);
}

#[test]
fn test_create_name_over_bound_returns_name_too_long() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let creator = test_env.users.get(0).unwrap().clone();
    let token = test_env.mock_tokens.get(0).unwrap().clone();
    mint_tokens(&test_env.env, &token, &creator, 10_000_000);

    let id = make_id(&test_env.env, 2);
    let result = client.try_create(
        &id,
        &String::from_str(&test_env.env, &"a".repeat(101)),
        &creator,
        &1u32,
        &token,
    );
    assert_eq!(result, Err(Ok(Error::NameTooLong)));
}

// ============================================================================
// schedule_notification() — title (topic) bound
// ============================================================================

#[test]
fn test_schedule_title_at_bound_succeeds() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let creator = test_env.users.get(0).unwrap().clone();

    let id = make_id(&test_env.env, 10);
    client.schedule_notification(
        &id,
        &creator,
        &3_600u64,
        &String::from_str(&test_env.env, &"t".repeat(256)),
        &NotificationPriority::Medium,
    );
    assert_eq!(client.get_notification(&id).creator, creator);
}

#[test]
fn test_schedule_title_over_bound_fails() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let creator = test_env.users.get(0).unwrap().clone();

    let id = make_id(&test_env.env, 11);
    let result = client.try_schedule_notification(
        &id,
        &creator,
        &3_600u64,
        &String::from_str(&test_env.env, &"t".repeat(257)),
        &NotificationPriority::Medium,
    );
    assert!(
        result.is_err(),
        "a title over MAX_TOPIC_LEN must be rejected before any write"
    );
}

// ============================================================================
// batch_schedule_notifications() — batch size + per-title bounds
// ============================================================================

fn batch_args(
    env: &Env,
    count: u32,
    title_len: usize,
) -> (
    Vec<BytesN<32>>,
    Vec<u64>,
    Vec<String>,
    Vec<NotificationPriority>,
) {
    let mut ids = Vec::new(env);
    let mut ttls = Vec::new(env);
    let mut titles = Vec::new(env);
    let mut priorities = Vec::new(env);
    let title = String::from_str(env, &"n".repeat(title_len));
    let mut i = 0u32;
    while i < count {
        ids.push_back(make_id(env, (i + 1) as u8));
        ttls.push_back(3_600u64);
        titles.push_back(title.clone());
        priorities.push_back(NotificationPriority::Medium);
        i += 1;
    }
    (ids, ttls, titles, priorities)
}

#[test]
fn test_batch_at_max_size_succeeds() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let creator = test_env.users.get(0).unwrap().clone();

    let (ids, ttls, titles, priorities) = batch_args(&test_env.env, 50, 16);
    client.batch_schedule_notifications(&ids, &creator, &ttls, &titles, &priorities);
    assert_eq!(client.get_notification(&make_id(&test_env.env, 1)).creator, creator);
}

#[test]
fn test_batch_over_max_size_fails() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let creator = test_env.users.get(0).unwrap().clone();

    let (ids, ttls, titles, priorities) = batch_args(&test_env.env, 51, 16);
    let result = client.try_batch_schedule_notifications(&ids, &creator, &ttls, &titles, &priorities);
    assert!(
        result.is_err(),
        "a batch larger than MAX_BATCH_SIZE must be rejected"
    );
}

#[test]
fn test_batch_rejects_oversized_title() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let creator = test_env.users.get(0).unwrap().clone();

    let (ids, ttls, titles, priorities) = batch_args(&test_env.env, 1, 257);
    let result = client.try_batch_schedule_notifications(&ids, &creator, &ttls, &titles, &priorities);
    assert!(
        result.is_err(),
        "a batch entry whose title exceeds MAX_TOPIC_LEN must be rejected"
    );
}

// ============================================================================
// register_template() — name + content bounds
// ============================================================================

#[test]
fn test_template_name_and_content_bounds() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let owner = test_env.users.get(0).unwrap().clone();

    // Name at bound (100) + content at bound (4096) — accepted.
    client.register_template(
        &make_id(&test_env.env, 20),
        &owner,
        &String::from_str(&test_env.env, &"n".repeat(100)),
        &String::from_str(&test_env.env, &"c".repeat(4096)),
    );

    // Name over bound → rejected.
    let name_result = client.try_register_template(
        &make_id(&test_env.env, 21),
        &owner,
        &String::from_str(&test_env.env, &"n".repeat(101)),
        &String::from_str(&test_env.env, "ok"),
    );
    assert!(name_result.is_err(), "template name over bound must fail");

    // Content over bound → rejected.
    let content_result = client.try_register_template(
        &make_id(&test_env.env, 22),
        &owner,
        &String::from_str(&test_env.env, "ok"),
        &String::from_str(&test_env.env, &"c".repeat(4097)),
    );
    assert!(
        content_result.is_err(),
        "template content over MAX_EVENT_PAYLOAD_LEN must fail"
    );
}

// ============================================================================
// create_channel() — channel name bound
// ============================================================================

#[test]
fn test_channel_name_bounds() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let creator = test_env.users.get(0).unwrap().clone();

    client.create_channel(
        &make_id(&test_env.env, 30),
        &String::from_str(&test_env.env, &"c".repeat(100)),
        &creator,
    );

    let result = client.try_create_channel(
        &make_id(&test_env.env, 31),
        &String::from_str(&test_env.env, &"c".repeat(101)),
        &creator,
    );
    assert!(result.is_err(), "channel name over bound must fail");
}

// ============================================================================
// update_members() — member-count bound
// ============================================================================

#[test]
fn test_update_members_count_bounds() {
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

    // Exactly 50 members — accepted.
    client.update_members(&id, &creator, &make_members(&test_env.env, 50));

    // 51 members → TooManyMembers.
    let over = client.try_update_members(&id, &creator, &make_members(&test_env.env, 51));
    assert_eq!(over, Err(Ok(Error::TooManyMembers)));

    // Empty list → EmptyMembers.
    let empty = client.try_update_members(&id, &creator, &Vec::new(&test_env.env));
    assert_eq!(empty, Err(Ok(Error::EmptyMembers)));
}

// ============================================================================
// update_channel_metadata() — description + custom field bounds
// ============================================================================

#[test]
fn test_update_channel_metadata_description_bound() {
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

    // 256-byte description — accepted.
    client.update_channel_metadata(
        &id,
        &creator,
        &String::from_str(&test_env.env, &"d".repeat(256)),
        &Map::new(&test_env.env),
    );

    // 257-byte description → rejected.
    let result = client.try_update_channel_metadata(
        &id,
        &creator,
        &String::from_str(&test_env.env, &"d".repeat(257)),
        &Map::new(&test_env.env),
    );
    assert!(
        result.is_err(),
        "description over MAX_CHANNEL_DESCRIPTION_LEN must fail"
    );
}

#[test]
fn test_update_channel_metadata_field_count_bound() {
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

    // 21 custom fields → InputTooLarge.
    let mut fields = Map::new(&test_env.env);
    let mut i = 0u32;
    while i < 21 {
        let key = String::from_str(&test_env.env, &std::format!("k{i}"));
        fields.set(key, String::from_str(&test_env.env, "v"));
        i += 1;
    }

    let result = client.try_update_channel_metadata(
        &id,
        &creator,
        &String::from_str(&test_env.env, "ok"),
        &fields,
    );
    assert!(
        result.is_err(),
        "more than MAX_CHANNEL_CUSTOM_FIELDS must fail"
    );
}
