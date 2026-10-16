/// Event Regression Tests
///
/// This module provides comprehensive regression testing for all smart contract events
/// to ensure strict ABI stability. These tests validate:
/// - Event names (symbols)
/// - Topic count and ordering
/// - Topic values (addresses, IDs, etc.)
/// - Event payload data structures
///
/// Any breaking change to event structure will cause these tests to fail,
/// preventing silent breakage of downstream consumers and indexers.

use crate::base::types::GroupMember;
use crate::test_utils::{create_test_group, mint_tokens, setup_test_env};
use crate::{AutoShareContract, AutoShareContractClient};
use soroban_sdk::{
    testutils::{Address as _, Events},
    vec, Address, BytesN, Env, IntoVal, String, Symbol, Val, Vec,
};

// ============================================================================
// Event Name Constants
// These constants represent the canonical event names that must never change
// ============================================================================

const EVENT_AUTOSHARE_CREATED: &str = "AutoshareCreated";
const EVENT_CONTRACT_PAUSED: &str = "ContractPaused";
const EVENT_CONTRACT_UNPAUSED: &str = "ContractUnpaused";
const EVENT_AUTOSHARE_UPDATED: &str = "AutoshareUpdated";
const EVENT_GROUP_DEACTIVATED: &str = "GroupDeactivated";
const EVENT_GROUP_ACTIVATED: &str = "GroupActivated";
const EVENT_ADMIN_TRANSFERRED: &str = "AdminTransferred";
const EVENT_WITHDRAWAL: &str = "Withdrawal";

// ============================================================================
// Helper Functions for Event Inspection
// ============================================================================

/// Extract all events emitted during a test and return them for inspection
fn get_all_events(env: &Env) -> soroban_sdk::vec::Vec<(Address, (Vec<Val>, Val), Val)> {
    env.events().all()
}

/// Find the most recent event with the given name
fn find_latest_event_by_name(
    env: &Env,
    contract_id: &Address,
    event_name: &str,
) -> Option<(Vec<Val>, Val)> {
    let events = env.events().all();
    
    // Iterate in reverse to find the latest event
    for i in (0..events.len()).rev() {
        let event = events.get(i).unwrap();
        
        // event.0 = contract address
        // event.1 = topics (Vec<Val>)
        // event.2 = data
        if &event.0 == contract_id {
            let topics = &event.1.0;
            if topics.len() > 0 {
                // Topic 0 should be the event name
                let topic0_symbol: Result<Symbol, _> = topics.get(0).unwrap().try_into_val(env);
                if let Ok(sym) = topic0_symbol {
                    let sym_str = sym.to_string();
                    if sym_str == event_name {
                        return Some(event.1.clone());
                    }
                }
            }
        }
    }
    None
}

/// Assert that a specific event was emitted with exact topic structure
fn assert_event_emitted(
    env: &Env,
    contract_id: &Address,
    expected_event_name: &str,
    expected_topic_count: usize,
) {
    let event = find_latest_event_by_name(env, contract_id, expected_event_name);
    assert!(
        event.is_some(),
        "Event '{}' was not emitted",
        expected_event_name
    );
    
    let (topics, _) = event.unwrap();
    assert_eq!(
        topics.len(),
        expected_topic_count,
        "Event '{}' has incorrect topic count. Expected {}, got {}",
        expected_event_name,
        expected_topic_count,
        topics.len()
    );
}

/// Extract and validate the event name from topic 0
fn assert_event_name(env: &Env, topics: &Vec<Val>, expected_name: &str) {
    assert!(
        topics.len() > 0,
        "Event has no topics (expected at least event name)"
    );
    
    let topic0: Symbol = topics
        .get(0)
        .unwrap()
        .try_into_val(env)
        .expect("Topic 0 should be a Symbol (event name)");
    
    let actual_name = topic0.to_string();
    assert_eq!(
        actual_name, expected_name,
        "Event name mismatch. Expected '{}', got '{}'",
        expected_name, actual_name
    );
}

/// Extract an Address from a specific topic index
fn get_address_from_topic(env: &Env, topics: &Vec<Val>, index: u32) -> Address {
    let topic_val = topics
        .get(index)
        .expect(&format!("Topic {} does not exist", index));
    
    topic_val
        .try_into_val(env)
        .expect(&format!("Topic {} is not an Address", index))
}

