//! Tests for contract-level enumeration limits (Issue #1199).
//!
//! Acceptance criteria verified here:
//! - Enumeration operations have documented limits (`MAX_ENUMERATION_PAGE_SIZE = 100`).
//! - Oversized requests are rejected with `Error::PageLimitExceeded`.
//! - Valid page requests return deterministic, correctly bounded slices.
//! - Offset beyond the collection size returns an empty Vec (not an error).
//! - `get_max_enumeration_page_size` returns the documented constant.

use crate::base::errors::Error;
use crate::base::events::NotificationPriority;
use crate::test_utils::{mint_tokens, setup_test_env};
use crate::AutoShareContractClient;
use soroban_sdk::testutils::Address as _;
use soroban_sdk::{Address, BytesN, Env, String};

const ONE_HOUR: u64 = 3_600;

fn make_notification_id(env: &Env, tag: u8) -> BytesN<32> {
    let mut bytes = [0u8; 32];
    bytes[0] = tag;
    BytesN::from_array(env, &bytes)
}

fn make_title(env: &Env) -> String {
    String::from_str(env, "Test notification title")
}

fn make_group_id(env: &Env, tag: u8) -> BytesN<32> {
    let mut bytes = [0u8; 32];
    bytes[31] = tag;
    BytesN::from_array(env, &bytes)
}

// ============================================================================
// MAX_ENUMERATION_PAGE_SIZE contract
// ============================================================================

#[test]
fn test_max_enumeration_page_size_is_100() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    assert_eq!(client.get_max_enumeration_page_size(), 100u32);
}

// ============================================================================
// get_all_groups_paged
// ============================================================================

#[test]
fn test_get_all_groups_paged_oversized_request_rejected() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);

    let result = client.try_get_all_groups_paged(&0, &101);
    assert_eq!(result, Err(Ok(Error::PageLimitExceeded)));
}

#[test]
fn test_get_all_groups_paged_exact_limit_accepted() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);

    // page_size == MAX_ENUMERATION_PAGE_SIZE should succeed (empty result, no error)
    let result = client.get_all_groups_paged(&0, &100);
    assert_eq!(result.len(), 0);
}

#[test]
fn test_get_all_groups_paged_zero_page_size_returns_empty() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);

    let creator = test_env.users.get(0).unwrap();
    let token = test_env.mock_tokens.get(0).unwrap();
    let id = make_group_id(&test_env.env, 1);
    let name = String::from_str(&test_env.env, "Group A");
    mint_tokens(&test_env.env, &token, &creator, 10_000);
    client.create(&id, &name, &creator, &1u32, &token);

    let result = client.get_all_groups_paged(&0, &0);
    assert_eq!(result.len(), 0);
}

#[test]
fn test_get_all_groups_paged_returns_correct_slice() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);

    let creator = test_env.users.get(0).unwrap();
    let token = test_env.mock_tokens.get(0).unwrap();

    // Create 5 groups
    for i in 1u8..=5 {
        let id = make_group_id(&test_env.env, i);
        let name = String::from_str(&test_env.env, "Group");
        mint_tokens(&test_env.env, &token, &creator, 10_000);
        client.create(&id, &name, &creator, &1u32, &token);
    }

    // First page of 3
    let page1 = client.get_all_groups_paged(&0, &3);
    assert_eq!(page1.len(), 3);

    // Second page of 3 (only 2 remain)
    let page2 = client.get_all_groups_paged(&3, &3);
    assert_eq!(page2.len(), 2);

    // No overlap between pages
    assert_ne!(page1.get(0).unwrap().id, page2.get(0).unwrap().id);
}

#[test]
fn test_get_all_groups_paged_offset_beyond_end_returns_empty() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);

    let creator = test_env.users.get(0).unwrap();
    let token = test_env.mock_tokens.get(0).unwrap();
    let id = make_group_id(&test_env.env, 1);
    let name = String::from_str(&test_env.env, "Only Group");
    mint_tokens(&test_env.env, &token, &creator, 10_000);
    client.create(&id, &name, &creator, &1u32, &token);

    // Offset past the only group
    let result = client.get_all_groups_paged(&10, &10);
    assert_eq!(result.len(), 0);
}

