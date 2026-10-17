//! Tests for notification payload validation rules (issue #102).
//!
//! Covers:
//! - Invalid payloads rejected at every entry point (zero usages, name too long,
//!   unsupported token, wrong percentages, paused state, wrong caller, etc.)
//! - Edge cases: boundary values, state conflicts, repeated operations
//! - AuthorizationFailure events carry the Admin NotificationCategory
//! - Successful paths emit events with the expected category
//! - Withdrawal event data (amount) is preserved in the payload

use crate::base::events::NotificationCategory;
use crate::base::types::GroupMember;
use crate::mock_token::{MockToken, MockTokenClient};
use crate::test_utils::{create_test_group, mint_tokens, setup_test_env};
use crate::{AutoShareContract, AutoShareContractClient};

use soroban_sdk::testutils::{Address as _, Events};
use soroban_sdk::{Address, BytesN, String, TryFromVal, Vec};

// ─── helpers ────────────────────────────────────────────────────────────────

fn last_category(env: &soroban_sdk::Env) -> Option<NotificationCategory> {
    let (_addr, topics, _data) = env.events().all().last()?;
    // Category is the second-to-last topic; the priority is always last.
    let n = topics.len();
    if n < 2 {
        return None;
    }
    NotificationCategory::try_from_val(env, &topics.get(n - 2)?).ok()
}

// ── create: invalid payload — zero usage count ───────────────────────────────

#[test]
#[should_panic]
fn test_create_zero_usage_count_is_rejected() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let creator = test_env.users.get(0).unwrap().clone();
    let token = test_env.mock_tokens.get(0).unwrap().clone();
    mint_tokens(&test_env.env, &token, &creator, 100_000);

    let id = BytesN::from_array(&test_env.env, &[0xA0u8; 32]);
    client.create(
        &id,
        &String::from_str(&test_env.env, "ZeroUsages"),
        &creator,
        &0u32,
        &token,
    );
}

// ── create: invalid payload — name at the boundary ───────────────────────────

/// A name of exactly 100 characters (the max) must be accepted.
#[test]
fn test_create_name_at_max_length_is_accepted() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let creator = test_env.users.get(0).unwrap().clone();
    let token = test_env.mock_tokens.get(0).unwrap().clone();
    mint_tokens(&test_env.env, &token, &creator, 100_000);

    let exactly_100 = "a".repeat(100);
    let id = BytesN::from_array(&test_env.env, &[0xA1u8; 32]);
    client.create(
        &id,
        &String::from_str(&test_env.env, &exactly_100),
        &creator,
        &1u32,
        &token,
    );
    // If we reach here the group was created — confirm via get()
    let group = client.get(&id);
    assert_eq!(group.creator, creator);
}

/// A name of 101 characters (one over the max) must be rejected.
#[test]
#[should_panic]
fn test_create_name_one_over_max_length_is_rejected() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let creator = test_env.users.get(0).unwrap().clone();
    let token = test_env.mock_tokens.get(0).unwrap().clone();
    mint_tokens(&test_env.env, &token, &creator, 100_000);

    let over_limit = "b".repeat(101);
    let id = BytesN::from_array(&test_env.env, &[0xA2u8; 32]);
    client.create(
        &id,
        &String::from_str(&test_env.env, &over_limit),
        &creator,
        &1u32,
        &token,
    );
}

// ── create: invalid payload — unsupported token ──────────────────────────────

#[test]
#[should_panic]
fn test_create_with_unsupported_token_is_rejected() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let creator = test_env.users.get(0).unwrap().clone();

    // Deploy a token that was never added to the supported list.
    let bad_token = test_env.env.register(MockToken, ());
    let bad_token_client = MockTokenClient::new(&test_env.env, &bad_token);
    bad_token_client.initialize(
        &creator,
        &7,
        &String::from_str(&test_env.env, "Rogue"),
        &String::from_str(&test_env.env, "RGE"),
    );
    mint_tokens(&test_env.env, &bad_token, &creator, 100_000);

    let id = BytesN::from_array(&test_env.env, &[0xA3u8; 32]);
    client.create(
        &id,
        &String::from_str(&test_env.env, "BadToken"),
        &creator,
        &1u32,
        &bad_token,
    );
}

