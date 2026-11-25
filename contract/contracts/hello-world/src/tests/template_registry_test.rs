/// Template Registry Tests — Issue #352
///
/// Covers:
/// - Successful template registration
/// - Duplicate and invalid registration attempts
/// - Update permission checks (only owner can update)
/// - Retrieval / existence checks for valid vs. invalid template IDs
/// - Event emission for both registration and update
#[cfg(test)]
mod template_registry_tests {
    use crate::base::events::{NotificationCategory, NotificationPriority};
    use crate::base::errors::Error;
    use crate::test_utils::setup_test_env;
    use crate::{AutoShareContract, AutoShareContractClient};
    use soroban_sdk::{
        testutils::{Address as _, Events},
        Address, BytesN, Env, String, Symbol, TryFromVal, Val, Vec,
    };

    // ============================================================================
    // Helpers
    // ============================================================================

    /// Constructs a 32-byte ID from a single seed byte.
    fn make_id(env: &Env, seed: u8) -> BytesN<32> {
        let mut bytes = [0u8; 32];
        bytes[0] = seed;
        BytesN::from_array(env, &bytes)
    }

    /// Returns the topics of the most recently emitted event whose first topic
    /// matches `event_name` (as produced by `#[contractevent]`).
    fn topics_of(env: &Env, event_name: &str) -> Option<Vec<Val>> {
        let target = Symbol::new(env, event_name);
        let mut found: Option<Vec<Val>> = None;
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

    /// Extracts the `NotificationCategory` from the second-to-last topic of the
    /// most recently emitted event named `event_name`.
    fn category_of(env: &Env, event_name: &str) -> Option<NotificationCategory> {
        let topics = topics_of(env, event_name)?;
        let n = topics.len();
        if n < 2 {
            return None;
        }
        NotificationCategory::try_from_val(env, &topics.get(n - 2)?).ok()
    }

    /// Extracts the `NotificationPriority` from the last topic of the most
    /// recently emitted event named `event_name`.
    fn priority_of(env: &Env, event_name: &str) -> Option<NotificationPriority> {
        let topics = topics_of(env, event_name)?;
        NotificationPriority::try_from_val(env, &topics.last()?).ok()
    }

    // ============================================================================
    // register_template — success path
    // ============================================================================

    #[test]
    fn test_register_template_succeeds() {
        let test_env = setup_test_env();
        let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);

        let owner = test_env.users.get(0).unwrap();
        let id = make_id(&test_env.env, 1);
        let name = String::from_str(&test_env.env, "Payment Reminder");
        let content = String::from_str(&test_env.env, "Your payment of {amount} is due.");

        // Should not panic.
        client.register_template(&id, &owner, &name, &content);
    }

    #[test]
    fn test_registered_template_can_be_retrieved() {
        let test_env = setup_test_env();
        let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);

        let owner = test_env.users.get(0).unwrap();
        let id = make_id(&test_env.env, 2);
        let name = String::from_str(&test_env.env, "Welcome");
        let content = String::from_str(&test_env.env, "Welcome, {user}!");

        client.register_template(&id, &owner, &name, &content);

