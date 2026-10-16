# Implementation Plan: Notification Type Filtering

## Overview

This implementation plan breaks down the notification type filtering feature into actionable coding tasks. The feature adds metadata to contract events enabling off-chain consumers to filter by notification type (Creation, Delivery, Acknowledgment, Expiration, Pause, Unpause) while maintaining backward compatibility with existing listeners. Implementation includes 20 property-based tests covering all correctness properties, unit tests for each event type, integration tests for end-to-end flows, and a consumer library for event filtering.

## Tasks

- [ ] 1. Define notification type enumeration and core types
  - Create NotificationType enum in `contract/contracts/hello-world/src/base/events.rs` with 6 variants (Creation, Delivery, Acknowledgment, Expiration, Pause, Unpause)
  - Implement `as_str()` method for string representation
  - Implement `from_str()` method for parsing strings to enum values
  - Implement `all()` method returning array of all 6 types
  - Add Serialize/Deserialize trait implementations with PascalCase formatting
  - _Requirements: 1.1, 1.2, 2.1_

- [ ] 2. Extend event structures with metadata
  - Create TypedEvent struct with fields: notification_type, timestamp, data
  - Add TypedEvent::new() constructor
  - Add type_str() method returning notification type as string
  - Implement serialization/deserialization for TypedEvent
  - Ensure existing Event struct fields remain unchanged (id, contractAddress, ledger, type, topic, value, txHash)
  - _Requirements: 2.1, 2.3, 2.4_

  - [ ]* 2.1 Write property test for type enumeration
    - **Property 1: Notification Type Metadata Presence**
    - **Validates: Requirements 1.1, 1.2**
    - Test all 6 enum values exist and are distinct
    - Test as_str() bidirectional conversion

  - [ ]* 2.2 Write property test for single type per event
    - **Property 2: Single Type per Event**
    - **Validates: Requirements 1.4**
    - Test no multi-type events can be created
    - Test exactly one type assigned per TypedEvent instance

- [ ] 3. Implement creation event emission
  - Add `emit_creation_event()` function in `contract/contracts/hello-world/src/autoshare_logic.rs`
  - Emit event when schedule_notification is called
  - Set notificationType = "Creation"
  - Populate timestamp from env.ledger().timestamp()
  - Include notification_id and creator in event data
  - _Requirements: 4.1_

  - [ ]* 3.1 Write property test for creation events
    - **Property 9: Creation Events Correct Type**
    - **Validates: Requirements 4.1**
    - Test all creation events have notificationType = "Creation"
    - Test timestamp is populated

  - [ ]* 3.2 Write unit test for creation event
    - Test schedule_notification emits creation event with correct fields
    - Test event contains notification_id and creator
    - _Requirements: 6.2_

- [ ] 4. Implement delivery event emission
  - Add `emit_delivery_event()` function in autoshare_logic.rs
  - Emit event when confirm_notification_delivery is called
  - Set notificationType = "Delivery"
  - Populate timestamp from env.ledger().timestamp()
  - Include notification_id and recipient in event data
  - _Requirements: 4.2_

  - [ ]* 4.1 Write property test for delivery events
    - **Property 10: Delivery Events Correct Type**
    - **Validates: Requirements 4.2**
    - Test all delivery events have notificationType = "Delivery"
    - Test timestamp is populated

  - [ ]* 4.2 Write unit test for delivery event
    - Test confirm_notification_delivery emits delivery event
    - Test event contains notification_id and recipient
    - _Requirements: 6.3_

- [ ] 5. Implement acknowledgment event emission
  - Add `emit_acknowledgment_event()` function in autoshare_logic.rs
  - Emit event when acknowledge_notifications is called
  - Set notificationType = "Acknowledgment"
  - Populate timestamp from env.ledger().timestamp()
  - Include notification_id and recipient in event data
  - _Requirements: 4.3_

  - [ ]* 5.1 Write property test for acknowledgment events
    - **Property 11: Acknowledgment Events Correct Type**
    - **Validates: Requirements 4.3**
    - Test all acknowledgment events have notificationType = "Acknowledgment"
    - Test timestamp is populated

  - [ ]* 5.2 Write unit test for acknowledgment event
    - Test acknowledge_notifications emits acknowledgment event
    - Test event contains notification_id and recipient
    - _Requirements: 6.4_

- [ ] 6. Implement expiration event emission
  - Add `emit_expiration_event()` function in autoshare_logic.rs
  - Emit event when expire_notification is called
  - Set notificationType = "Expiration"
  - Populate timestamp from env.ledger().timestamp()
  - Include notification_id in event data
  - _Requirements: 4.4_

  - [ ]* 6.1 Write property test for expiration events
    - **Property 12: Expiration Events Correct Type**
    - **Validates: Requirements 4.4**
    - Test all expiration events have notificationType = "Expiration"
    - Test timestamp is populated

  - [ ]* 6.2 Write unit test for expiration event
    - Test expire_notification emits expiration event
    - Test event contains notification_id
    - _Requirements: 6.5_