/// Extract a BytesN<32> from event data
fn get_bytes32_from_data(env: &Env, data: &Val) -> BytesN<32> {
    data.try_into_val(env)
        .expect("Event data should be BytesN<32>")
}

/// Extract an i128 from event data
fn get_i128_from_data(env: &Env, data: &Val) -> i128 {
    data.try_into_val(env)
        .expect("Event data should be i128")
}

// ============================================================================
// AutoshareCreated Event Tests
// ============================================================================

#[test]
fn test_autoshare_created_event_structure() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    
    let creator = test_env.users.get(0).unwrap().clone();
    let token = test_env.mock_tokens.get(0).unwrap().clone();
    
    // Mint tokens for the creator
    mint_tokens(&test_env.env, &token, &creator, 10000);
    
    // Create a group
    let id = BytesN::from_array(&test_env.env, &[1u8; 32]);
    let name = String::from_str(&test_env.env, "Test Group");
    client.create(&id, &name, &creator, &1u32, &token);
    
    // Validate event was emitted with correct structure
    assert_event_emitted(
        &test_env.env,
        &test_env.autoshare_contract,
        EVENT_AUTOSHARE_CREATED,
        2, // Topic 0: event name, Topic 1: creator address
    );
    
    let event = find_latest_event_by_name(
        &test_env.env,
        &test_env.autoshare_contract,
        EVENT_AUTOSHARE_CREATED,
    )
    .unwrap();
    
    let (topics, data) = event;
    
    // Assert Topic 0: Event name
    assert_event_name(&test_env.env, &topics, EVENT_AUTOSHARE_CREATED);
    
    // Assert Topic 1: Creator address
    let event_creator = get_address_from_topic(&test_env.env, &topics, 1);
    assert_eq!(
        event_creator, creator,
        "AutoshareCreated event topic 1 (creator) mismatch"
    );
    
    // Assert Data: Group ID
    let event_id: BytesN<32> = get_bytes32_from_data(&test_env.env, &data);
    assert_eq!(
        event_id, id,
        "AutoshareCreated event data (id) mismatch"
    );
}

#[test]
fn test_autoshare_created_event_topic_ordering() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    
    let creator = test_env.users.get(0).unwrap().clone();
    let token = test_env.mock_tokens.get(0).unwrap().clone();
    mint_tokens(&test_env.env, &token, &creator, 10000);
    
    let id = BytesN::from_array(&test_env.env, &[2u8; 32]);
    let name = String::from_str(&test_env.env, "Ordering Test");
    client.create(&id, &name, &creator, &1u32, &token);
    
    let event = find_latest_event_by_name(
        &test_env.env,
        &test_env.autoshare_contract,
        EVENT_AUTOSHARE_CREATED,
    )
    .expect("AutoshareCreated event should be emitted");
    
    let (topics, _) = event;
    
    // Strict ordering check: Topic 0 = event name, Topic 1 = creator
    assert_eq!(
        topics.len(),
        2,
        "AutoshareCreated must have exactly 2 topics"
    );
    
    // Verify topic 0 is a Symbol (event name)
    let _: Symbol = topics
        .get(0)
        .unwrap()
        .try_into_val(&test_env.env)
        .expect("Topic 0 must be a Symbol (event name)");
    
    // Verify topic 1 is an Address (creator)
    let _: Address = topics
        .get(1)
        .unwrap()
        .try_into_val(&test_env.env)
        .expect("Topic 1 must be an Address (creator)");
}

// ============================================================================
// ContractPaused Event Tests
// ============================================================================

#[test]
fn test_contract_paused_event_structure() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    
    // Pause the contract
    client.pause(&test_env.admin);
    
    // Validate event was emitted with correct structure
    assert_event_emitted(
        &test_env.env,
        &test_env.autoshare_contract,
        EVENT_CONTRACT_PAUSED,
        1, // Only topic 0: event name (no additional topics)
    );
    
    let event = find_latest_event_by_name(
        &test_env.env,
        &test_env.autoshare_contract,
        EVENT_CONTRACT_PAUSED,
    )
    .unwrap();
    
    let (topics, _) = event;
    
    // Assert Topic 0: Event name
    assert_event_name(&test_env.env, &topics, EVENT_CONTRACT_PAUSED);
    
    // Assert no additional topics
    assert_eq!(
        topics.len(),
        1,
        "ContractPaused should only have event name topic"
    );
}