        let tmpl = client.get_template(&id);
        assert_eq!(tmpl.id, id);
        assert_eq!(tmpl.owner, owner);
        assert_eq!(tmpl.name, name);
        assert_eq!(tmpl.content, content);
        assert!(tmpl.updated_at.is_none());
    }

    // ============================================================================
    // template_exists (existence check)
    // ============================================================================

    #[test]
    fn test_template_exists_returns_true_for_registered_id() {
        let test_env = setup_test_env();
        let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);

        let owner = test_env.users.get(0).unwrap();
        let id = make_id(&test_env.env, 3);
        let name = String::from_str(&test_env.env, "Alert");
        let content = String::from_str(&test_env.env, "System alert: {message}");

        client.register_template(&id, &owner, &name, &content);

        assert!(client.template_exists(&id));
    }

    #[test]
    fn test_template_exists_returns_false_for_unknown_id() {
        let test_env = setup_test_env();
        let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);

        let unknown_id = make_id(&test_env.env, 99);
        assert!(!client.template_exists(&unknown_id));
    }

    // ============================================================================
    // get_template — error on missing ID
    // ============================================================================

    #[test]
    #[should_panic]
    fn test_get_template_panics_for_nonexistent_id() {
        let test_env = setup_test_env();
        let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);

        let unknown_id = make_id(&test_env.env, 99);
        // `get_template` calls `.unwrap()` in lib.rs so it panics on Error::TemplateNotFound.
        let _ = client.get_template(&unknown_id);
    }

    // ============================================================================
    // register_template — duplicate registration
    // ============================================================================

    #[test]
    #[should_panic]
    fn test_duplicate_registration_panics() {
        let test_env = setup_test_env();
        let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);

        let owner = test_env.users.get(0).unwrap();
        let id = make_id(&test_env.env, 4);
        let name = String::from_str(&test_env.env, "Original");
        let content = String::from_str(&test_env.env, "Original content.");

        client.register_template(&id, &owner, &name, &content);
        // Second registration with the same ID must panic with AlreadyExists.
        client.register_template(
            &id,
            &owner,
            &String::from_str(&test_env.env, "Duplicate"),
            &String::from_str(&test_env.env, "Duplicate content."),
        );
    }

    // ============================================================================
    // register_template — validation guards
    // ============================================================================

    #[test]
    #[should_panic]
    fn test_register_with_empty_content_panics() {
        let test_env = setup_test_env();
        let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);

        let owner = test_env.users.get(0).unwrap();
        let id = make_id(&test_env.env, 5);
        let name = String::from_str(&test_env.env, "Empty Content");
        let empty = String::from_str(&test_env.env, "");

        client.register_template(&id, &owner, &name, &empty);
    }

    #[test]
    #[should_panic]
    fn test_register_with_name_too_long_panics() {
        let test_env = setup_test_env();
        let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);

        let owner = test_env.users.get(0).unwrap();
        let id = make_id(&test_env.env, 6);
        // 101-character name — exceeds the 100-byte limit.
        let long_name = String::from_str(&test_env.env, &"a".repeat(101));
        let content = String::from_str(&test_env.env, "Some content.");

        client.register_template(&id, &owner, &long_name, &content);
    }

    // ============================================================================
    // update_template — success path
    // ============================================================================

    #[test]
    fn test_owner_can_update_template() {
        let test_env = setup_test_env();
        let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);

        let owner = test_env.users.get(0).unwrap();
        let id = make_id(&test_env.env, 7);
        let name = String::from_str(&test_env.env, "Original Name");
        let content = String::from_str(&test_env.env, "Original content.");

        client.register_template(&id, &owner, &name, &content);

        let new_name = String::from_str(&test_env.env, "Updated Name");
        let new_content = String::from_str(&test_env.env, "Updated content.");
        client.update_template(&id, &owner, &new_name, &new_content);

        let tmpl = client.get_template(&id);
        assert_eq!(tmpl.name, new_name);
        assert_eq!(tmpl.content, new_content);
        assert_eq!(tmpl.owner, owner); // owner unchanged
        assert!(tmpl.updated_at.is_some());
    }

    // ============================================================================
    // update_template — ownership enforcement
    // ============================================================================

    #[test]
    #[should_panic]
    fn test_non_owner_cannot_update_template() {
        // This test must NOT use env.mock_all_auths() for the unauthorized call.
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register(AutoShareContract, ());
        let client = AutoShareContractClient::new(&env, &contract_id);

        // Initialize admin so the contract is usable.
        let admin = Address::generate(&env);
        client.initialize_admin(&admin);

        let owner = Address::generate(&env);
        let attacker = Address::generate(&env);
        let id = make_id(&env, 8);
        let name = String::from_str(&env, "Owned Template");
        let content = String::from_str(&env, "Sensitive content.");

        client.register_template(&id, &owner, &name, &content);

        // Attacker tries to update owner's template — must panic (Unauthorized).
        client.update_template(
            &id,
            &attacker,
            &String::from_str(&env, "Hijacked"),
            &String::from_str(&env, "Hijacked content."),
        );
    }

    // ============================================================================
    // update_template — errors on non-existent template
    // ============================================================================

    #[test]
    #[should_panic]
    fn test_update_nonexistent_template_panics() {
        let test_env = setup_test_env();
        let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);

        let caller = test_env.users.get(0).unwrap();
        let unknown_id = make_id(&test_env.env, 99);

        client.update_template(
            &unknown_id,
            &caller,
            &String::from_str(&test_env.env, "Name"),
            &String::from_str(&test_env.env, "Content."),
        );
    }

    // ============================================================================
    // Event emission — TemplateRegistered
    // ============================================================================

    #[test]
    fn test_register_emits_template_registered_event() {
        let test_env = setup_test_env();
        let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);

        let owner = test_env.users.get(0).unwrap();
        let id = make_id(&test_env.env, 10);
        client.register_template(
            &id,
            &owner,
            &String::from_str(&test_env.env, "Evt Template"),
            &String::from_str(&test_env.env, "Event content."),
        );

        // The event must have been emitted.
        let topics = topics_of(&test_env.env, "template_registered");
        assert!(
            topics.is_some(),
            "TemplateRegistered event was not emitted"
        );

        // Category and priority must match the spec.
        assert_eq!(
            category_of(&test_env.env, "template_registered"),
            Some(NotificationCategory::Notification)
        );
        assert_eq!(
            priority_of(&test_env.env, "template_registered"),
            Some(NotificationPriority::Medium)
        );
    }

    // ============================================================================
    // Event emission — TemplateUpdated
    // ============================================================================

    #[test]
    fn test_update_emits_template_updated_event() {
        let test_env = setup_test_env();
        let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);

        let owner = test_env.users.get(0).unwrap();
        let id = make_id(&test_env.env, 11);
        client.register_template(
            &id,
            &owner,
            &String::from_str(&test_env.env, "Before"),
            &String::from_str(&test_env.env, "Before content."),
        );

        client.update_template(
            &id,
            &owner,
            &String::from_str(&test_env.env, "After"),
            &String::from_str(&test_env.env, "After content."),
        );

        // The update event must have been emitted.
        let topics = topics_of(&test_env.env, "template_updated");
        assert!(topics.is_some(), "TemplateUpdated event was not emitted");

        // Category and priority must match the spec.
        assert_eq!(
            category_of(&test_env.env, "template_updated"),
            Some(NotificationCategory::Notification)
        );
        assert_eq!(
            priority_of(&test_env.env, "template_updated"),
            Some(NotificationPriority::Medium)
        );
    }

    // ============================================================================
    // Multiple templates are independent
    // ============================================================================

    #[test]
    fn test_multiple_templates_are_independent() {
        let test_env = setup_test_env();
        let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);

        let owner1 = test_env.users.get(0).unwrap();
        let owner2 = test_env.users.get(1).unwrap();

        let id1 = make_id(&test_env.env, 20);
        let id2 = make_id(&test_env.env, 21);

        client.register_template(
            &id1,
            &owner1,
            &String::from_str(&test_env.env, "Template 1"),
            &String::from_str(&test_env.env, "Content 1"),
        );
        client.register_template(
            &id2,
            &owner2,
            &String::from_str(&test_env.env, "Template 2"),
            &String::from_str(&test_env.env, "Content 2"),
        );

        let t1 = client.get_template(&id1);
        let t2 = client.get_template(&id2);

        assert_eq!(t1.owner, owner1);
        assert_eq!(t2.owner, owner2);
        assert_ne!(t1.id, t2.id);
    }
}
