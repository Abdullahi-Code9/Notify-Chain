#![allow(unused_variables)]
#![allow(unused_imports)]

use crate::base::errors::Error;
use crate::base::types::GroupMember;
use crate::{AutoShareContract, AutoShareContractClient};
use soroban_sdk::testutils::{Address as _, Events};
use soroban_sdk::{token, Address, BytesN, Env, String, Symbol, TryFromVal, Val};

fn create_token_contract<'a>(
    env: &Env,
    admin: &Address,
) -> (token::Client<'a>, token::StellarAssetClient<'a>) {
    let contract_address = env.register_stellar_asset_contract_v2(admin.clone());
    (
        token::Client::new(env, &contract_address.address()),
        token::StellarAssetClient::new(env, &contract_address.address()),
    )
}

fn latest_event_topics(env: &Env, event_name: &str) -> Option<soroban_sdk::Vec<Val>> {
    let target = Symbol::new(env, event_name);
    let mut found = None;
    for (_addr, topics, _data) in env.events().all().iter() {
        if topics.is_empty() {
            continue;
        }
        if let Ok(name) = Symbol::try_from_val(env, &topics.get(0).unwrap()) {
            if name == target {
                found = Some(topics);
            }
        }
    }
    found
}

#[test]
fn test_initial_state_is_unpaused_after_deployment() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(AutoShareContract, ());
    let client = AutoShareContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);

    client.initialize_admin(&admin);

    assert!(
        !client.get_paused_status(),
        "Contract must be active/unpaused immediately after deployment"
    );
}

#[test]
fn test_pause_emits_event_with_admin_actor() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(AutoShareContract, ());
    let client = AutoShareContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);

    client.initialize_admin(&admin);
    client.pause(&admin);

    let topics = latest_event_topics(&env, "contract_paused").expect("pause event");
    assert_eq!(topics.len(), 4);
    assert_eq!(
        Address::try_from_val(&env, &topics.get(1).unwrap()).unwrap(),
        admin
    );
}

#[test]
fn test_unpause_emits_event_with_admin_actor() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(AutoShareContract, ());
    let client = AutoShareContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);

    client.initialize_admin(&admin);
    client.pause(&admin);
    client.unpause(&admin);

    let topics = latest_event_topics(&env, "contract_unpaused").expect("unpause event");
    assert_eq!(topics.len(), 4);
    assert_eq!(
        Address::try_from_val(&env, &topics.get(1).unwrap()).unwrap(),
        admin
    );
}

#[test]
fn test_admin_can_pause() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(AutoShareContract, ());
    let client = AutoShareContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    client.initialize_admin(&admin);

    assert!(!client.get_paused_status());
    client.pause(&admin);
    assert!(client.get_paused_status());
}

#[test]
fn test_admin_can_unpause() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(AutoShareContract, ());
    let client = AutoShareContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    client.initialize_admin(&admin);

    client.pause(&admin);
    assert!(client.get_paused_status());

    client.unpause(&admin);
    assert!(!client.get_paused_status());
}

#[test]
fn test_paused_status_returned_correctly() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(AutoShareContract, ());
    let client = AutoShareContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    client.initialize_admin(&admin);

    assert!(!client.get_paused_status());
    client.pause(&admin);
    assert!(client.get_paused_status());
    client.unpause(&admin);
    assert!(!client.get_paused_status());
}

#[test]
fn test_repeated_state_transitions_active_paused_active_paused() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(AutoShareContract, ());
    let client = AutoShareContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    client.initialize_admin(&admin);

    assert!(!client.get_paused_status(), "Cycle 0: must start active");

    client.pause(&admin);
    assert!(client.get_paused_status(), "Cycle 1: must be paused");

    client.unpause(&admin);
    assert!(!client.get_paused_status(), "Cycle 1: must be active again");

    client.pause(&admin);
    assert!(client.get_paused_status(), "Cycle 2: must be paused");

    client.unpause(&admin);
    assert!(!client.get_paused_status(), "Cycle 2: must be active again");
}

#[test]
fn test_pause_already_paused_returns_already_paused_error() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(AutoShareContract, ());
    let client = AutoShareContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    client.initialize_admin(&admin);

    client.pause(&admin);
    assert!(client.get_paused_status());

    let result = client.try_pause(&admin);
    assert_eq!(
        result,
        Err(Ok(Error::AlreadyPaused)),
        "Second pause call must return AlreadyPaused (error code 12)"
    );
    assert!(
        client.get_paused_status(),
        "State must remain paused after failed re-pause attempt"
    );
}

#[test]
fn test_unpause_already_active_returns_not_paused_error() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(AutoShareContract, ());
    let client = AutoShareContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    client.initialize_admin(&admin);

    assert!(!client.get_paused_status());

    let result = client.try_unpause(&admin);
    assert_eq!(
        result,
        Err(Ok(Error::NotPaused)),
        "Unpause on active contract must return NotPaused (error code 13)"
    );
    assert!(
        !client.get_paused_status(),
        "State must remain active after failed unpause attempt"
    );
}

