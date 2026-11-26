//! Tests for safe contract state migration (Issue #1197).
//!
//! Covers:
//! - Storage version defaults to 0 before any migration.
//! - Successful v0 → v1 migration advances the stored version.
//! - Migration guard prevents repeated execution.
//! - Attempting to migrate when already at the target version is rejected.
//! - Non-admin callers cannot trigger a migration.
//! - Unsupported migration paths are rejected.
//! - Existing notification data is preserved (and back-filled) after migration.
//! - `is_migration_executed` returns correct state before and after.

use crate::{AutoShareContract, AutoShareContractClient};
use soroban_sdk::{testutils::Address as _, Address, Env};

fn setup(env: &Env) -> (Address, AutoShareContractClient) {
    let id = env.register(AutoShareContract, ());
    let client = AutoShareContractClient::new(env, &id);
    let admin = Address::generate(env);
    env.mock_all_auths();
    client.initialize_admin(&admin);
    (admin, client)
}

// ── default version ──────────────────────────────────────────────────────────

#[test]
fn test_storage_version_default_is_zero() {
    let env = Env::default();
    let (_admin, client) = setup(&env);
    assert_eq!(client.get_storage_version(), 0);
}

// ── successful migration ──────────────────────────────────────────────────────

#[test]
fn test_run_migration_v0_to_v1_advances_version() {
    let env = Env::default();
    env.mock_all_auths();
    let (admin, client) = setup(&env);

    assert_eq!(client.get_storage_version(), 0);
    client.run_migration(&admin, &1);
    assert_eq!(client.get_storage_version(), 1);
}

#[test]
fn test_run_migration_sets_guard() {
    let env = Env::default();
    env.mock_all_auths();
    let (admin, client) = setup(&env);

    assert!(!client.is_migration_executed(&1));
    client.run_migration(&admin, &1);
    assert!(client.is_migration_executed(&1));
}

// ── idempotency guard ─────────────────────────────────────────────────────────

#[test]
#[should_panic]
fn test_run_migration_rejects_repeated_execution() {
    let env = Env::default();
    env.mock_all_auths();
    let (admin, client) = setup(&env);

    client.run_migration(&admin, &1);
    // Second call must panic with MigrationAlreadyExecuted.
    client.run_migration(&admin, &1);
}

// ── version ordering guard ────────────────────────────────────────────────────

#[test]
#[should_panic]
fn test_run_migration_rejects_target_equal_to_current() {
    let env = Env::default();
    env.mock_all_auths();
    let (admin, client) = setup(&env);

    // StorageVersion is 0; targeting 0 is not higher.
    client.run_migration(&admin, &0);
}

#[test]
#[should_panic]
fn test_run_migration_rejects_target_lower_than_current() {
    let env = Env::default();
    env.mock_all_auths();
    let (admin, client) = setup(&env);

    // Advance to v1 first.
    client.run_migration(&admin, &1);
    // Now try to go back to 0 — must panic.
    client.run_migration(&admin, &0);
}

// ── unsupported migration paths ───────────────────────────────────────────────

#[test]
#[should_panic]
fn test_run_migration_rejects_unsupported_path() {
    let env = Env::default();
    env.mock_all_auths();
    let (admin, client) = setup(&env);

    // There is no defined migration from v0 to v99.
    client.run_migration(&admin, &99);
}

// ── authorization ─────────────────────────────────────────────────────────────

#[test]
#[should_panic]
fn test_run_migration_requires_admin() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, client) = setup(&env);

    let non_admin = Address::generate(&env);
    client.run_migration(&non_admin, &1);
}

// ── data preservation ─────────────────────────────────────────────────────────

#[test]
fn test_run_migration_preserves_existing_state() {
    use crate::base::events::NotificationPriority;
    use soroban_sdk::{BytesN, String};

    let env = Env::default();
    env.mock_all_auths();
    let (admin, client) = setup(&env);

    // Schedule a notification before migration.
    let mut id_bytes = [0u8; 32];
    id_bytes[0] = 42;
    let id = BytesN::from_array(&env, &id_bytes);

    client.schedule_notification(
        &id,
        &admin,
        &3600u64,
        &String::from_str(&env, "Pre-migration notice"),
        &NotificationPriority::Medium,
    );

    let before = client.get_notification(&id);

    // Run migration.
    client.run_migration(&admin, &1);

    // Notification must still be retrievable and unchanged.
    let after = client.get_notification(&id);
    assert_eq!(after.id, before.id);
    assert_eq!(after.title, before.title);
    assert_eq!(after.creator, before.creator);
    assert_eq!(after.created_at, before.created_at);
    assert_eq!(after.expires_at, before.expires_at);
    // Version was already 1 (written post-#309), so back-fill is a no-op.
    assert_eq!(after.version, 1);
}

#[test]
fn test_run_migration_post_migration_notifications_carry_version_one() {
    // After migration completes, notifications scheduled afterwards must still
    // carry version == 1 (the CURRENT_NOTIFICATION_VERSION).
    use crate::base::events::NotificationPriority;
    use soroban_sdk::{BytesN, String};

    let env = Env::default();
    env.mock_all_auths();
    let (admin, client) = setup(&env);

    client.run_migration(&admin, &1);

    let mut id_bytes = [0u8; 32];
    id_bytes[0] = 7;
    let id = BytesN::from_array(&env, &id_bytes);
    client.schedule_notification(
        &id,
        &admin,
        &3600u64,
        &String::from_str(&env, "Post-migration notice"),
        &NotificationPriority::Low,
    );
    let n = client.get_notification(&id);
    assert_eq!(n.version, 1);
}

// ── query helpers ─────────────────────────────────────────────────────────────

#[test]
fn test_is_migration_executed_false_before_migration() {
    let env = Env::default();
    let (_admin, client) = setup(&env);
    assert!(!client.is_migration_executed(&1));
}

#[test]
fn test_is_migration_executed_true_after_migration() {
    let env = Env::default();
    env.mock_all_auths();
    let (admin, client) = setup(&env);
    client.run_migration(&admin, &1);
    assert!(client.is_migration_executed(&1));
}

#[test]
fn test_get_storage_version_after_migration_is_one() {
    let env = Env::default();
    env.mock_all_auths();
    let (admin, client) = setup(&env);
    client.run_migration(&admin, &1);
    assert_eq!(client.get_storage_version(), 1);
}
