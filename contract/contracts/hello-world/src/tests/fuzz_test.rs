//! Property-based fuzz tests for AutoShare contract invariants.
//!
//! Targets: group member percentages, usage counts, notification TTL bounds,
//! and pause-state guards. Run via `cargo test fuzz_`.

use crate::base::events::NotificationPriority;
use crate::base::types::GroupMember;
use crate::test_utils::{create_test_group, mint_tokens, setup_test_env};
use crate::AutoShareContractClient;
use proptest::prelude::*;
use soroban_sdk::testutils::Address as _;
use soroban_sdk::{Address, BytesN, Env, String, Vec};

const ONE_HOUR: u64 = 3_600;

fn notification_title(env: &Env) -> String {
    String::from_str(env, "Test notification")
}

fn group_id(env: &Env, seed: u8) -> BytesN<32> {
    BytesN::from_array(env, &[seed; 32])
}

fn build_members(env: &Env, percentages: &[u32]) -> Vec<GroupMember> {
    let mut members = Vec::new(env);
    for pct in percentages {
        members.push_back(GroupMember {
            address: Address::generate(env),
            percentage: *pct,
        });
    }
    members
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(32))]

    #[test]
    fn fuzz_member_percentages_sum_to_100_succeed(
        p1 in 1u32..=99u32,
    ) {
        let p2 = 100u32.saturating_sub(p1);
        if p2 == 0 {
            return Ok(());
        }

        let test_env = setup_test_env();
        let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
        let creator = test_env.users.get(0).unwrap().clone();
        let members = build_members(&test_env.env, &[p1, p2]);
        let token = test_env.mock_tokens.get(0).unwrap().clone();
        mint_tokens(&test_env.env, &token, &creator, 10_000_000);

        let id = create_test_group(
            &test_env.env,
            &test_env.autoshare_contract,
            &creator,
            &members,
            1,
            &token,
        );

        let group = client.get(&id);
        prop_assert_eq!(group.members.len(), 2);

        let total: u32 = (0..group.members.len())
            .map(|i| group.members.get(i).unwrap().percentage)
            .sum();
        prop_assert_eq!(total, 100);
    }

    #[test]
    fn fuzz_zero_usage_count_always_rejected(seed in 1u8..=200u8) {
        let test_env = setup_test_env();
        let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
        let creator = test_env.users.get(0).unwrap().clone();
        let mut members = Vec::new(&test_env.env);
        members.push_back(GroupMember {
            address: Address::generate(&test_env.env),
            percentage: 100,
        });
        let token = test_env.mock_tokens.get(0).unwrap().clone();
        mint_tokens(&test_env.env, &token, &creator, 10_000_000);

        let id = group_id(&test_env.env, seed);
        let name = String::from_str(&test_env.env, "Fuzz Group");

        let result = client.try_create(&id, &name, &creator, &0u32, &token);
        prop_assert!(result.is_err());
    }

    #[test]
    fn fuzz_notification_ttl_positive_always_schedules(
        ttl in 1u64..=86_400u64,
        seed in 1u8..=200u8,
    ) {
        let test_env = setup_test_env();
        let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
        let creator = test_env.users.get(0).unwrap().clone();
        let notification_id = group_id(&test_env.env, seed);

        client.schedule_notification(
            &notification_id,
            &creator,
            &ttl,
            &notification_title(&test_env.env),
            &NotificationPriority::Medium,
        );

        let stored = client.get_notification(&notification_id);
        prop_assert_eq!(stored.expires_at - stored.created_at, ttl);
        prop_assert!(!client.is_notification_expired(&notification_id));
    }

    #[test]
    fn fuzz_notification_zero_ttl_rejected(seed in 1u8..=200u8) {
        let test_env = setup_test_env();
        let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
        let creator = test_env.users.get(0).unwrap().clone();
        let notification_id = group_id(&test_env.env, seed);

        let result = client.try_schedule_notification(
            &notification_id,
            &creator,
            &0,
            &notification_title(&test_env.env),
            &NotificationPriority::Medium,
        );
        prop_assert!(result.is_err());
    }

    #[test]
    fn fuzz_paused_contract_blocks_group_creation(seed in 1u8..=200u8) {
        let test_env = setup_test_env();
        let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
        let creator = test_env.users.get(0).unwrap().clone();
        let mut members = Vec::new(&test_env.env);
        members.push_back(GroupMember {
            address: Address::generate(&test_env.env),
            percentage: 100,
        });
        let token = test_env.mock_tokens.get(0).unwrap().clone();
        mint_tokens(&test_env.env, &token, &creator, 10_000_000);

        client.pause(&test_env.admin);

        let id = group_id(&test_env.env, seed);
        let name = String::from_str(&test_env.env, "Paused Fuzz");

        let result = client.try_create(&id, &name, &creator, &1u32, &token);
        prop_assert!(result.is_err());
        prop_assert!(client.get_paused_status());
    }
}

#[test]
fn fuzz_reduce_usage_never_exceeds_paid_total() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let creator = test_env.users.get(0).unwrap().clone();
    let mut members = Vec::new(&test_env.env);
    members.push_back(GroupMember {
        address: Address::generate(&test_env.env),
        percentage: 100,
    });
    let token = test_env.mock_tokens.get(0).unwrap().clone();
    let usages = 5u32;

    let id = create_test_group(
        &test_env.env,
        &test_env.autoshare_contract,
        &creator,
        &members,
        usages,
        &token,
    );

    for _ in 0..usages {
        client.reduce_usage(&id, &creator);
    }

    assert_eq!(client.get_remaining_usages(&id), 0);

    let overuse = client.try_reduce_usage(&id, &creator);
    assert!(overuse.is_err());
}