#[test]
fn test_contract_paused_event_no_data_payload() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    
    client.pause(&test_env.admin);
    
    let event = find_latest_event_by_name(
        &test_env.env,
        &test_env.autoshare_contract,
        EVENT_CONTRACT_PAUSED,
    )
    .expect("ContractPaused event should be emitted");
    
    let (_, data) = event;
    
    // ContractPaused has no data payload (empty struct)
    // Verify that data is the unit type ()
    let _: () = data
        .try_into_val(&test_env.env)
        .expect("ContractPaused data should be unit type ()");
}

// ============================================================================
// ContractUnpaused Event Tests
// ============================================================================

#[test]
fn test_contract_unpaused_event_structure() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    
    // Pause and then unpause
    client.pause(&test_env.admin);
    client.unpause(&test_env.admin);
    
    // Validate event was emitted with correct structure
    assert_event_emitted(
        &test_env.env,
        &test_env.autoshare_contract,
        EVENT_CONTRACT_UNPAUSED,
        1, // Only topic 0: event name
    );
    
    let event = find_latest_event_by_name(
        &test_env.env,
        &test_env.autoshare_contract,
        EVENT_CONTRACT_UNPAUSED,
    )
    .unwrap();
    
    let (topics, _) = event;
    
    // Assert Topic 0: Event name
    assert_event_name(&test_env.env, &topics, EVENT_CONTRACT_UNPAUSED);
    
    // Assert no additional topics
    assert_eq!(
        topics.len(),
        1,
        "ContractUnpaused should only have event name topic"
    );
}

// ============================================================================
// AutoshareUpdated Event Tests
// ============================================================================

#[test]
fn test_autoshare_updated_event_structure() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    
    let creator = test_env.users.get(0).unwrap().clone();
    let token = test_env.mock_tokens.get(0).unwrap().clone();
    
    // Create a group
    let id = BytesN::from_array(&test_env.env, &[3u8; 32]);
    let name = String::from_str(&test_env.env, "Update Test");
    mint_tokens(&test_env.env, &token, &creator, 10000);
    client.create(&id, &name, &creator, &1u32, &token);
    
    // Update members
    let mut new_members = Vec::new(&test_env.env);
    new_members.push_back(GroupMember {
        address: Address::generate(&test_env.env),
        percentage: 100,
    });
    client.update_members(&id, &creator, &new_members);
    
    // Validate event was emitted with correct structure
    assert_event_emitted(
        &test_env.env,
        &test_env.autoshare_contract,
        EVENT_AUTOSHARE_UPDATED,
        2, // Topic 0: event name, Topic 1: updater address
    );
    
    let event = find_latest_event_by_name(
        &test_env.env,
        &test_env.autoshare_contract,
        EVENT_AUTOSHARE_UPDATED,
    )
    .unwrap();
    
    let (topics, data) = event;
    
    // Assert Topic 0: Event name
    assert_event_name(&test_env.env, &topics, EVENT_AUTOSHARE_UPDATED);
    
    // Assert Topic 1: Updater address
    let event_updater = get_address_from_topic(&test_env.env, &topics, 1);
    assert_eq!(
        event_updater, creator,
        "AutoshareUpdated event topic 1 (updater) mismatch"
    );
    
    // Assert Data: Group ID
    let event_id: BytesN<32> = get_bytes32_from_data(&test_env.env, &data);
    assert_eq!(
        event_id, id,
        "AutoshareUpdated event data (id) mismatch"
    );
}

// ============================================================================
// GroupDeactivated Event Tests
// ============================================================================