#[test]
fn test_get_all_groups_paged_deterministic() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);

    let creator = test_env.users.get(0).unwrap();
    let token = test_env.mock_tokens.get(0).unwrap();

    for i in 1u8..=4 {
        let id = make_group_id(&test_env.env, i);
        let name = String::from_str(&test_env.env, "Group");
        mint_tokens(&test_env.env, &token, &creator, 10_000);
        client.create(&id, &name, &creator, &1u32, &token);
    }

    let first_call = client.get_all_groups_paged(&0, &4);
    let second_call = client.get_all_groups_paged(&0, &4);
    assert_eq!(first_call.len(), second_call.len());
    for i in 0..first_call.len() {
        assert_eq!(
            first_call.get(i).unwrap().id,
            second_call.get(i).unwrap().id
        );
    }
}

// ============================================================================
// get_audit_log_paged
// ============================================================================

#[test]
fn test_get_audit_log_paged_oversized_request_rejected() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);

    let result = client.try_get_audit_log_paged(&0, &101);
    assert_eq!(result, Err(Ok(Error::PageLimitExceeded)));
}

#[test]
fn test_get_audit_log_paged_exact_limit_accepted() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);

    let result = client.get_audit_log_paged(&0, &100);
    assert_eq!(result.len(), 0);
}

#[test]
fn test_get_audit_log_paged_returns_correct_slice() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);

    let creator = test_env.users.get(0).unwrap();

    // Schedule 5 notifications to populate audit records
    for i in 1u8..=5 {
        let nid = make_notification_id(&test_env.env, i);
        client.schedule_notification(
            &nid,
            &creator,
            &ONE_HOUR,
            &make_title(&test_env.env),
            &NotificationPriority::Medium,
        );
        // Record a delivery attempt to add another audit entry
        client.record_delivery_attempt(&nid, &creator);
    }

    // 5 schedule (Created) + 5 delivery attempts = 10 total audit records
    let full_log = client.get_audit_log();
    assert!(full_log.len() >= 5);

    let page = client.get_audit_log_paged(&0, &5);
    assert_eq!(page.len(), 5);
    // seq is 1-based and ascending
    assert!(page.get(0).unwrap().seq <= page.get(4).unwrap().seq);
}

#[test]
fn test_get_audit_log_paged_offset_beyond_end_returns_empty() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);

    let creator = test_env.users.get(0).unwrap();
    let nid = make_notification_id(&test_env.env, 1);
    client.schedule_notification(
        &nid,
        &creator,
        &ONE_HOUR,
        &make_title(&test_env.env),
        &NotificationPriority::Low,
    );

    // Log has 1 record; offset 100 should give empty
    let result = client.get_audit_log_paged(&100, &10);
    assert_eq!(result.len(), 0);
}

// ============================================================================
// get_notification_audit_paged
// ============================================================================

#[test]
fn test_get_notification_audit_paged_oversized_request_rejected() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);

    let nid = make_notification_id(&test_env.env, 1);
    let result = client.try_get_notification_audit_paged(&nid, &0, &101);
    assert_eq!(result, Err(Ok(Error::PageLimitExceeded)));
}

#[test]
fn test_get_notification_audit_paged_returns_matching_records_only() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);

    let creator = test_env.users.get(0).unwrap();
    let nid_a = make_notification_id(&test_env.env, 10);
    let nid_b = make_notification_id(&test_env.env, 20);

    client.schedule_notification(
        &nid_a,
        &creator,
        &ONE_HOUR,
        &make_title(&test_env.env),
        &NotificationPriority::High,
    );
    client.record_delivery_attempt(&nid_a, &creator);
    client.schedule_notification(
        &nid_b,
        &creator,
        &ONE_HOUR,
        &make_title(&test_env.env),
        &NotificationPriority::Low,
    );

    // nid_a has 2 records (Created + DeliveryAttempt), nid_b has 1 (Created)
    let paged = client.get_notification_audit_paged(&nid_a, &0, &10);
    assert_eq!(paged.len(), 2);
    for rec in paged.iter() {
        assert_eq!(rec.notification_id, nid_a);
    }
}