- [ ] 7. Implement pause and unpause event emission
  - Add `emit_pause_event()` function in autoshare_logic.rs
  - Add `emit_unpause_event()` function in autoshare_logic.rs
  - Emit pause event when pause() is called with notificationType = "Pause"
  - Emit unpause event when unpause() is called with notificationType = "Unpause"
  - Populate timestamp from env.ledger().timestamp()
  - Include admin address in event data
  - _Requirements: 4.5, 4.6_

  - [ ]* 7.1 Write property test for pause events
    - **Property 13: Pause Events Correct Type**
    - **Validates: Requirements 4.5**
    - Test all pause events have notificationType = "Pause"

  - [ ]* 7.2 Write property test for unpause events
    - **Property 14: Unpause Events Correct Type**
    - **Validates: Requirements 4.6**
    - Test all unpause events have notificationType = "Unpause"

  - [ ]* 7.3 Write unit tests for pause/unpause events
    - Test pause() emits pause event with correct type
    - Test unpause() emits unpause event with correct type
    - _Requirements: 6.6, 6.7_

- [ ] 8. Implement type preservation and retrieval
  - Add test infrastructure to retrieve events from contract event log
  - Verify notificationType is preserved when events are queried/replayed
  - Test serialization round-trip (emit → serialize → deserialize → verify type)
  - _Requirements: 1.5_

  - [ ]* 8.1 Write property test for type preservation
    - **Property 3: Type Preservation on Retrieval**
    - **Validates: Requirements 1.5**
    - Test events maintain notificationType after retrieval from storage
    - Test serialization round-trip preserves type

  - [ ]* 8.2 Write property test for schema inclusion
    - **Property 4: Schema Includes Notification Type**
    - **Validates: Requirements 2.1, 2.4**
    - Test EventRegistryEntry includes notificationType field
    - Test deserialization without errors

- [ ] 9. Verify backward compatibility for event structures
  - Create tests that parse new events with old parsing logic
  - Verify all existing fields (id, contractAddress, ledger, type, topic, value, txHash) remain accessible
  - Test that notificationType field is optional during deserialization
  - Ensure no errors occur when old code processes new events
  - _Requirements: 2.3, 3.1, 3.4, 3.5_

  - [ ]* 9.1 Write property test for field preservation
    - **Property 6: Backward Compatibility - Old Field Preservation**
    - **Validates: Requirements 2.3, 3.4**
    - Test all existing fields unchanged in name and type
    - Test fields remain in same position

  - [ ]* 9.2 Write property test for old parser compatibility
    - **Property 7: Backward Compatibility - Old Parser Continues**
    - **Validates: Requirements 3.1, 3.3**
    - Test old listener code functions without modification
    - Test core functionality unaffected by new fields

  - [ ]* 9.3 Write property test for field availability
    - **Property 8: Old Listeners Receive All Fields**
    - **Validates: Requirements 3.2, 3.5**
    - Test old listeners receive new events without errors
    - Test all fields including notificationType present

- [ ] 10. Implement consumer library filtering interface
  - Create `consumer-library/src/event_filter.rs` (or TypeScript equivalent)
  - Define TypedEvent interface matching contract event structure
  - Implement `filterEventsByType(events, types)` function accepting single or multiple types
  - Use Set data structure for O(n) time complexity filtering
  - Add JSDoc/Rust doc comments with time/space complexity
  - _Requirements: 5.1_

  - [ ]* 10.1 Write property test for filter interface
    - **Property 19: Filter Function Interface**
    - **Validates: Requirements 5.1**
    - Test filter accepts event array parameter
    - Test filter accepts single and multiple type parameters

  - [ ]* 10.2 Write property test for filter complexity
    - **Property 20: Filter Time Complexity**
    - **Validates: Requirements 5.6**
    - Test filtering n events completes in O(n) time
    - Benchmark with 1000, 10000, 100000 events

- [ ] 11. Implement single-type filtering
  - In consumer library, implement single type filter logic
  - Filter returns only events where notification_type matches specified type
  - Handle edge case: type not present in events returns empty array
  - _Requirements: 5.2_

  - [ ]* 11.1 Write property test for single-type filtering
    - **Property 15: Filter Single Type Returns Matching Events**
    - **Validates: Requirements 5.2**
    - Test filter with single type returns only matching events
    - Test no non-matching events included

- [ ] 12. Implement multi-type filtering
  - In consumer library, implement multiple type filter logic
  - Filter returns events matching ANY of the specified types (union logic)
  - Handle edge case: partial matches return available types only
  - _Requirements: 5.3, 5.5_

  - [ ]* 12.1 Write property test for multi-type filtering
    - **Property 16: Filter Multiple Types Returns Any Match**
    - **Validates: Requirements 5.3**
    - Test filter with multiple types returns union of matches
    - Test events matching any specified type included

  - [ ]* 12.2 Write property test for partial match filtering
    - **Property 18: Filter Partial Match Returns Available Types**
    - **Validates: Requirements 5.5**
    - Test filtering with types some present and some absent
    - Test only present types returned