#[test]
fn test_group_deactivated_event_structure() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    
    let creator = test_env.users.get(0).unwrap().clone();
    let token = test_env.mock_tokens.get(0).unwrap().clone();
    
    // Create and setup a group
    let mut members = Vec::new(&test_env.env);
    members.push_back(GroupMember {
        address: Address::generate(&test_env.env),
        percentage: 100,
    });
    
    let id = create_test_group(
        &test_env.env,
        &test_env.autoshare_contract,
        &creator,
        &members,
        1,
        &token,
    );
    
    // Deactivate the group
    client.deactivate_group(&id, &creator);
    
    // Validate event was emitted with correct structure
    assert_event_emitted(
        &test_env.env,
        &test_env.autoshare_contract,
        EVENT_GROUP_DEACTIVATED,
        2, // Topic 0: event name, Topic 1: creator address
    );
    
    let event = find_latest_event_by_name(
        &test_env.env,
        &test_env.autoshare_contract,
        EVENT_GROUP_DEACTIVATED,
    )
    .unwrap();
    
    let (topics, data) = event;
    
    // Assert Topic 0: Event name
    assert_event_name(&test_env.env, &topics, EVENT_GROUP_DEACTIVATED);
    
    // Assert Topic 1: Creator address
    let event_creator = get_address_from_topic(&test_env.env, &topics, 1);
    assert_eq!(
        event_creator, creator,
        "GroupDeactivated event topic 1 (creator) mismatch"
    );
    
    // Assert Data: Group ID
    let event_id: BytesN<32> = get_bytes32_from_data(&test_env.env, &data);
    assert_eq!(
        event_id, id,
        "GroupDeactivated event data (id) mismatch"
    );
}

// ============================================================================
// GroupActivated Event Tests
// ============================================================================

#[test]
fn test_group_activated_event_structure() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    
    let creator = test_env.users.get(0).unwrap().clone();
    let token = test_env.mock_tokens.get(0).unwrap().clone();
    
    // Create and setup a group
    let mut members = Vec::new(&test_env.env);
    members.push_back(GroupMember {
        address: Address::generate(&test_env.env),
        percentage: 100,
    });
    
    let id = create_test_group(
        &test_env.env,
        &test_env.autoshare_contract,
        &creator,
        &members,
        1,
        &token,
    );
    
    // Deactivate first, then activate
    client.deactivate_group(&id, &creator);
    client.activate_group(&id, &creator);
    
    // Validate event was emitted with correct structure
    assert_event_emitted(
        &test_env.env,
        &test_env.autoshare_contract,
        EVENT_GROUP_ACTIVATED,
        2, // Topic 0: event name, Topic 1: creator address
    );
    
    let event = find_latest_event_by_name(
        &test_env.env,
        &test_env.autoshare_contract,
        EVENT_GROUP_ACTIVATED,
    )
    .unwrap();
    
    let (topics, data) = event;
    
    // Assert Topic 0: Event name
    assert_event_name(&test_env.env, &topics, EVENT_GROUP_ACTIVATED);
    
    // Assert Topic 1: Creator address
    let event_creator = get_address_from_topic(&test_env.env, &topics, 1);
    assert_eq!(
        event_creator, creator,
        "GroupActivated event topic 1 (creator) mismatch"
    );
    
    // Assert Data: Group ID
    let event_id: BytesN<32> = get_bytes32_from_data(&test_env.env, &data);
    assert_eq!(
        event_id, id,
        "GroupActivated event data (id) mismatch"
    );
}

// ============================================================================
// AdminTransferred Event Tests
// ============================================================================

#[test]
fn test_admin_transferred_event_structure() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    
    let new_admin = Address::generate(&test_env.env);
    
    // Transfer admin
    client.transfer_admin(&test_env.admin, &new_admin);
    
    // Validate event was emitted with correct structure
    assert_event_emitted(
        &test_env.env,
        &test_env.autoshare_contract,
        EVENT_ADMIN_TRANSFERRED,
        2, // Topic 0: event name, Topic 1: old_admin address
    );
    
    let event = find_latest_event_by_name(
        &test_env.env,
        &test_env.autoshare_contract,
        EVENT_ADMIN_TRANSFERRED,
    )
    .unwrap();
    
    let (topics, data) = event;
    
    // Assert Topic 0: Event name
    assert_event_name(&test_env.env, &topics, EVENT_ADMIN_TRANSFERRED);
    
    // Assert Topic 1: Old admin address
    let event_old_admin = get_address_from_topic(&test_env.env, &topics, 1);
    assert_eq!(
        event_old_admin, test_env.admin,
        "AdminTransferred event topic 1 (old_admin) mismatch"
    );
    
    // Assert Data: New admin address
    let event_new_admin: Address = data
        .try_into_val(&test_env.env)
        .expect("AdminTransferred data should be Address (new_admin)");
    assert_eq!(
        event_new_admin, new_admin,
        "AdminTransferred event data (new_admin) mismatch"
    );
}

