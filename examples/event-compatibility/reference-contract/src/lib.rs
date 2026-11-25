#![no_std]

//! Event Compatibility Reference Contract
//!
//! Demonstrates backward-compatible event schema evolution in Soroban.
//! This contract emits two versions of the same notification event to show
//! how new fields can be added without breaking existing consumers.

use soroban_sdk::{contract, contractimpl, contracttype, symbol_short, Address, BytesN, Env, String, Symbol};

/// Priority level for notifications.
/// Added in v2 as a trailing topic for backward compatibility.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum Priority {
    Low = 0,
    Medium = 1,
    High = 2,
    Critical = 3,
}

/// Version 1 event data payload.
/// Original schema with just a message field.
#[contracttype]
#[derive(Clone, Debug)]
pub struct NotificationDataV1 {
    pub payload_version: u32,
    pub message: String,
}

/// Version 2 event data payload.
/// Extended schema with retry tracking.
#[contracttype]
#[derive(Clone, Debug)]
pub struct NotificationDataV2 {
    pub payload_version: u32,
    pub message: String,
    pub retry_count: u32,
    pub category: String,
}

const EVENT_NAME: Symbol = symbol_short!("NotifCrtd");

#[contract]
pub struct EventCompatibilityContract;

#[contractimpl]
impl EventCompatibilityContract {
    /// Create a notification using the v1 event schema.
    ///
    /// Topics: [event_name, creator, notification_id]
    /// Data: { payload_version: 1, message }
    ///
    /// Existing consumers expect exactly 3 topics. This version preserves that contract.
    pub fn create_notification_v1(
        env: Env,
        creator: Address,
        notification_id: BytesN<32>,
        message: String,
    ) {
        creator.require_auth();

        let data = NotificationDataV1 {
            payload_version: 1,
            message,
        };

        // ✅ Compatible: 3 topics (event name is added automatically as topic[0])
        env.events()
            .publish((EVENT_NAME, creator, notification_id), data);
    }

    /// Create a notification using the v2 event schema.
    ///
    /// Topics: [event_name, creator, notification_id, priority]
    /// Data: { payload_version: 2, message, retry_count, category }
    ///
    /// ✅ Backward compatible because:
    /// - Topics 0-2 remain in the same positions as v1
    /// - Priority is appended as trailing topic[3]
    /// - New data fields are additive (old consumers ignore unknown keys)
    /// - payload_version field lets decoders branch on schema
    pub fn create_notification_v2(
        env: Env,
        creator: Address,
        notification_id: BytesN<32>,
        message: String,
        priority: Priority,
        category: String,
    ) {
        creator.require_auth();

        let data = NotificationDataV2 {
            payload_version: 2,
            message,
            retry_count: 0,
            category,
        };

        // ✅ Compatible: 4 topics, but first 3 match v1 positions
        // Old consumers that only read topics[0..3] continue working
        env.events()
            .publish((EVENT_NAME, creator, notification_id, priority), data);
    }

    /// Demonstrate both versions being emitted in the same transaction.
    ///
    /// This simulates a migration period where:
    /// - The contract has been upgraded to support v2
    /// - Some transactions still use the v1 path (legacy API)
    /// - New transactions use the v2 path
    ///
    /// Listeners must handle both in the same event stream.
    pub fn create_notification_mixed(
        env: Env,
        creator: Address,
        notification_id_v1: BytesN<32>,
        notification_id_v2: BytesN<32>,
        message: String,
    ) {
        creator.require_auth();

        // Emit v1 event
        let data_v1 = NotificationDataV1 {
            payload_version: 1,
            message: message.clone(),
        };
        env.events()
            .publish((EVENT_NAME, creator.clone(), notification_id_v1), data_v1);

        // Emit v2 event with enhanced metadata
        let data_v2 = NotificationDataV2 {
            payload_version: 2,
            message,
            retry_count: 0,
            category: String::from_str(&env, "system"),
        };
        env.events().publish(
            (EVENT_NAME, creator, notification_id_v2, Priority::Medium),
            data_v2,
        );
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{symbol_short, testutils::Events, vec, Env, IntoVal};

    #[test]
    fn test_v1_event_structure() {
        let env = Env::default();
        let contract_id = env.register_contract(None, EventCompatibilityContract);
        let client = EventCompatibilityContractClient::new(&env, &contract_id);

        let creator = Address::generate(&env);
        let notification_id = BytesN::from_array(&env, &[1u8; 32]);
        let message = String::from_str(&env, "Test notification v1");

        client
            .mock_auths(&[soroban_sdk::testutils::MockAuth {
                address: &creator,
                invoke: &soroban_sdk::testutils::MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "create_notification_v1",
                    args: vec![
                        &env,
                        creator.clone().into_val(&env),
                        notification_id.clone().into_val(&env),
                        message.clone().into_val(&env),
                    ],
                    sub_invokes: &[],
                },
            }])
            .create_notification_v1(&creator, &notification_id, &message);

        let events = env.events().all();
        assert_eq!(events.len(), 1);

        let (_contract, event) = events.get(0).unwrap();
        let topics = event.topics();

        // Verify v1 has exactly 3 topics (event name, creator, id)
        assert_eq!(topics.len(), 3);
        assert_eq!(topics.get(0).unwrap(), symbol_short!("NotifCrtd").into_val(&env));
        assert_eq!(topics.get(1).unwrap(), creator.into_val(&env));
        assert_eq!(topics.get(2).unwrap(), notification_id.into_val(&env));
    }

