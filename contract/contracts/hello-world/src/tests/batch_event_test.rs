use crate::test_utils::setup_test_env;
use crate::AutoShareContractClient;
use crate::base::events::NotificationCategory;
use crate::base::events::NotificationPriority;
use soroban_sdk::testutils::Events;
use soroban_sdk::{BytesN, Symbol, TryFromVal, Val};

#[test]
fn test_emit_batch_processing_completed_event() {
    let test_env = setup_test_env();
    let client = AutoShareContractClient::new(&test_env.env, &test_env.autoshare_contract);

    let mut id_bytes = [0u8; 32];
    id_bytes[0] = 7;
    let batch_id = BytesN::from_array(&test_env.env, &id_bytes);
    let processed = 42u32;

    client.emit_batch_completed(&batch_id, &processed);

    // Ensure the event was emitted with expected topics and data
    let emitted = test_env
        .env
        .events()
        .all()
        .iter()
        .find(|(_addr, topics, _data)| {
            if topics.is_empty() {
                return false;
            }
            let first = topics.get(0).unwrap();
            if let Ok(name) = Symbol::try_from_val(&test_env.env, &first) {
                return name == Symbol::new(&test_env.env, "batch_processing_completed");
            }
            false
        })
        .expect("expected batch_processing_completed event");

    // topics shape: [name, batch_id, category, priority]
    let topics = &emitted.1;
    assert_eq!(topics.len(), 4);

    let topic_batch = BytesN::<32>::try_from_val(&test_env.env, &topics.get(1).unwrap()).unwrap();
    assert_eq!(topic_batch, batch_id);

    let category = NotificationCategory::try_from_val(&test_env.env, &topics.get(2).unwrap()).unwrap();
    assert_eq!(category, NotificationCategory::Notification);

    let priority = NotificationPriority::try_from_val(&test_env.env, &topics.get(3).unwrap()).unwrap();
    assert_eq!(priority, NotificationPriority::Medium);

    // data should contain the processed_count (u32)
    let data = emitted.2;
    let val = u32::try_from_val(&test_env.env, &data).unwrap();
    assert_eq!(val, processed);
}