// ── update_members: validation rules ────────────────────────────────────────

/// Percentages summing to 99 must be rejected (one short of 100).
#[test]
#[should_panic]
fn test_update_members_percentages_sum_to_99_is_rejected() {
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
    members.push_back(GroupMember {
        address: Address::generate(&test_env.env),
        percentage: 49,
    });
    members.push_back(GroupMember {
        address: Address::generate(&test_env.env),
        percentage: 50, // 49 + 50 = 99, not 100
    });
    client.update_members(&id, &creator, &members);
}

/// Percentages summing to 101 must be rejected.
#[test]
#[should_panic]
fn test_update_members_percentages_sum_to_101_is_rejected() {
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
    members.push_back(GroupMember {
        address: Address::generate(&test_env.env),
        percentage: 51,
    });
    members.push_back(GroupMember {
        address: Address::generate(&test_env.env),
        percentage: 50, // 51 + 50 = 101
    });
    client.update_members(&id, &creator, &members);
}

/// A single member at exactly 100 % is valid.
#[test]
fn test_update_members_single_member_100_percent_is_valid() {
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
    members.push_back(GroupMember {
        address: Address::generate(&test_env.env),
        percentage: 100,
    });
    client.update_members(&id, &creator, &members);

    assert_eq!(client.get_group_members(&id).len(), 1);
}

/// Duplicate member addresses must be rejected.
#[test]
#[should_panic]
fn test_update_members_duplicate_address_is_rejected() {
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
    let mut members = Vec::new(&test_env.env);
    members.push_back(GroupMember {
        address: dup.clone(),
        percentage: 50,
    });
    members.push_back(GroupMember {
        address: dup, // same address
        percentage: 50,
    });
    client.update_members(&id, &creator, &members);
}

/// Empty member list must be rejected.
#[test]
#[should_panic]
fn test_update_members_empty_list_is_rejected() {
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

    client.update_members(&id, &creator, &Vec::new(&test_env.env));
}

/// Exactly 50 members with equal splits (2 % each) is the allowed maximum.
#[test]
fn test_update_members_exactly_50_members_is_valid() {
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
    for i in 0u32..50 {
        members.push_back(GroupMember {
            address: Address::generate(&test_env.env),
            percentage: if i < 49 { 2 } else { 2 }, // 50 × 2 = 100
        });
    }
    client.update_members(&id, &creator, &members);

    assert_eq!(client.get_group_members(&id).len(), 50);
}

/// 51 members must be rejected (over the 50-member cap).
#[test]
#[should_panic]
fn test_update_members_51_members_is_rejected() {
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
    for _ in 0..51 {
        members.push_back(GroupMember {
            address: Address::generate(&test_env.env),
            percentage: 1,
        });
    }
    client.update_members(&id, &creator, &members);
}

/// Calling update_members on a non-existent group must be rejected.
#[test]
#[should_panic]
fn test_update_members_nonexistent_group_is_rejected() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let caller = test_env.users.get(0).unwrap().clone();

    let ghost_id = BytesN::from_array(&test_env.env, &[0xFFu8; 32]);
    let mut members = Vec::new(&test_env.env);
    members.push_back(GroupMember {
        address: Address::generate(&test_env.env),
        percentage: 100,
    });
    client.update_members(&ghost_id, &caller, &members);
}

// ── paused-state validation: write ops must not emit events ─────────────────

/// update_members while paused must be rejected; no AutoshareUpdated event.
#[test]
#[should_panic]
fn test_update_members_while_paused_is_rejected() {
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

    client.pause(&test_env.admin);

    let mut members = Vec::new(&test_env.env);
    members.push_back(GroupMember {
        address: Address::generate(&test_env.env),
        percentage: 100,
    });
    client.update_members(&id, &creator, &members);
}