    #[test]
    fn test_v2_event_structure() {
        let env = Env::default();
        let contract_id = env.register_contract(None, EventCompatibilityContract);
        let client = EventCompatibilityContractClient::new(&env, &contract_id);

        let creator = Address::generate(&env);
        let notification_id = BytesN::from_array(&env, &[2u8; 32]);
        let message = String::from_str(&env, "Test notification v2");
        let category = String::from_str(&env, "alert");

        client
            .mock_auths(&[soroban_sdk::testutils::MockAuth {
                address: &creator,
                invoke: &soroban_sdk::testutils::MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "create_notification_v2",
                    args: vec![
                        &env,
                        creator.clone().into_val(&env),
                        notification_id.clone().into_val(&env),
                        message.clone().into_val(&env),
                        Priority::High.into_val(&env),
                        category.into_val(&env),
                    ],
                    sub_invokes: &[],
                },
            }])
            .create_notification_v2(&creator, &notification_id, &message, &Priority::High, &category);

        let events = env.events().all();
        assert_eq!(events.len(), 1);

        let (_contract, event) = events.get(0).unwrap();
        let topics = event.topics();

        // Verify v2 has 4 topics (event name, creator, id, priority)
        assert_eq!(topics.len(), 4);
        assert_eq!(topics.get(0).unwrap(), symbol_short!("NotifCrtd").into_val(&env));
        assert_eq!(topics.get(1).unwrap(), creator.into_val(&env));
        assert_eq!(topics.get(2).unwrap(), notification_id.into_val(&env));
        
        // Topics 0-2 match v1 positions — backward compatible!
        // Topic 3 is new (priority)
        assert_eq!(topics.get(3).unwrap(), Priority::High.into_val(&env));
    }

    #[test]
    fn test_mixed_version_stream() {
        let env = Env::default();
        let contract_id = env.register_contract(None, EventCompatibilityContract);
        let client = EventCompatibilityContractClient::new(&env, &contract_id);

        let creator = Address::generate(&env);
        let id_v1 = BytesN::from_array(&env, &[1u8; 32]);
        let id_v2 = BytesN::from_array(&env, &[2u8; 32]);
        let message = String::from_str(&env, "Mixed version test");

        client
            .mock_auths(&[soroban_sdk::testutils::MockAuth {
                address: &creator,
                invoke: &soroban_sdk::testutils::MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "create_notification_mixed",
                    args: vec![
                        &env,
                        creator.clone().into_val(&env),
                        id_v1.clone().into_val(&env),
                        id_v2.clone().into_val(&env),
                        message.clone().into_val(&env),
                    ],
                    sub_invokes: &[],
                },
            }])
            .create_notification_mixed(&creator, &id_v1, &id_v2, &message);

        let events = env.events().all();
        assert_eq!(events.len(), 2, "Should emit both v1 and v2 events");

        // First event is v1 (3 topics)
        let (_contract1, event1) = events.get(0).unwrap();
        assert_eq!(event1.topics().len(), 3, "v1 event should have 3 topics");

        // Second event is v2 (4 topics)
        let (_contract2, event2) = events.get(1).unwrap();
        assert_eq!(event2.topics().len(), 4, "v2 event should have 4 topics");
    }
}