#[test]
fn test_get_notification_audit_paged_offset_and_size() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);

    let creator = test_env.users.get(0).unwrap();
    let nid = make_notification_id(&test_env.env, 5);

    client.schedule_notification(
        &nid,
        &creator,
        &ONE_HOUR,
        &make_title(&test_env.env),
        &NotificationPriority::Medium,
    );
    client.record_delivery_attempt(&nid, &creator);
    client.record_delivery_failure(&nid, &creator);

    // All 3 records
    let all = client.get_notification_audit_paged(&nid, &0, &10);
    assert_eq!(all.len(), 3);

    // Only the second record
    let second = client.get_notification_audit_paged(&nid, &1, &1);
    assert_eq!(second.len(), 1);
    assert_eq!(second.get(0).unwrap().seq, all.get(1).unwrap().seq);

    // Offset past end
    let beyond = client.get_notification_audit_paged(&nid, &100, &10);
    assert_eq!(beyond.len(), 0);
}

// ============================================================================
// get_user_payment_history_paged
// ============================================================================

#[test]
fn test_get_user_payment_history_paged_oversized_request_rejected() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);

    let user = test_env.users.get(0).unwrap();
    let result = client.try_get_user_payment_history_paged(&user, &0, &101);
    assert_eq!(result, Err(Ok(Error::PageLimitExceeded)));
}

#[test]
fn test_get_user_payment_history_paged_returns_subset() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);

    let creator = test_env.users.get(0).unwrap();
    let token = test_env.mock_tokens.get(0).unwrap();

    // Create 3 groups → 3 payment records for the creator
    for i in 1u8..=3 {
        let id = make_group_id(&test_env.env, i + 100);
        let name = String::from_str(&test_env.env, "Pay Group");
        mint_tokens(&test_env.env, &token, &creator, 10_000);
        client.create(&id, &name, &creator, &1u32, &token);
    }

    let all_history = client.get_user_payment_history(&creator);
    assert_eq!(all_history.len(), 3);

    let page = client.get_user_payment_history_paged(&creator, &0, &2);
    assert_eq!(page.len(), 2);

    let page2 = client.get_user_payment_history_paged(&creator, &2, &2);
    assert_eq!(page2.len(), 1);
}

// ============================================================================
// get_group_payment_history_paged
// ============================================================================

#[test]
fn test_get_group_payment_history_paged_oversized_request_rejected() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);

    let id = make_group_id(&test_env.env, 1);
    let result = client.try_get_group_payment_history_paged(&id, &0, &101);
    assert_eq!(result, Err(Ok(Error::PageLimitExceeded)));
}

#[test]
fn test_get_group_payment_history_paged_returns_subset() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);

    let creator = test_env.users.get(0).unwrap();
    let token = test_env.mock_tokens.get(0).unwrap();
    let id = make_group_id(&test_env.env, 7);
    let name = String::from_str(&test_env.env, "History Group");

    // Create group (1 payment record) then top up twice (2 more records)
    mint_tokens(&test_env.env, &token, &creator, 100_000);
    client.create(&id, &name, &creator, &1u32, &token);
    client.topup_subscription(&id, &1u32, &token, &creator);
    client.topup_subscription(&id, &1u32, &token, &creator);

    let all = client.get_group_payment_history(&id);
    assert_eq!(all.len(), 3);

    let page1 = client.get_group_payment_history_paged(&id, &0, &2);
    assert_eq!(page1.len(), 2);

    let page2 = client.get_group_payment_history_paged(&id, &2, &2);
    assert_eq!(page2.len(), 1);
}
