# Notification Type Filtering Requirements Document

## Introduction

This document specifies requirements for notification type filtering functionality in the Rust-based smart contract notification system. The current notification contract emits events for every action without providing consumers (off-chain listeners, indexers, dashboards) a way to selectively subscribe to specific notification categories. This feature introduces standardized notification type metadata to all emitted events, enabling consumers to filter and process only relevant notification categories while maintaining full backward compatibility with existing event listeners.

The notification contract already defines two primary metadata fields—`NotificationCategory` and `NotificationPriority`—which are emitted as indexed topics on events. This feature formalizes and extends support for these metadata fields across all event types, ensuring consistent categorization and enabling reliable filtering at the point of event emission rather than requiring costly off-chain payload decoding.

## Glossary

- **Event**: A contract-emitted occurrence representing an action or state change, published to the ledger and available to off-chain listeners
- **Notification Type**: A specific category or kind of notification (e.g., Group, Admin, Financial, Notification, System), used to classify events
- **NotificationCategory**: An enumerated type (Group, Admin, Financial, Notification, System) that classifies events into high-level business domains
- **NotificationPriority**: An enumerated type (Low, Medium, High, Critical) that indicates the urgency or importance of an event
- **Event Metadata**: Indexed topics attached to events for efficient off-chain filtering without decoding payloads
- **Off-Chain Consumer**: An external system (listener, indexer, webhook handler, dashboard) that subscribes to and processes contract events
- **Backward Compatibility**: The property that existing event listeners continue to function without modification when new metadata is added to events
- **Indexed Topic**: A searchable field in an event that can be efficiently filtered by off-chain systems at the indexing layer
- **Event Payload**: The data content of an event (distinguished from indexed topics)
- **Event Filtering**: The process by which off-chain consumers select a subset of contract events to process based on metadata criteria
- **Consumers**: External systems that listen to and process contract events (indexers, webhooks, dashboards, oracles)

## Requirements

### Requirement 1: Comprehensive Notification Type Taxonomy

**User Story:** As an off-chain consumer, I want a well-defined, documented taxonomy of notification types, so that I can reliably identify and filter events by their business meaning.

#### Acceptance Criteria

1. THE notification system SHALL define exactly five top-level notification categories: Group, Admin, Financial, Notification, System
2. EACH category SHALL have a clear, documented purpose and list of associated event types
3. THE system SHALL document which existing events belong to each category
4. THE documentation SHALL include: category name, numeric identifier, description, example use cases, list of applicable event types
5. THE Glossary SHALL define each category term with business context
6. WHERE events are emitted, THE system SHALL emit them with exactly one NotificationCategory value (never empty, never multiple)

---

### Requirement 2: Metadata Attachment to All Events

**User Story:** As an off-chain consumer, I want all emitted events to carry notification type metadata, so that I can filter events without decoding payloads.

#### Acceptance Criteria

1. WHEN any event is emitted from the contract, THE event SHALL include NotificationCategory as an indexed topic
2. WHEN any event is emitted from the contract, THE event SHALL include NotificationPriority as an indexed topic
3. WHERE an event currently lacks NotificationCategory, THE system SHALL add it before emission
4. WHERE an event currently lacks NotificationPriority, THE system SHALL add it before emission
5. THE category and priority SHALL be the last (trailing) indexed topics on every event (appended after pre-existing topics)
6. EACH event in the codebase SHALL be verified to emit both category and priority before this feature is considered complete

---

### Requirement 3: Backward Compatibility for Existing Listeners

**User Story:** As an existing consumer, I want my event listener to continue working without modification, so that I can migrate to notification filtering at my own pace.

#### Acceptance Criteria

1. WHEN off-chain listeners decode events using only the first topic (event name), THE events SHALL continue to work unchanged
2. WHEN existing listeners read pre-existing indexed topics and event data, THE events SHALL continue to work unchanged
3. WHERE new metadata topics are added, THE system SHALL append them *after* existing topics (not insert in the middle)
4. THE addition of new metadata topics SHALL NOT change the event name or pre-existing data fields
5. WHERE old versions of listener code read events with new metadata, THE old code SHALL ignore the extra topics without error
6. WHEN a consumer application is updated to read new metadata fields, THE consumer SHALL be able to access them without re-subscribing

---

### Requirement 4: Consistent Category Assignment

**User Story:** As an off-chain consumer, I want the same event type to always have the same category, so that I can reliably filter by event type.