#[test]
fn test_admin_transferred_event_topic_ordering() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    
    let new_admin = Address::generate(&test_env.env);
    client.transfer_admin(&test_env.admin, &new_admin);
    
    let event = find_latest_event_by_name(
        &test_env.env,
        &test_env.autoshare_contract,
        EVENT_ADMIN_TRANSFERRED,
    )
    .expect("AdminTransferred event should be emitted");
    
    let (topics, _) = event;
    
    // Strict ordering check
    assert_eq!(
        topics.len(),
        2,
        "AdminTransferred must have exactly 2 topics"
    );
    
    // Topic 0 must be Symbol (event name)
    let _: Symbol = topics
        .get(0)
        .unwrap()
        .try_into_val(&test_env.env)
        .expect("Topic 0 must be Symbol");
    
    // Topic 1 must be Address (old_admin)
    let _: Address = topics
        .get(1)
        .unwrap()
        .try_into_val(&test_env.env)
        .expect("Topic 1 must be Address (old_admin)");
}

// ============================================================================
// Withdrawal Event Tests
// ============================================================================

#[test]
fn test_withdrawal_event_structure() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    
    let token = test_env.mock_tokens.get(0).unwrap().clone();
    let recipient = Address::generate(&test_env.env);
    
    // Fund the contract first
    let creator = test_env.users.get(0).unwrap().clone();
    let mut members = Vec::new(&test_env.env);
    members.push_back(GroupMember {
        address: Address::generate(&test_env.env),
        percentage: 100,
    });
    
    create_test_group(
        &test_env.env,
        &test_env.autoshare_contract,
        &creator,
        &members,
        10,
        &token,
    );
    
    // Withdraw
    let withdraw_amount = 50i128;
    client.withdraw(&test_env.admin, &token, &withdraw_amount, &recipient);
    
    // Validate event was emitted with correct structure
    assert_event_emitted(
        &test_env.env,
        &test_env.autoshare_contract,
        EVENT_WITHDRAWAL,
        3, // Topic 0: event name, Topic 1: token, Topic 2: recipient
    );
    
    let event = find_latest_event_by_name(
        &test_env.env,
        &test_env.autoshare_contract,
        EVENT_WITHDRAWAL,
    )
    .unwrap();
    
    let (topics, data) = event;
    
    // Assert Topic 0: Event name
    assert_event_name(&test_env.env, &topics, EVENT_WITHDRAWAL);
    
    // Assert Topic 1: Token address
    let event_token = get_address_from_topic(&test_env.env, &topics, 1);
    assert_eq!(
        event_token, token,
        "Withdrawal event topic 1 (token) mismatch"
    );
    
    // Assert Topic 2: Recipient address
    let event_recipient = get_address_from_topic(&test_env.env, &topics, 2);
    assert_eq!(
        event_recipient, recipient,
        "Withdrawal event topic 2 (recipient) mismatch"
    );
    
    // Assert Data: Amount
    let event_amount: i128 = get_i128_from_data(&test_env.env, &data);
    assert_eq!(
        event_amount, withdraw_amount,
        "Withdrawal event data (amount) mismatch"
    );
}

#[test]
fn test_withdrawal_event_topic_ordering() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    
    let token = test_env.mock_tokens.get(0).unwrap().clone();
    let recipient = Address::generate(&test_env.env);
    
    // Fund the contract
    let creator = test_env.users.get(0).unwrap().clone();
    let mut members = Vec::new(&test_env.env);
    members.push_back(GroupMember {
        address: Address::generate(&test_env.env),
        percentage: 100,
    });
    
    create_test_group(
        &test_env.env,
        &test_env.autoshare_contract,
        &creator,
        &members,
        10,
        &token,
    );
    
    client.withdraw(&test_env.admin, &token, &50i128, &recipient);
    
    let event = find_latest_event_by_name(
        &test_env.env,
        &test_env.autoshare_contract,
        EVENT_WITHDRAWAL,
    )
    .expect("Withdrawal event should be emitted");
    
    let (topics, _) = event;
    
    // Strict ordering check
    assert_eq!(
        topics.len(),
        3,
        "Withdrawal must have exactly 3 topics"
    );
    
    // Topic 0: Symbol (event name)
    let _: Symbol = topics
        .get(0)
        .unwrap()
        .try_into_val(&test_env.env)
        .expect("Topic 0 must be Symbol");
    
    // Topic 1: Address (token)
    let _: Address = topics
        .get(1)
        .unwrap()
        .try_into_val(&test_env.env)
        .expect("Topic 1 must be Address (token)");
    
    // Topic 2: Address (recipient)
    let _: Address = topics
        .get(2)
        .unwrap()
        .try_into_val(&test_env.env)
        .expect("Topic 2 must be Address (recipient)");
}