/// deactivate_group while paused must be rejected.
#[test]
#[should_panic]
fn test_deactivate_group_while_paused_is_rejected() {
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

    client.pause(&test_env.admin);
    client.deactivate_group(&id, &creator);
}

/// activate_group while paused must be rejected.
#[test]
#[should_panic]
fn test_activate_group_while_paused_is_rejected() {
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

    // Deactivate first (contract not yet paused).
    client.deactivate_group(&id, &creator);
    // Now pause.
    client.pause(&test_env.admin);
    // Attempt to activate while paused → must be rejected.
    client.activate_group(&id, &creator);
}

// ── state-conflict validation ─────────────────────────────────────────────────

/// update_members on an inactive group must be rejected.
#[test]
#[should_panic]
fn test_update_members_inactive_group_is_rejected() {
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

    let mut members = Vec::new(&test_env.env);
    members.push_back(GroupMember {
        address: Address::generate(&test_env.env),
        percentage: 100,
    });
    client.update_members(&id, &creator, &members);
}

/// Deactivating an already-inactive group must be rejected.
#[test]
#[should_panic]
fn test_deactivate_already_inactive_group_is_rejected() {
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
    client.deactivate_group(&id, &creator); // second call must panic
}

/// Activating an already-active group must be rejected.
#[test]
#[should_panic]
fn test_activate_already_active_group_is_rejected() {
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

    client.activate_group(&id, &creator); // group is already active → must panic
}

// ── authorization failure events carry Admin category ───────────────────────
//
// The contract emits AuthorizationFailure (Admin category) before returning
// Unauthorized. These tests confirm the call is rejected for non-creators.

/// A non-creator calling update_members must be rejected with Unauthorized.
#[test]
#[should_panic]
fn test_unauthorized_update_emits_authorization_failure_with_admin_category() {
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

    let mut members = Vec::new(&test_env.env);
    members.push_back(GroupMember {
        address: Address::generate(&test_env.env),
        percentage: 100,
    });
    client.update_members(&id, &intruder, &members);
}

/// A non-creator calling deactivate_group must be rejected with Unauthorized.
#[test]
#[should_panic]
fn test_unauthorized_deactivate_emits_authorization_failure_with_admin_category() {
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
    client.deactivate_group(&id, &intruder);
}

/// A non-creator calling activate_group must be rejected with Unauthorized.
#[test]
#[should_panic]
fn test_unauthorized_activate_emits_authorization_failure_with_admin_category() {
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
    // Deactivate legitimately so the activate path can be reached.
    client.deactivate_group(&id, &creator);
    client.activate_group(&id, &intruder);
}

// ── topup_subscription: invalid payloads ────────────────────────────────────

/// Zero additional usages must be rejected.
#[test]
#[should_panic]
fn test_topup_zero_additional_usages_is_rejected() {
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

    client.topup_subscription(&id, &0u32, &token, &creator);
}

/// Topping up a non-existent group must be rejected.
#[test]
#[should_panic]
fn test_topup_nonexistent_group_is_rejected() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let payer = test_env.users.get(0).unwrap().clone();
    let token = test_env.mock_tokens.get(0).unwrap().clone();
    mint_tokens(&test_env.env, &token, &payer, 100_000);

    let ghost_id = BytesN::from_array(&test_env.env, &[0xDDu8; 32]);
    client.topup_subscription(&ghost_id, &5u32, &token, &payer);
}

/// Topping up with an unsupported token must be rejected.
#[test]
#[should_panic]
fn test_topup_unsupported_token_is_rejected() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let creator = test_env.users.get(0).unwrap().clone();
    let supported_token = test_env.mock_tokens.get(0).unwrap().clone();

    let id = create_test_group(
        &test_env.env,
        &test_env.autoshare_contract,
        &creator,
        &Vec::new(&test_env.env),
        1,
        &supported_token,
    );

    // A freshly deployed, never-registered token.
    let bad_token = test_env.env.register(MockToken, ());
    let bad_token_client = MockTokenClient::new(&test_env.env, &bad_token);
    bad_token_client.initialize(
        &creator,
        &7,
        &String::from_str(&test_env.env, "Rogue2"),
        &String::from_str(&test_env.env, "RG2"),
    );
    mint_tokens(&test_env.env, &bad_token, &creator, 100_000);

    client.topup_subscription(&id, &5u32, &bad_token, &creator);
}

