import unittest

from check_contract_event_conventions import (
    extract_contract_events,
    validate_event_definitions,
)


class ContractEventConventionTests(unittest.TestCase):
    def test_valid_event_name_and_four_topics_pass(self):
        source = """
#[contractevent]
pub struct NotificationScheduled {
    #[topic]
    pub creator: Address,
    #[topic]
    pub notification_id: BytesN<32>,
    #[topic]
    pub category: NotificationCategory,
    #[topic]
    pub priority: NotificationPriority,
    pub payload_version: u32,
}
"""
        events = extract_contract_events(source, "fixture.rs")

        self.assertEqual(validate_event_definitions(events), [])

    def test_pascal_case_and_snake_case_are_required(self):
        source = """
#[contractevent]
pub struct notification_scheduled {
    #[topic]
    pub creatorAddress: Address,
}
"""
        errors = validate_event_definitions(extract_contract_events(source, "fixture.rs"))

        self.assertTrue(any("must use PascalCase" in error for error in errors))
        self.assertTrue(any("must use snake_case" in error for error in errors))

    def test_topics_must_precede_data_fields(self):
        source = """
#[contractevent]
pub struct NotificationScheduled {
    pub payload_version: u32,
    #[topic]
    pub creator: Address,
}
"""
        errors = validate_event_definitions(extract_contract_events(source, "fixture.rs"))

        self.assertTrue(any("appears after a data field" in error for error in errors))

    def test_too_many_topics_are_reported(self):
        source = """
#[contractevent]
pub struct TooManyTopics {
    #[topic]
    pub first: Address,
    #[topic]
    pub second: Address,
    #[topic]
    pub third: Address,
    #[topic]
    pub fourth: Address,
    #[topic]
    pub fifth: Address,
}
"""
        errors = validate_event_definitions(extract_contract_events(source, "fixture.rs"))

        self.assertTrue(any("at most 4" in error for error in errors))

    def test_priority_requires_category_as_the_previous_topic(self):
        source = """
#[contractevent]
pub struct PriorityEvent {
    #[topic]
    pub creator: Address,
    #[topic]
    pub priority: NotificationPriority,
}
"""
        errors = validate_event_definitions(extract_contract_events(source, "fixture.rs"))

        self.assertTrue(any("final two topics" in error for error in errors))

    def test_duplicate_event_names_are_reported(self):
        source = """
#[contractevent]
pub struct DuplicateEvent { pub id: u32 }
#[contractevent]
pub struct DuplicateEvent { pub id: u64 }
"""
        errors = validate_event_definitions(extract_contract_events(source, "fixture.rs"))

        self.assertTrue(any("also defined at" in error for error in errors))


if __name__ == "__main__":
    unittest.main()