#### Acceptance Criteria

1. EACH event type in the system SHALL be assigned exactly one NotificationCategory
2. THE category assignment for an event type SHALL remain constant across contract versions
3. WHERE an event is emitted multiple times from different code paths, THE category SHALL be the same each time
4. THE system SHALL document the category assignment for every event type in code comments
5. IF an event's category must change, THE change SHALL require explicit documentation and version migration procedures
6. THE verification process SHALL confirm that no event is emitted with inconsistent categories

---

### Requirement 5: Consistent Priority Assignment

**User Story:** As an off-chain alerting system, I want all events to carry consistent priority levels, so that I can page on-call staff based on severity.

#### Acceptance Criteria

1. EACH event type in the system SHALL be assigned exactly one NotificationPriority (Low, Medium, High, or Critical)
2. THE priority assignment for an event type SHALL remain constant across contract versions
3. WHILE an organization defines operational severity rules, THE priority levels SHALL align with those rules
4. THE system SHALL use NotificationPriority.Critical only for: security events, funds movement, admin transfers, authorization failures
5. THE system SHALL use NotificationPriority.High for events requiring prompt operator review
6. THE system SHALL use NotificationPriority.Medium for routine operational events
7. THE system SHALL use NotificationPriority.Low for informational lifecycle events

---

### Requirement 6: Event Type Standardization

**User Story:** As a contract maintainer, I want all events to follow a consistent structure with metadata, so that off-chain systems can process events uniformly.

#### Acceptance Criteria

1. THE Event_Emitter SHALL attach NotificationCategory as the second-to-last indexed topic on every event
2. THE Event_Emitter SHALL attach NotificationPriority as the last indexed topic on every event
3. WHERE events currently omit these fields, THE Event_Emitter SHALL add them
4. THE system SHALL NOT remove or reorder pre-existing topics when adding new metadata
5. ALL events emitted after this feature is complete SHALL include both category and priority
6. THE contract build SHALL fail if any newly-added event lacks category and priority metadata

---

### Requirement 7: Documentation and Reference

**User Story:** As a developer integrating with the contract, I want comprehensive documentation of all notification types and their metadata, so that I can correctly filter and process events.

#### Acceptance Criteria

1. THE system SHALL provide a document listing all events, their categories, and priorities
2. THE document SHALL be maintained in code comments on each event struct
3. EACH event struct comment SHALL include: event name, category, priority, business purpose, example scenarios
4. THE system SHALL provide a machine-readable reference (e.g., enum documentation, code comments) of the event taxonomy
5. WHERE off-chain integrations need event filtering logic, THE documentation SHALL include code examples
6. THE documentation SHALL explain how to subscribe to events by category and priority in off-chain consumers

---

### Requirement 8: Migration Path for Off-Chain Consumers

**User Story:** As an off-chain consumer maintainer, I want clear guidance on how to adopt event filtering, so that I can gradually migrate to category-based subscriptions.

#### Acceptance Criteria

1. THE system documentation SHALL describe how to read NotificationCategory and NotificationPriority from events
2. THE system SHALL provide examples of filtering events by category (e.g., "only listen to Admin category events")
3. THE system SHALL provide examples of filtering events by priority (e.g., "only listen to High and Critical priority events")
4. THE system SHALL provide examples of combined filtering (e.g., "listen to Financial category OR Critical priority")
5. THE documentation SHALL explain that consumers can adopt filtering gradually without breaking changes
6. THE system SHALL document the performance benefits of filtering (reduced off-chain processing, lower indexer load)

---

### Requirement 9: Testing Coverage for Event Metadata

**User Story:** As a test maintainer, I want tests that verify all events emit correct metadata, so that regressions are caught early.

#### Acceptance Criteria

1. THE test suite SHALL include a test that verifies every event type emits NotificationCategory
2. THE test suite SHALL include a test that verifies every event type emits NotificationPriority
3. WHERE a new event is added to the contract, THE test SHALL automatically verify its metadata (or fail if metadata is missing)
4. THE test suite SHALL verify that category values are consistent across multiple emissions of the same event type
5. THE test suite SHALL verify that priority values are consistent across multiple emissions of the same event type
6. THE test suite SHALL verify that metadata topics are appended (not inserted), maintaining backward compatibility
7. THE test suite SHALL verify that existing events continue to emit without changes to their pre-existing topics/data

---

### Requirement 10: Event Category Mapping Reference