- [ ] 13. Implement edge case filtering: empty arrays
  - In consumer library, handle empty event array filtering
  - Filter on empty array returns empty array
  - No errors thrown for empty input
  - _Requirements: 5.4_

  - [ ]* 13.1 Write property test for empty array filtering
    - **Property 17: Filter Empty Array Returns Empty**
    - **Validates: Requirements 5.4**
    - Test filter with empty array returns empty array
    - Test filter with all type variations on empty array

- [ ] 14. Implement convenience filter functions in consumer library
  - Add `EventFilters` object with type-specific convenience methods
  - Implement: creationEvents, deliveryEvents, acknowledgmentEvents, expirationEvents, pauseEvents, unpauseEvents
  - Implement composite filters: lifecycleEvents, stateChangeEvents
  - _Requirements: 5.1_

- [ ] 15. Implement TypedEventListener class in consumer library
  - Create TypedEventListener class with handler registration
  - Add `on(type, handler)` method to register type-specific handlers
  - Add `process(event)` method to route event to appropriate handler
  - Add `processMany(events)` method to batch process events
  - Ensure handlers only called for matching types
  - _Requirements: 5.1_

  - [ ]* 15.1 Write unit tests for TypedEventListener
    - Test handler registration for different types
    - Test correct handler called for matching event type
    - Test batch processing routes all events correctly
    - Test no handler called for non-registered types

- [ ] 16. Comprehensive unit test suite for contract event emissions
  - Create `contract/contracts/hello-world/tests/notification_type_filtering_test.rs`
  - Add test for each notification type: Creation, Delivery, Acknowledgment, Expiration, Pause, Unpause
  - Each test verifies: type field value, timestamp population, required data fields
  - Test invalid type rejection if applicable
  - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7_

- [ ] 17. Comprehensive unit test suite for consumer library filtering
  - Create `consumer-library/tests/event_filter.test.ts` (or equivalent)
  - Test filter function with valid single types
  - Test filter function with valid multiple types
  - Test filter with invalid type strings (error handling)
  - Test filter with null/undefined inputs (error handling)
  - Test filter returns new array (not mutating input)
  - Test filter preserves event order
  - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6_

- [ ] 18. Checkpoint - Verify all unit and property tests pass
  - Run all property-based tests (20 properties total)
  - Run all unit tests for contract event emissions
  - Run all unit tests for consumer library
  - Verify test coverage ≥ 95% for notification type code paths
  - Ensure all tests pass in both contract (Rust) and consumer library (TypeScript)
  - Ask the user if questions arise

- [ ] 19. Integration tests: end-to-end event flow
  - Create integration test that triggers contract actions and captures events
  - Verify creation action emits Creation event with correct type
  - Verify delivery action emits Delivery event with correct type
  - Verify acknowledgment action emits Acknowledgment event with correct type
  - Verify expiration action emits Expiration event with correct type
  - Verify pause action emits Pause event with correct type
  - Verify unpause action emits Unpause event with correct type
  - _Requirements: 6.8_

- [ ] 20. Integration tests: backward compatibility verification
  - Test old event listener code against new events with notificationType
  - Verify old parsing logic continues to work without modification
  - Verify old listeners receive all event fields including new metadata
  - Test that core functionality remains unaffected by new fields
  - Test deserialization with missing notificationType (graceful degradation)
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 6.9_

- [ ] 21. Integration tests: filter with multiple events
  - Create test with 6+ events of different types
  - Apply single-type filter and verify correct subset returned
  - Apply multi-type filter and verify union of types returned
  - Apply filter with no matching types and verify empty result
  - Verify filter does not modify original event array
  - Verify event count and order correct after filtering
  - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6_

- [ ] 22. Integration tests: TypedEventListener routing
  - Create test with multiple event types
  - Register handlers for different notification types
  - Process event batch and verify each handler called correct number of times
  - Verify handlers called in correct order
  - Verify handler receives correct event data
  - _Requirements: 5.1_

- [ ] 23. Final checkpoint - Verify all tests pass and integration complete
  - Run full test suite (property tests + unit tests + integration tests)
  - Verify all 20 correctness properties validated by tests
  - Verify all 6 event types tested (Creation, Delivery, Acknowledgment, Expiration, Pause, Unpause)
  - Verify backward compatibility tests all passing
  - Verify consumer library fully tested and working
  - Ask the user if questions arise

## Notes

- Tasks marked with `*` are optional property-based and unit tests that validate correctness properties but can be skipped for faster MVP
- Each core implementation task (1-7, 10-15) must be completed; test tasks are optional but recommended
- Property tests use property-based testing frameworks: fast-check (JavaScript), QuickCheck equivalent (Rust)
- All 20 correctness properties from the design document are covered by corresponding test tasks
- All 6 notification types are emitted and tested: Creation, Delivery, Acknowledgment, Expiration, Pause, Unpause
- Backward compatibility is explicitly tested in tasks 9, 20
- Consumer library filtering supports single type, multiple types, and edge cases (empty arrays, partial matches)
- Time complexity O(n) is validated by property test in task 10.2
- Integration tests verify end-to-end flows without mocking
