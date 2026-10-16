use crate::base::events::NotificationPriority;
use crate::{AutoShareContract, AutoShareContractClient};
use soroban_sdk::{testutils::Address as _, Address, BytesN, Env, String};

fn setup(env: &Env) -> (Address, AutoShareContractClient) {
    let id = env.register(AutoShareContract, ());
    let client = AutoShareContractClient::new(env, &id);
    let admin = Address::generate(env);
    env.mock_all_auths();
    client.initialize_admin(&admin);
    (admin, client)
}

fn schedule_test_notification(
    client: &AutoShareContractClient,
    env: &Env,
    creator: &Address,
) -> BytesN<32> {
    let mut id_bytes = [0u8; 32];
    id_bytes[0] = 42;
    let notification_id = BytesN::from_array(env, &id_bytes);
    client.schedule_notification(
        &notification_id,
        creator,
        &3600u64,
        &String::from_str(env, "Test"),
        &NotificationPriority::Medium,
    );
    notification_id
}

#[test]
fn test_access_event_emitted_for_existing_notification() {
    let env = Env::default();
    env.mock_all_auths();
    let (admin, client) = setup(&env);
    let notification_id = schedule_test_notification(&client, &env, &admin);
    let accessor = Address::generate(&env);

    // Should not panic — notification exists.
    client.record_notification_access(&notification_id, &accessor);
}

#[test]
#[should_panic]
fn test_access_event_fails_for_nonexistent_notification() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, client) = setup(&env);

    let mut id_bytes = [0u8; 32];
    id_bytes[0] = 99;
    let notification_id = BytesN::from_array(&env, &id_bytes);
    let accessor = Address::generate(&env);

    // Should panic — notification does not exist.
    client.record_notification_access(&notification_id, &accessor);
}

#[test]
fn test_multiple_access_events_can_be_emitted() {
    let env = Env::default();
    env.mock_all_auths();
    let (admin, client) = setup(&env);
    let notification_id = schedule_test_notification(&client, &env, &admin);

    let accessor1 = Address::generate(&env);
    let accessor2 = Address::generate(&env);

    client.record_notification_access(&notification_id, &accessor1);
    client.record_notification_access(&notification_id, &accessor2);
    // Both succeed — audit trail is append-only.
}

#[test]
#[should_panic]
fn test_cross_user_read_access_is_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let (admin, client) = setup(&env);
    let notification_id = schedule_test_notification(&client, &env, &admin);
    let unauthorized = Address::generate(&env);

    // Unauthorized user must not be able to read another user's notification.
    client.get_notification(&notification_id, &unauthorized);
}

#[test]
#[should_panic]
fn test_cross_user_write_access_is_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let (admin, client) = setup(&env);
    let notification_id = schedule_test_notification(&client, &env, &admin);
    let unauthorized = Address::generate(&env);

    // Unauthorized user must not be able to modify another user's notification.
    client.cancel_notification(&notification_id, &unauthorized);
}

#[test]
fn test_resource_ownership_is_validated_for_owner() {
    let env = Env::default();
    env.mock_all_auths();
    let (admin, client) = setup(&env);
    let notification_id = schedule_test_notification(&client, &env, &admin);

    // Owner should be able to read their own notification.
    let notification = client.get_notification(&notification_id, &admin);
    assert_eq!(notification.id, notification_id);
}

#[test]
#[should_panic]
fn test_resource_ownership_is_validated_for_non_owner() {
    let env = Env::default();
    env.mock_all_auths();
    let (admin, client) = setup(&env);
    let notification_id = schedule_test_notification(&client, &env, &admin);
    let non_owner = Address::generate(&env);

    // Non-owner must not be able to read the notification.
    client.get_notification(&notification_id, &non_owner);
}

#[test]
#[should_panic]
fn test_owner_cannot_modify_other_users_notification() {
    let env = Env::default();
    env.mock_all_auths();
    let (admin, client) = setup(&env);
    let notification_id = schedule_test_notification(&client, &env, &admin);

    let other_user = Address::generate(&env);
    let mut other_id_bytes = [0u8; 32];
    other_id_bytes[0] = 77;
    let other_notification_id = BytesN::from_array(&env, &other_id_bytes);
    client.schedule_notification(
        &other_notification_id,
        &other_user,
        &3600u64,
        &String::from_str(&env, "Other"),
        &NotificationPriority::Medium,
    );

    // Admin must not be able to cancel another user's notification.
    client.cancel_notification(&other_notification_id, &admin);
}

#[test]
fn test_owner_can_modify_own_notification() {
    let env = Env::default();
    env.mock_all_auths();
    let (admin, client) = setup(&env);
    let notification_id = schedule_test_notification(&client, &env, &admin);

    // Owner should be able to cancel their own notification.
    client.cancel_notification(&notification_id, &admin);
}

#[test]
#[should_panic]
fn test_cross_user_access_rejected_for_nonexistent_notification() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, client) = setup(&env);

    let mut id_bytes = [0u8; 32];
    id_bytes[0] = 123;
    let notification_id = BytesN::from_array(&env, &id_bytes);
    let unauthorized = Address::generate(&env);

    // Access to a nonexistent notification must be rejected.
    client.get_notification(&notification_id, &unauthorized);
}