**User Story:** As an off-chain system maintainer, I want a comprehensive reference mapping events to categories, so that I can build accurate filtering logic.

#### Acceptance Criteria

1. THE system SHALL document that NotificationCategory::Group includes: AutoshareCreated, AutoshareUpdated, GroupDeactivated, GroupActivated
2. THE system SHALL document that NotificationCategory::Admin includes: ContractPaused, ContractUnpaused, AdminTransferred, AuthorizationFailure, CategoryRegistered, ChannelPreferenceUpdated
3. THE system SHALL document that NotificationCategory::Financial includes: Withdrawal, ReputationUpdated, ReputationTierChanged
4. THE system SHALL document that NotificationCategory::Notification includes: NotificationScheduled, NotificationExpired, ScheduledNotificationCancelled, NotificationDelivered, NotificationRecalled, NotificationRevoked, NotificationExtended, NotificationAcknowledged, SubscriptionCancelled, NotificationAccessed, NotificationArchived
5. THE system SHALL document that NotificationCategory::System includes: BatchNotificationsCreated, BatchProcessingCompleted, AuditRecordAppended, OwnershipTransferInitiated, OwnershipTransferred, NotificationLimitsConfigured, SchemaVersionSet, ChannelMetadataUpdated, TemplateRegistered, TemplateUpdated
6. WHERE new events are added, THE mapping documentation SHALL be updated before the feature is marked complete

---

### Requirement 11: Priority Level Assignment Reference

**User Story:** As an alerting system, I want a reference showing which events are critical vs informational, so that I can route alerts appropriately.

#### Acceptance Criteria

1. THE system SHALL assign NotificationPriority::Critical to: AuthorizationFailure, AdminTransferred, Withdrawal, OwnershipTransferInitiated, OwnershipTransferred
2. THE system SHALL assign NotificationPriority::High to: ContractPaused, ContractUnpaused, NotificationRevoked, ReputationTierChanged, SchemaVersionSet, NotificationLimitsConfigured
3. THE system SHALL assign NotificationPriority::Medium to: NotificationScheduled, NotificationExpired, NotificationDelivered, NotificationRecalled, SubscriptionCancelled, ReputationUpdated, NotificationAccessed, NotificationArchived, ChannelMetadataUpdated
4. THE system SHALL assign NotificationPriority::Low to: AutoshareCreated, AutoshareUpdated, GroupDeactivated, GroupActivated, CategoryRegistered, ChannelPreferenceUpdated, ScheduledNotificationCancelled, NotificationAcknowledged, BatchNotificationsCreated, BatchProcessingCompleted, AuditRecordAppended, TemplateRegistered, TemplateUpdated, NotificationExtended
5. THE documentation SHALL explain the reasoning for each priority assignment
6. WHERE priority assignments are adjusted, THE changes SHALL be documented with migration notes

---

### Requirement 12: No Payload Changes Required

**User Story:** As an existing consumer, I want to upgrade without changing my event payload handling, so that my code continues to work unchanged.

#### Acceptance Criteria

1. THE system SHALL NOT modify any existing event data fields (only add metadata topics)
2. THE system SHALL NOT remove any existing event data fields
3. THE system SHALL NOT change the order of existing data fields in any event
4. THE system SHALL NOT modify the type of any existing data field
5. WHERE a consumer reads event data fields, THE fields SHALL remain identical before and after this feature
6. THE system SHALL only append new indexed topics; pre-existing topics and data shall be unchanged

---

### Requirement 13: Verification That All Events Are Properly Configured

**User Story:** As a quality assurance engineer, I want automated verification that all events carry metadata, so that incomplete implementations are caught before release.

#### Acceptance Criteria

1. THE contract compilation process SHALL include a check that all events emit NotificationCategory
2. IF any newly-added event lacks NotificationCategory, THE build SHALL fail with a clear error message
3. THE contract compilation process SHALL include a check that all events emit NotificationPriority
4. IF any newly-added event lacks NotificationPriority, THE build SHALL fail with a clear error message
5. THE check SHALL be performed automatically without requiring manual intervention
6. THE system SHALL document which events have been verified and their assigned metadata

---

### Requirement 14: Indexer and Dashboard Integration Guidance

**User Story:** As an indexer/dashboard maintainer, I want guidance on consuming the notification type metadata, so that I can build efficient filtering systems.

#### Acceptance Criteria