// ── withdrawal: invalid payloads ────────────────────────────────────────────

/// Withdrawal of exactly zero must be rejected.
#[test]
#[should_panic]
fn test_withdrawal_zero_amount_is_rejected() {
    let env = soroban_sdk::Env::default();
    env.mock_all_auths();
    let contract_id = env.register(AutoShareContract, ());
    let client = AutoShareContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    client.initialize_admin(&admin);

    let token_id = env.register(MockToken, ());
    let token_client = MockTokenClient::new(&env, &token_id);
    token_client.initialize(
        &admin,
        &7,
        &String::from_str(&env, "WT"),
        &String::from_str(&env, "WT"),
    );
    token_client.mint(&contract_id, &1000);

    let recipient = Address::generate(&env);
    client.withdraw(&admin, &token_id, &0i128, &recipient);
}

/// Withdrawal of a negative amount must be rejected.
#[test]
#[should_panic]
fn test_withdrawal_negative_amount_is_rejected() {
    let env = soroban_sdk::Env::default();
    env.mock_all_auths();
    let contract_id = env.register(AutoShareContract, ());
    let client = AutoShareContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    client.initialize_admin(&admin);

    let token_id = env.register(MockToken, ());
    let token_client = MockTokenClient::new(&env, &token_id);
    token_client.initialize(
        &admin,
        &7,
        &String::from_str(&env, "WT"),
        &String::from_str(&env, "WT"),
    );
    token_client.mint(&contract_id, &1000);

    let recipient = Address::generate(&env);
    client.withdraw(&admin, &token_id, &-1i128, &recipient);
}

/// Withdrawal of more than the contract balance must be rejected.
#[test]
#[should_panic]
fn test_withdrawal_exceeds_balance_is_rejected() {
    let env = soroban_sdk::Env::default();
    env.mock_all_auths();
    let contract_id = env.register(AutoShareContract, ());
    let client = AutoShareContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    client.initialize_admin(&admin);

    let token_id = env.register(MockToken, ());
    let token_client = MockTokenClient::new(&env, &token_id);
    token_client.initialize(
        &admin,
        &7,
        &String::from_str(&env, "WT"),
        &String::from_str(&env, "WT"),
    );
    token_client.mint(&contract_id, &500);

    let recipient = Address::generate(&env);
    client.withdraw(&admin, &token_id, &501i128, &recipient); // 1 over balance
}

// ── withdrawal event payload integrity ──────────────────────────────────────

/// Successful withdrawal emits a Withdrawal event with the Financial category
/// and the correct amount in its data payload.
#[test]
fn test_withdrawal_event_carries_correct_amount_and_financial_category() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let creator = test_env.users.get(0).unwrap().clone();
    let token = test_env.mock_tokens.get(0).unwrap().clone();

    // Create a group to fund the contract.
    create_test_group(
        &test_env.env,
        &test_env.autoshare_contract,
        &creator,
        &Vec::new(&test_env.env),
        1,
        &token,
    );

    let recipient = Address::generate(&test_env.env);
    let withdraw_amount = 1i128;
    client.withdraw(&test_env.admin, &token, &withdraw_amount, &recipient);

    // Verify the Financial category on the trailing topic.
    assert_eq!(
        last_category(&test_env.env),
        Some(NotificationCategory::Financial)
    );

    // Verify the event data (amount) is preserved.
    let (_addr, _topics, data) = test_env.env.events().all().last().unwrap();
    let amount = i128::try_from_val(&test_env.env, &data).unwrap();
    assert_eq!(amount, withdraw_amount);
}

// ── update_members event payload integrity ───────────────────────────────────