#[test]
fn test_non_admin_pause_returns_unauthorized_error() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(AutoShareContract, ());
    let client = AutoShareContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let non_admin = Address::generate(&env);
    client.initialize_admin(&admin);

    let result = client.try_pause(&non_admin);
    assert_eq!(
        result,
        Err(Ok(Error::Unauthorized)),
        "Non-admin pause must return Unauthorized (error code 8)"
    );
    assert!(
        !client.get_paused_status(),
        "Contract must remain active after unauthorized pause attempt"
    );
}

#[test]
fn test_non_admin_unpause_returns_unauthorized_error() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(AutoShareContract, ());
    let client = AutoShareContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let non_admin = Address::generate(&env);
    client.initialize_admin(&admin);

    client.pause(&admin);
    assert!(client.get_paused_status());

    let result = client.try_unpause(&non_admin);
    assert_eq!(
        result,
        Err(Ok(Error::Unauthorized)),
        "Non-admin unpause must return Unauthorized (error code 8)"
    );
    assert!(
        client.get_paused_status(),
        "Contract must remain paused after unauthorized unpause attempt"
    );
}

#[test]
fn test_create_returns_contract_paused_error_when_paused() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(AutoShareContract, ());
    let client = AutoShareContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    client.initialize_admin(&admin);

    let token_admin = Address::generate(&env);
    let (token_client, token_admin_client) = create_token_contract(&env, &token_admin);
    let token_address = token_client.address.clone();
    client.add_supported_token(&token_address, &admin);

    client.pause(&admin);
    assert!(client.get_paused_status());

    let creator = Address::generate(&env);
    let id = BytesN::from_array(&env, &[1u8; 32]);
    let name = String::from_str(&env, "Test Group");
    token_admin_client.mint(&creator, &10000000);

    let result = client.try_create(&id, &name, &creator, &100u32, &token_address);
    assert_eq!(
        result,
        Err(Ok(Error::ContractPaused)),
        "create() while paused must return ContractPaused (error code 11)"
    );
}

#[test]
fn test_add_member_returns_contract_paused_error_when_paused() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(AutoShareContract, ());
    let client = AutoShareContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    client.initialize_admin(&admin);

    let token_admin = Address::generate(&env);
    let (token_client, token_admin_client) = create_token_contract(&env, &token_admin);
    let token_address = token_client.address.clone();
    client.add_supported_token(&token_address, &admin);

    let creator = Address::generate(&env);
    let member = Address::generate(&env);
    let id = BytesN::from_array(&env, &[1u8; 32]);
    let name = String::from_str(&env, "Test Group");

    token_admin_client.mint(&creator, &10000000);
    client.create(&id, &name, &creator, &100u32, &token_address);
    client.pause(&admin);

    let result = client.try_add_group_member(&id, &creator, &member, &50u32);
    assert_eq!(
        result,
        Err(Ok(Error::ContractPaused)),
        "add_group_member() while paused must return ContractPaused (error code 11)"
    );
}

#[test]
fn test_topup_subscription_returns_contract_paused_error_when_paused() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(AutoShareContract, ());
    let client = AutoShareContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    client.initialize_admin(&admin);

    let token_admin = Address::generate(&env);
    let (token_client, token_admin_client) = create_token_contract(&env, &token_admin);
    let token_address = token_client.address.clone();
    client.add_supported_token(&token_address, &admin);

    let creator = Address::generate(&env);
    let id = BytesN::from_array(&env, &[1u8; 32]);
    let name = String::from_str(&env, "Test Group");

    token_admin_client.mint(&creator, &10000000);
    client.create(&id, &name, &creator, &100u32, &token_address);

    client.pause(&admin);

    let payer = Address::generate(&env);
    token_admin_client.mint(&payer, &10000000);

    let result = client.try_topup_subscription(&id, &10u32, &token_address, &payer);
    assert_eq!(
        result,
        Err(Ok(Error::ContractPaused)),
        "topup_subscription() while paused must return ContractPaused (error code 11)"
    );
}

#[test]
fn test_update_members_returns_contract_paused_error_when_paused() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(AutoShareContract, ());
    let client = AutoShareContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    client.initialize_admin(&admin);

    let token_admin = Address::generate(&env);
    let (token_client, token_admin_client) = create_token_contract(&env, &token_admin);
    let token_address = token_client.address.clone();
    client.add_supported_token(&token_address, &admin);

    let creator = Address::generate(&env);
    let id = BytesN::from_array(&env, &[1u8; 32]);
    let name = String::from_str(&env, "Test Group");

    token_admin_client.mint(&creator, &10000000);
    client.create(&id, &name, &creator, &100u32, &token_address);
    client.pause(&admin);

    let m1 = Address::generate(&env);
    let members = soroban_sdk::Vec::from_array(
        &env,
        [GroupMember {
            address: m1.clone(),
            percentage: 100,
        }],
    );

    let result = client.try_update_members(&id, &creator, &members);
    assert_eq!(
        result,
        Err(Ok(Error::ContractPaused)),
        "update_members() while paused must return ContractPaused (error code 11)"
    );
}