// ============================================================================
// Cross-Event Validation Tests
// ============================================================================

#[test]
fn test_multiple_events_in_sequence() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    
    let creator = test_env.users.get(0).unwrap().clone();
    let token = test_env.mock_tokens.get(0).unwrap().clone();
    
    // Create a group (AutoshareCreated event)
    let mut members = Vec::new(&test_env.env);
    members.push_back(GroupMember {
        address: Address::generate(&test_env.env),
        percentage: 100,
    });
    
    let id = create_test_group(
        &test_env.env,
        &test_env.autoshare_contract,
        &creator,
        &members,
        1,
        &token,
    );
    
    // Deactivate the group (GroupDeactivated event)
    client.deactivate_group(&id, &creator);
    
    // Activate the group (GroupActivated event)
    client.activate_group(&id, &creator);
    
    // Verify all three events exist with correct names
    let all_events = get_all_events(&test_env.env);
    let mut event_names = Vec::new(&test_env.env);
    
    for i in 0..all_events.len() {
        let event = all_events.get(i).unwrap();
        if &event.0 == &test_env.autoshare_contract {
            let topics = &event.1.0;
            if topics.len() > 0 {
                if let Ok(sym) = topics.get(0).unwrap().try_into_val::<Symbol>(&test_env.env) {
                    event_names.push_back(sym.to_string());
                }
            }
        }
    }
    
    // Should contain at least AutoshareCreated, GroupDeactivated, GroupActivated
    let event_names_str: std::vec::Vec<String> = (0..event_names.len())
        .map(|i| event_names.get(i).unwrap().to_string())
        .collect();
    
    assert!(
        event_names_str.contains(&EVENT_AUTOSHARE_CREATED.to_string()),
        "Missing AutoshareCreated event"
    );
    assert!(
        event_names_str.contains(&EVENT_GROUP_DEACTIVATED.to_string()),
        "Missing GroupDeactivated event"
    );
    assert!(
        event_names_str.contains(&EVENT_GROUP_ACTIVATED.to_string()),
        "Missing GroupActivated event"
    );
}

#[test]
fn test_event_names_are_stable() {
    // This test ensures that event names remain unchanged
    // Any change to these constant values indicates a breaking change
    
    assert_eq!(EVENT_AUTOSHARE_CREATED, "AutoshareCreated");
    assert_eq!(EVENT_CONTRACT_PAUSED, "ContractPaused");
    assert_eq!(EVENT_CONTRACT_UNPAUSED, "ContractUnpaused");
    assert_eq!(EVENT_AUTOSHARE_UPDATED, "AutoshareUpdated");
    assert_eq!(EVENT_GROUP_DEACTIVATED, "GroupDeactivated");
    assert_eq!(EVENT_GROUP_ACTIVATED, "GroupActivated");
    assert_eq!(EVENT_ADMIN_TRANSFERRED, "AdminTransferred");
    assert_eq!(EVENT_WITHDRAWAL, "Withdrawal");
}

// ============================================================================
// Negative Tests: Ensuring Events Are NOT Emitted When They Shouldn't Be
// ============================================================================

#[test]
fn test_no_event_on_read_operations() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    
    let creator = test_env.users.get(0).unwrap().clone();
    let token = test_env.mock_tokens.get(0).unwrap().clone();
    
    // Create a group
    let mut members = Vec::new(&test_env.env);
    members.push_back(GroupMember {
        address: Address::generate(&test_env.env),
        percentage: 100,
    });
    
    let id = create_test_group(
        &test_env.env,
        &test_env.autoshare_contract,
        &creator,
        &members,
        1,
        &token,
    );
    
    // Count events before read operations
    let events_before = get_all_events(&test_env.env).len();
    
    // Perform read operations
    let _ = client.get(&id);
    let _ = client.get_all_groups();
    let _ = client.get_groups_by_creator(&creator);
    let _ = client.is_group_member(&id, &creator);
    let _ = client.is_group_active(&id);
    let _ = client.get_usage_fee();
    
    // Count events after read operations
    let events_after = get_all_events(&test_env.env).len();
    
    // No new events should be emitted for read operations
    assert_eq!(
        events_before, events_after,
        "Read operations should not emit events"
    );
}
