//! Explicit authorization for configuration updates (issue #1200).
//!
//! Every configuration mutation below must reject a non-admin caller before
//! touching storage, and failed calls must leave the previous value intact.

use crate::base::events::NotificationCategory;
use crate::test_utils::setup_test_env;
use crate::AutoShareContractClient;
use soroban_sdk::{testutils::Address as _, Address};

#[test]
fn unauthorized_callers_cannot_change_admin_configuration() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let attacker = Address::generate(&test_env.env);
    let token = test_env.mock_tokens.get(0).unwrap().clone();
    let tokens_before = client.get_supported_tokens().len();

    assert!(client.try_set_usage_fee(&99, &attacker).is_err());
    assert_eq!(client.get_usage_fee(), 10);

    assert!(client.try_add_supported_token(&token.clone(), &attacker).is_err());
    assert_eq!(client.get_supported_tokens().len(), tokens_before);

    assert!(client.try_remove_supported_token(&token, &attacker).is_err());
    assert_eq!(client.get_supported_tokens().len(), tokens_before);

    assert!(client
        .try_register_category(&attacker, &NotificationCategory::System)
        .is_err());
    assert!(!client.is_category_registered(&NotificationCategory::System));

    assert!(client.try_set_schema_version(&attacker, &1).is_err());
    assert_eq!(client.get_schema_version(), 0);

    let limits = client.get_notification_limits();
    assert!(client
        .try_configure_notification_limits(
            &attacker,
            &1_000,
            &86_400,
            &60,
            &10,
        )
        .is_err());
    assert_eq!(client.get_notification_limits().max_payload_size, limits.max_payload_size);
}

#[test]
fn authorized_admin_configuration_still_succeeds() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);
    let admin = &test_env.admin;

    client.set_usage_fee(&20, admin);
    assert_eq!(client.get_usage_fee(), 20);

    client.set_schema_version(admin, &1);
    assert_eq!(client.get_schema_version(), 1);

    client.configure_notification_limits(admin, &5_000, &86_400, &60, &50);
    assert_eq!(client.get_notification_limits().max_payload_size, 5_000);
}