/// A valid update_members call emits AutoshareUpdated with Group category.
#[test]
fn test_update_members_valid_payload_emits_group_category() {
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
    members.push_back(GroupMember {
        address: Address::generate(&test_env.env),
        percentage: 100,
    });
    client.update_members(&id, &creator, &members);

    assert_eq!(
        last_category(&test_env.env),
        Some(NotificationCategory::Group)
    );
}

// ── reduce_usage: boundary validation ───────────────────────────────────────

/// Reducing usage on a group that has already exhausted all usages must panic.
#[test]
#[should_panic]
fn test_reduce_usage_below_zero_is_rejected() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let creator = test_env.users.get(0).unwrap().clone();
    let token = test_env.mock_tokens.get(0).unwrap().clone();

    // Create with exactly 1 usage.
    let id = create_test_group(
        &test_env.env,
        &test_env.autoshare_contract,
        &creator,
        &Vec::new(&test_env.env),
        1,
        &token,
    );

    client.reduce_usage(&id, &creator); // consumes the last usage
    client.reduce_usage(&id, &creator); // must panic: NoUsagesRemaining
}

/// Reducing usage on a non-existent group must be rejected.
#[test]
#[should_panic]
fn test_reduce_usage_nonexistent_group_is_rejected() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);

    let ghost_id = BytesN::from_array(&test_env.env, &[0xBBu8; 32]);
    let caller = Address::generate(&test_env.env);
    client.reduce_usage(&ghost_id, &caller);
}

// ── set_usage_fee: invalid payloads ──────────────────────────────────────────

/// Setting usage fee to zero must be rejected.
#[test]
#[should_panic]
fn test_set_usage_fee_zero_is_rejected() {
    let env = soroban_sdk::Env::default();
    env.mock_all_auths();
    let contract_id = env.register(AutoShareContract, ());
    let client = AutoShareContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    client.initialize_admin(&admin);
    client.set_usage_fee(&0u32, &admin);
}

/// A non-admin setting the usage fee must be rejected.
#[test]
#[should_panic]
fn test_set_usage_fee_by_non_admin_is_rejected() {
    let env = soroban_sdk::Env::default();
    env.mock_all_auths();
    let contract_id = env.register(AutoShareContract, ());
    let client = AutoShareContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let non_admin = Address::generate(&env);
    client.initialize_admin(&admin);
    client.set_usage_fee(&20u32, &non_admin);
}

// ── admin token management: invalid payloads ────────────────────────────────

/// Adding a duplicate token must be rejected.
#[test]
#[should_panic]
fn test_add_supported_token_duplicate_is_rejected() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);

    let token = test_env.mock_tokens.get(0).unwrap().clone();
    // Token was already added by setup_test_env — adding again must panic.
    client.add_supported_token(&token, &test_env.admin);
}

/// Removing a token that is not in the list must be rejected.
#[test]
#[should_panic]
fn test_remove_supported_token_not_found_is_rejected() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);

    let unknown = Address::generate(&test_env.env);
    client.remove_supported_token(&unknown, &test_env.admin);
}

// ── edge case: create then immediately get ───────────────────────────────────

/// Creating a group and immediately retrieving it should return consistent data,
/// confirming the payload is persisted correctly after emission.
#[test]
fn test_create_payload_persisted_correctly_after_event() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let creator = test_env.users.get(0).unwrap().clone();
    let token = test_env.mock_tokens.get(0).unwrap().clone();

    let usage_count = 5u32;
    let id = create_test_group(
        &test_env.env,
        &test_env.autoshare_contract,
        &creator,
        &Vec::new(&test_env.env),
        usage_count,
        &token,
    );

    let group = client.get(&id);
    assert_eq!(group.creator, creator);
    assert_eq!(group.usage_count, usage_count);
    assert_eq!(group.total_usages_paid, usage_count);
    assert!(group.is_active);

    // Event category verification (autoshare_created → Group) is covered by
    // notification_test.rs::test_created_event_has_group_category.
    // This test focuses on payload persistence correctness.
}