#[test]
fn test_deactivate_group_returns_contract_paused_error_when_paused() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(AutoShareContract, ());
    let client = AutoShareContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    client.initialize_admin(&admin);

    let token_admin = Address::generate(&env);
    let (token_client, token_admin_client) = create_token_contract(&env, &token_admin);
    let token_address = token_client.address.clone();
    client.add_supported_token(&token_address, &admin);

    let creator = Address::generate(&env);
    let id = BytesN::from_array(&env, &[1u8; 32]);
    let name = String::from_str(&env, "Test Group");

    token_admin_client.mint(&creator, &10000000);
    client.create(&id, &name, &creator, &100u32, &token_address);
    client.pause(&admin);

    let result = client.try_deactivate_group(&id, &creator);
    assert_eq!(
        result,
        Err(Ok(Error::ContractPaused)),
        "deactivate_group() while paused must return ContractPaused (error code 11)"
    );
}

#[test]
fn test_transfer_admin_returns_contract_paused_error_when_paused() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(AutoShareContract, ());
    let client = AutoShareContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    client.initialize_admin(&admin);
    client.pause(&admin);

    let new_admin = Address::generate(&env);
    let result = client.try_transfer_admin(&admin, &new_admin);
    assert_eq!(
        result,
        Err(Ok(Error::ContractPaused)),
        "transfer_admin() while paused must return ContractPaused (error code 11)"
    );
}

#[test]
fn test_read_functions_work_when_paused() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(AutoShareContract, ());
    let client = AutoShareContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    client.initialize_admin(&admin);

    let token_admin = Address::generate(&env);
    let (token_client, token_admin_client) = create_token_contract(&env, &token_admin);
    let token_address = token_client.address.clone();
    client.add_supported_token(&token_address, &admin);

    let creator = Address::generate(&env);
    let id = BytesN::from_array(&env, &[1u8; 32]);
    let name = String::from_str(&env, "Test Group");

    token_admin_client.mint(&creator, &10000000);
    client.create(&id, &name, &creator, &100u32, &token_address);
    client.pause(&admin);

    let _ = client.get(&id);
    let _ = client.get_all_groups();
    let _ = client.get_groups_by_creator(&creator);
    let _ = client.get_group_members(&id);
    let _ = client.is_group_member(&id, &creator);
    let _ = client.get_paused_status();
    let _ = client.get_admin();
    let _ = client.version();
    let _ = client.is_group_active(&id);
    let _ = client.get_registered_categories();
}

#[test]
fn test_get_paused_status_view_works_before_admin_initialization() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(AutoShareContract, ());
    let client = AutoShareContractClient::new(&env, &contract_id);

    let paused = client.get_paused_status();
    assert!(
        !paused,
        "get_paused_status() must return false even before admin init"
    );
}

#[test]
fn test_operations_work_after_unpause() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(AutoShareContract, ());
    let client = AutoShareContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    client.initialize_admin(&admin);

    let token_admin = Address::generate(&env);
    let (token_client, token_admin_client) = create_token_contract(&env, &token_admin);
    let token_address = token_client.address.clone();
    client.add_supported_token(&token_address, &admin);

    client.pause(&admin);
    client.unpause(&admin);

    let creator = Address::generate(&env);
    let id = BytesN::from_array(&env, &[1u8; 32]);
    let name = String::from_str(&env, "Test Group");

    token_admin_client.mint(&creator, &10000000);
    client.create(&id, &name, &creator, &100u32, &token_address);
    let result = client.get(&id);
    assert_eq!(result.name, name);
}

#[test]
fn test_state_preserved_after_unpause_cycle() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(AutoShareContract, ());
    let client = AutoShareContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    client.initialize_admin(&admin);

    let token_admin = Address::generate(&env);
    let (token_client, token_admin_client) = create_token_contract(&env, &token_admin);
    let token_address = token_client.address.clone();
    client.add_supported_token(&token_address, &admin);

    let creator = Address::generate(&env);
    let id = BytesN::from_array(&env, &[1u8; 32]);
    let name = String::from_str(&env, "PreserveMe");

    token_admin_client.mint(&creator, &10000000);
    client.create(&id, &name, &creator, &100u32, &token_address);

    client.pause(&admin);
    client.unpause(&admin);

    let fetched = client.get(&id);
    assert_eq!(fetched.name, name, "Group data must survive pause/unpause cycle");
    assert_eq!(
        fetched.creator, creator,
        "Group creator must survive pause/unpause cycle"
    );
    assert!(
        !client.get_paused_status(),
        "Contract must be active after the cycle"
    );
}