1. THE system documentation SHALL explain how indexers can subscribe to events by NotificationCategory value
2. THE system documentation SHALL explain how indexers can subscribe to events by NotificationPriority value
3. THE system documentation SHALL provide code examples showing how to filter using Soroban SDK
4. THE system documentation SHALL provide examples of common filtering patterns (e.g., "all Admin events", "all Critical priority events")
5. THE system documentation SHALL explain that filtering at the indexer level (by topic) is more efficient than filtering after payload decoding
6. THE system documentation SHALL include performance recommendations for common filtering scenarios

---

### Requirement 15: Edge Case Handling

**User Story:** As a contract developer, I want clear guidance on edge cases for notification metadata, so that I handle them consistently.

#### Acceptance Criteria

1. WHERE an event has multiple associated domains (e.g., could be Admin OR Financial), THE system SHALL assign it to exactly one primary category in the code
2. WHERE an event's priority is ambiguous, THE system SHALL document the decision rationale in a code comment
3. IF a future event cannot fit into existing categories, THE system documentation SHALL explain how to request a new category
4. WHERE custom filtering rules are needed (beyond simple category/priority), THE system documentation SHALL explain building off-chain filters
5. THE system SHALL handle all existing events before considering this feature complete (no events left uncategorized)

---

## Non-Functional Requirements

### Backward Compatibility
- All existing event listeners SHALL continue to function without modification
- The system SHALL NOT break any existing integrations during this change
- Consumers MAY optionally adopt the new metadata at their own pace without forced migration

### Performance
- Adding metadata topics SHALL NOT increase event emission latency by more than 1%
- Event filtering by category/priority at the indexer level SHALL be efficient (O(1) topic matching)
- The system SHALL NOT require additional contract storage or significant gas overhead

### Documentation Quality
- All notification types and their assignments SHALL be documented in code and external references
- Documentation SHALL be machine-readable and human-readable
- Examples SHALL be provided for common filtering scenarios

### Consistency
- The same event type SHALL always emit the same category and priority
- All events emitted in a given version SHALL follow the same metadata structure
- The mapping of events to categories and priorities SHALL be deterministic and verifiable

## Edge Cases and Constraints

1. **New Events**: WHERE new events are added to the contract, they SHALL be assigned a category and priority before being merged to main. Build failures will enforce this.

2. **Category Ambiguity**: WHERE an event could logically belong to multiple categories, the primary category SHALL be chosen and documented. Only one category per event allowed.

3. **Priority Evolution**: WHERE business needs require changing an event's priority, this SHALL be handled as a documentation update with clear migration guidance (no code change needed).

4. **Filtering Granularity**: The system provides filtering at the category and priority level; sub-category filtering (e.g., "AutoshareCreated but not AutoshareUpdated") requires off-chain logic.

5. **Backward Topic Order**: Existing listeners that depend on specific topic ordering SHALL continue to work because new metadata is appended as trailing topics.

6. **No Event Removal**: This feature SHALL NOT require removing, renaming, or significantly restructuring any existing events.

7. **Consumer Variability**: Different off-chain consumers (indexers, webhooks, dashboards) may adopt filtering at different times; the system SHALL support mixed environments during transition.

## Success Metrics

- All events emit both NotificationCategory and NotificationPriority as indexed topics
- Backward compatibility is verified through integration tests with pre-metadata event schemas
- Documentation is complete with examples of filtering by category and priority
- At least 95% of test coverage for event metadata consistency
- Off-chain consumer integration examples are provided and documented

## Open Questions for Stakeholder Clarification

1. **Additional Categories**: Should custom application-level categories be supported in the future, or is the five-category taxonomy sufficient?

2. **Subcategory Filtering**: Do off-chain consumers need finer-grained filtering (e.g., "only AutoshareCreated, not AutoshareUpdated") or is category-level filtering sufficient?

3. **Dynamic Priority Adjustment**: Should priority levels be configurable per deployment, or should they remain fixed per event type?

4. **Legacy Listener Support**: What is the minimum support window for pre-metadata event listeners? Should documentation include upgrade paths?

5. **Indexer Behavior**: How should indexers handle events from contract versions before this feature was added?

6. **Filtering Standards**: Are there external standards (e.g., EIP or blockchain standards) that should influence the filtering design?

7. **Custom Metadata**: Should applications be able to attach custom metadata beyond category and priority, or should those remain the standard fields?

8. **Version Signaling**: Should the contract emit a version or capability signal so consumers know metadata is available?

