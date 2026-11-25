# Notification Type Filtering - Design Document

## Overview

The notification type filtering system enables off-chain consumers (indexers, dashboards, webhook handlers) to efficiently subscribe to specific notification categories and priority levels without decoding event payloads. The system attaches standardized metadata—`NotificationCategory` and `NotificationPriority`—to all emitted events as indexed topics, enabling consumers to filter events at the indexing layer.

### Key Design Principles

1. **Metadata-First Filtering**: Categories and priorities are indexed topics, enabling efficient subscription at the blockchain indexer level
2. **Five-Category Taxonomy**: Group, Admin, Financial, Notification, and System provide clear business domain segmentation
3. **Backward Compatibility**: New metadata topics are appended as trailing topics, ensuring existing listeners continue functioning without modification
4. **Consistency Guarantees**: Every event type has exactly one immutable category and priority assignment, enforced at build time
5. **Comprehensive Documentation**: All events are catalogued with their categories, priorities, and business purposes
6. **Consumer Flexibility**: Consumers can migrate to filtering at their own pace during a gradual transition period

---

## Architecture

### Event Metadata Attachment Pattern

```
┌─────────────────────────────────────────────────────────────────┐
│                    Contract Event Emission                      │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Existing Event Structure (backward compatible):                │
│  ┌─────────────────────────────────────────────┐                │
│  │ Topic 0 (Event Signature):                   │                │
│  │   keccak256("NotificationScheduled(u64,...")  │                │
│  ├─────────────────────────────────────────────┤                │
│  │ Topic 1 (Indexed Field 1):                   │                │
│  │   org_id                                      │                │
│  ├─────────────────────────────────────────────┤                │
│  │ Topic 2 (Indexed Field 2):                   │                │
│  │   recipient_id                                │                │
│  ├─────────────────────────────────────────────┤                │
│  │ Data (Non-indexed fields):                   │                │
│  │   [payload, timestamp, ...]                  │                │
│  └─────────────────────────────────────────────┘                │
│                                                                 │
│  Enhanced Event Structure (with metadata):                      │
│  ┌─────────────────────────────────────────────┐                │
│  │ Topic 0 (Event Signature):                   │                │
│  │   keccak256("NotificationScheduled(u64,...") │                │
│  ├─────────────────────────────────────────────┤                │
│  │ Topic 1 (Indexed Field 1):                   │                │
│  │   org_id                                      │                │
│  ├─────────────────────────────────────────────┤                │
│  │ Topic 2 (Indexed Field 2):                   │                │
│  │   recipient_id                                │                │
│  ├─────────────────────────────────────────────┤ ◄── Appended   │
│  │ Topic 3 (NotificationCategory):              │    (new)      │
│  │   Notification                                │                │
│  ├─────────────────────────────────────────────┤ ◄── Appended   │
│  │ Topic 4 (NotificationPriority):              │    (new)      │
│  │   Medium                                      │                │
│  ├─────────────────────────────────────────────┤                │
│  │ Data (Non-indexed fields):                   │                │
│  │   [payload, timestamp, ...]                  │                │
│  └─────────────────────────────────────────────┘                │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘

Key Points:
- Trailing topics enable backward compatibility
- Old listeners reading only first 2-3 topics ignore new metadata
- New listeners can subscribe directly to category/priority filters
- No change to event signature or data fields
```

### Consumer Filtering Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                    Off-Chain Consumer Layer                      │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌────────────────────────────────────────────┐                 │
│  │  Blockchain Node / Indexer                  │                 │
│  │  (emits events with all topics)             │                 │
│  └────────────────────────────────────────────┘                 │
│                           ▼                                      │
│  ┌────────────────────────────────────────────┐                 │
│  │  Event Filter Layer                         │                 │
│  │                                              │                 │
│  │  Subscription Rules:                        │                 │
│  │  - WHERE category = "Admin"                 │                 │
│  │  - WHERE priority IN ("High", "Critical")   │                 │
│  │  - WHERE (category="Financial" OR priority ="Critical")       │
│  └────────────────────────────────────────────┘                 │
│                           ▼                                      │
│  ┌────────────────────────────────────────────┐                 │
│  │  Filtered Event Stream                      │                 │
│  │                                              │                 │
│  │  Only events matching subscription reach    │                 │
│  │  downstream processors                      │                 │
│  └────────────────────────────────────────────┘                 │
│                           ▼                                      │
│  ┌────────────────────────────────────────────┐                 │
│  │  Consumer Application                       │                 │
│  │                                              │                 │
│  │  - Dashboards (only Admin events)           │                 │
│  │  - Alerts (only High/Critical)              │                 │
│  │  - Compliance logging (Financial + Admin)   │                 │
│  │  - Webhooks (category-specific handlers)    │                 │
│  └────────────────────────────────────────────┘                 │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

---

## Components and Interfaces

### 1. NotificationCategory Enumeration

Defines five top-level business domains for event classification:

```rust
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum NotificationCategory {
    /// Group-related lifecycle events (autoshare creation/updates, group activation/deactivation)
    Group = 0,
    
    /// Administrative and governance events (contract pause, transfers, auth failures)
    Admin = 1,
    
    /// Financial transactions and reputation changes (withdrawals, reputation tiers)
    Financial = 2,
    
    /// Notification-specific lifecycle events (scheduling, delivery, acknowledgment)
    Notification = 3,
    
    /// System-level operations (batch processing, audits, schema updates)
    System = 4,
}

impl NotificationCategory {
    /// Convert u8 to category; fails if value > 4
    pub fn from_u8(val: u8) -> Option<Self> { ... }
    
    /// Get human-readable category name
    pub fn as_str(&self) -> &'static str { ... }
    
    /// Get category description for documentation
    pub fn description(&self) -> &'static str { ... }
}
```

### 2. NotificationPriority Enumeration

Defines four priority levels indicating event urgency:

```rust
#[derive(Clone, Copy, PartialEq, Eq, Debug, PartialOrd, Ord)]
pub enum NotificationPriority {
    /// Informational events (most lifecycle events)
    Low = 0,
    
    /// Routine operational events
    Medium = 1,
    
    /// Events requiring prompt review
    High = 2,
    
    /// Security, critical operational, or financial events
    Critical = 3,
}

impl NotificationPriority {
    /// Convert u8 to priority; fails if value > 3
    pub fn from_u8(val: u8) -> Option<Self> { ... }
    
    /// Get human-readable priority name
    pub fn as_str(&self) -> &'static str { ... }
    
    /// Check if priority meets threshold for alerting
    pub fn should_alert(&self, threshold: NotificationPriority) -> bool {
        self >= &threshold
    }
}
```

### 3. EventEmitter Trait Enhancement

Provides standard emission patterns for categorized events:

```rust
/// Standard trait for emitting categorized events
pub trait EventEmitter {
    /// Emit an event with category and priority metadata
    /// 
    /// Implementation automatically appends category and priority as trailing topics
    /// after any pre-existing indexed topics.
    fn emit_categorized_event<T: Soroban Event + Serialize>(
        &self,
        event: T,
        category: NotificationCategory,
        priority: NotificationPriority,
    );
}

/// Macro for ensuring events are emitted with proper metadata
#[macro_export]
macro_rules! emit_notification_event {
    (
        $contract:expr,
        $category:expr,
        $priority:expr,
        $event:expr
    ) => {{
        // Validate metadata before emission
        debug_assert!(
            is_valid_category_for_event(stringify!($event), $category),
            "Event {} cannot have category {}",
            stringify!($event),
            $category.as_str()
        );
        
        // Emit with metadata
        $contract.emit_categorized_event($event, $category, $priority);
    }};
}
```

### 4. Event Structure Reference

All contract events follow this extended structure:

```rust
// Example: NotificationScheduled event
#[event]
pub struct NotificationScheduled {
    #[indexed]
    pub org_id: u64,
    
    #[indexed]
    pub recipient_id: u64,
    
    #[indexed]
    pub notification_id: u128,
    
    // NEW: Category metadata (indexed, trailing topic)
    #[indexed]
    pub category: NotificationCategory,  // = Notification
    
    // NEW: Priority metadata (indexed, trailing topic)
    #[indexed]
    pub priority: NotificationPriority,  // = Medium
    
    // Event-specific data (not indexed)
    pub scheduled_for: u64,
    pub payload_hash: [u8; 32],
    pub version: u32,
}

// In contract code:
EventEmitter::emit_categorized_event(
    event,
    NotificationCategory::Notification,
    NotificationPriority::Medium,
);
```

---

## Event Categorization Model

### Category Taxonomy

#### 1. Group Category
**Purpose**: Events related to group lifecycle and autoshare operations

**Events**:
- `AutoshareCreated` (Priority: Low)
- `AutoshareUpdated` (Priority: Low)
- `GroupDeactivated` (Priority: Low)
- `GroupActivated` (Priority: Low)

**Use Cases**:
- Tracking group lifecycle for reporting
- Monitoring autoshare policy changes
- Group membership auditing

#### 2. Admin Category
**Purpose**: Administrative operations, governance, and authorization events

**Events**:
- `ContractPaused` (Priority: High)
- `ContractUnpaused` (Priority: High)
- `AdminTransferred` (Priority: Critical)
- `AuthorizationFailure` (Priority: Critical)
- `CategoryRegistered` (Priority: Low)
- `ChannelPreferenceUpdated` (Priority: Medium)

**Use Cases**:
- Administrative monitoring dashboards
- Security incident detection
- Governance audit trails
- Authorization failure alerts

#### 3. Financial Category
**Purpose**: Money movement, economic transactions, and reputation tier changes

**Events**:
- `Withdrawal` (Priority: Critical)
- `ReputationUpdated` (Priority: Medium)
- `ReputationTierChanged` (Priority: High)

**Use Cases**:
- Compliance and audit logging
- Financial reconciliation
- Reputation monitoring
- Treasury alerts

#### 4. Notification Category
**Purpose**: Notification-specific lifecycle events from creation through acknowledgment

**Events**:
- `NotificationScheduled` (Priority: Medium)
- `NotificationExpired` (Priority: Medium)
- `ScheduledNotificationCancelled` (Priority: Low)
- `NotificationDelivered` (Priority: Medium)
- `NotificationRecalled` (Priority: Medium)
- `NotificationRevoked` (Priority: High)
- `NotificationExtended` (Priority: Low)
- `NotificationAcknowledged` (Priority: Low)
- `SubscriptionCancelled` (Priority: Medium)
- `NotificationAccessed` (Priority: Low)
- `NotificationArchived` (Priority: Low)

**Use Cases**:
- Notification status tracking
- Delivery monitoring
- User engagement metrics
- Notification analytics

#### 5. System Category
**Purpose**: System-level operations, configuration, and infrastructure events

**Events**:
- `BatchNotificationsCreated` (Priority: Low)
- `BatchProcessingCompleted` (Priority: Low)
- `AuditRecordAppended` (Priority: Low)
- `OwnershipTransferInitiated` (Priority: Critical)
- `OwnershipTransferred` (Priority: Critical)
- `NotificationLimitsConfigured` (Priority: High)
- `SchemaVersionSet` (Priority: High)
- `ChannelMetadataUpdated` (Priority: Medium)
- `TemplateRegistered` (Priority: Low)
- `TemplateUpdated` (Priority: Low)

**Use Cases**:
- System maintenance monitoring
- Configuration auditing
- Ownership transfer tracking
- Schema version management
- Infrastructure event logging

### Priority Level Assignment Reference

**Critical Priority** (Immediate alerting required):
- `AuthorizationFailure` - Security threat
- `AdminTransferred` - Governance change
- `Withdrawal` - Financial movement
- `OwnershipTransferInitiated` - Operational control change
- `OwnershipTransferred` - Operational control change

**High Priority** (Prompt review needed):
- `ContractPaused` - Service availability
- `ContractUnpaused` - Service availability
- `NotificationRevoked` - Notification state critical change
- `ReputationTierChanged` - User status change
- `SchemaVersionSet` - System capability change
- `NotificationLimitsConfigured` - Operational configuration

**Medium Priority** (Routine operational monitoring):
- `NotificationScheduled` - Workflow tracking
- `NotificationExpired` - Workflow tracking
- `NotificationDelivered` - Workflow tracking
- `NotificationRecalled` - Workflow tracking
- `SubscriptionCancelled` - Subscription state
- `ReputationUpdated` - User reputation state
- `NotificationAccessed` - User engagement
- `NotificationArchived` - Storage management
- `ChannelMetadataUpdated` - Configuration change
- `ChannelPreferenceUpdated` - User preference change

**Low Priority** (Informational lifecycle events):
- `AutoshareCreated` - Lifecycle event
- `AutoshareUpdated` - Lifecycle event
- `GroupDeactivated` - Lifecycle event
- `GroupActivated` - Lifecycle event
- `CategoryRegistered` - System configuration
- `ScheduledNotificationCancelled` - Lifecycle event
- `NotificationAcknowledged` - User action
- `BatchNotificationsCreated` - Operational batch
- `BatchProcessingCompleted` - Operational batch
- `AuditRecordAppended` - Audit log
- `TemplateRegistered` - System configuration
- `TemplateUpdated` - System configuration
- `NotificationExtended` - Lifecycle event

---

## Data Models

### Event Metadata Structure

Every event carries immutable metadata at emission time:

```rust
/// Event metadata structure (not stored on-chain, emitted with events)
pub struct EventMetadata {
    /// Classification of event by business domain
    pub category: NotificationCategory,
    
    /// Urgency/importance level of event
    pub priority: NotificationPriority,
    
    /// Version of metadata schema (for evolution)
    pub metadata_version: u32,
    
    /// Timestamp when event was emitted
    pub emitted_at: u64,
}

impl EventMetadata {
    /// Create metadata for a known event type
    pub fn for_event(event_name: &str) -> Result<Self, &'static str> {
        // Returns static metadata for known event names
        // Build fails if new event added without metadata
    }
    
    /// Verify metadata consistency for repeated emissions
    pub fn verify_consistency(&self, previous: &EventMetadata) -> bool {
        // Category and priority must remain constant
        self.category == previous.category &&
        self.priority == previous.priority
    }
}
```

### Off-Chain Consumer Filter Specification

```typescript
// TypeScript/JavaScript representation of filtering capability
interface EventFilter {
    // Filter by one or more categories
    categories?: NotificationCategory[];
    
    // Filter by minimum priority threshold
    minPriority?: NotificationPriority;
    
    // Combine multiple filters with AND/OR logic
    operator?: 'AND' | 'OR';
    
    // Additional payload-based filters (optional)
    payloadFilters?: {
        org_id?: number;
        recipient_id?: number;
        [key: string]: any;
    };
}

// Example filters:
const adminAlerts = {
    categories: ['Admin'],
    minPriority: 'High',
    operator: 'AND'
};

const complianceLogging = {
    categories: ['Financial', 'Admin'],
    minPriority: 'Medium',
    operator: 'OR'
};

const criticalAlerts = {
    minPriority: 'Critical'
};
```

---

## Backward Compatibility Strategy

### Topic Ordering Guarantee

The design maintains backward compatibility through **topic appending**:

1. **Existing Topics** (unchanged):
   - Topic 0: Event signature
   - Topic 1-N: Pre-existing indexed fields (org_id, recipient_id, etc.)

2. **New Topics** (appended):
   - Topic N+1: NotificationCategory (new)
   - Topic N+2: NotificationPriority (new)

3. **Data Fields** (unchanged):
   - All non-indexed event data remains identical

### Compatibility Verification

```rust
#[cfg(test)]
mod backward_compatibility_tests {
    #[test]
    fn test_old_listeners_ignore_extra_topics() {
        // Old code that reads only first 3 topics should work
        let event = parse_event_topics(&raw_event_data, 3);
        assert!(event.is_ok()); // Should not fail on extra topics
    }
    
    #[test]
    fn test_no_payload_changes() {
        // Event data fields must be identical before/after
        let old_format = emit_old_event(&contract);
        let new_format = emit_new_event(&contract);
        assert_eq!(old_format.data, new_format.data);
    }
    
    #[test]
    fn test_topic_order_preserved() {
        // Pre-existing topics maintain their positions
        let event = &parse_event(&raw_data);
        assert_eq!(event.topic(1), expected_org_id);
        assert_eq!(event.topic(2), expected_recipient_id);
        // New topics appear at positions 3-4
    }
}
```

### Migration Timeline

```
Phase 1: Baseline (Week 0)
├─ Document all event metadata assignments
├─ Review existing event structures
└─ Identify gaps in coverage

Phase 2: Implementation (Week 1-2)
├─ Add metadata to all event emissions
├─ Implement build-time verification
├─ Add unit tests for metadata consistency
└─ Update documentation

Phase 3: Validation (Week 2-3)
├─ Run backward compatibility tests
├─ Test with pre-metadata listeners
├─ Verify filtering in integration environment
└─ Update off-chain consumer examples

Phase 4: Rollout (Week 3+)
├─ Deploy with metadata
├─ Monitor for listener compatibility issues
├─ Publish consumer migration guides
└─ Gradually retire support for non-filtering listeners
```

---

## Event Type Mapping Reference

### Complete Event-to-Category-Priority Mapping

| Event Name | Category | Priority | Business Purpose |
|---|---|---|---|
| AutoshareCreated | Group | Low | Group autoshare policy created |
| AutoshareUpdated | Group | Low | Group autoshare policy modified |
| GroupDeactivated | Group | Low | Group lifecycle state change |
| GroupActivated | Group | Low | Group lifecycle state change |
| ContractPaused | Admin | High | Service availability control |
| ContractUnpaused | Admin | High | Service availability control |
| AdminTransferred | Admin | Critical | Governance change |
| AuthorizationFailure | Admin | Critical | Security event |
| CategoryRegistered | Admin | Low | System configuration |
| ChannelPreferenceUpdated | Admin | Medium | User preference change |
| Withdrawal | Financial | Critical | Money movement |
| ReputationUpdated | Financial | Medium | User reputation state |
| ReputationTierChanged | Financial | High | User tier change |
| NotificationScheduled | Notification | Medium | Workflow tracking |
| NotificationExpired | Notification | Medium | Workflow tracking |
| ScheduledNotificationCancelled | Notification | Low | Lifecycle event |
| NotificationDelivered | Notification | Medium | Workflow tracking |
| NotificationRecalled | Notification | Medium | Workflow tracking |
| NotificationRevoked | Notification | High | Notification state change |
| NotificationExtended | Notification | Low | Lifecycle event |
| NotificationAcknowledged | Notification | Low | User action |
| SubscriptionCancelled | Notification | Medium | Subscription state |
| NotificationAccessed | Notification | Low | User engagement |
| NotificationArchived | Notification | Low | Storage management |
| BatchNotificationsCreated | System | Low | Operational batch |
| BatchProcessingCompleted | System | Low | Operational batch |
| AuditRecordAppended | System | Low | Audit trail |
| OwnershipTransferInitiated | System | Critical | Operational control |
| OwnershipTransferred | System | Critical | Operational control |
| NotificationLimitsConfigured | System | High | Operational configuration |
| SchemaVersionSet | System | High | System capability |
| ChannelMetadataUpdated | System | Medium | Configuration change |
| TemplateRegistered | System | Low | System configuration |
| TemplateUpdated | System | Low | System configuration |

---

## Event Emission Patterns

### Standard Emission Pattern

```rust
// Pattern 1: Using the emit_notification_event macro (recommended)
emit_notification_event!(
    contract,
    NotificationCategory::Notification,
    NotificationPriority::Medium,
    NotificationScheduled {
        org_id: 123,
        recipient_id: 456,
        notification_id: 789,
        category: NotificationCategory::Notification,
        priority: NotificationPriority::Medium,
        scheduled_for: now + 3600,
        payload_hash: compute_hash(&payload),
        version: 1,
    }
);

// Pattern 2: Direct event emission with explicit metadata
Event::emit_categorized_event(
    &e,
    NotificationScheduled {
        org_id,
        recipient_id,
        notification_id,
        category: NotificationCategory::Notification,
        priority: NotificationPriority::Medium,
        scheduled_for,
        payload_hash,
        version,
    },
    NotificationCategory::Notification,
    NotificationPriority::Medium,
);
```

### Validation at Emission

```rust
/// Verify that event metadata is consistent with event type
fn validate_event_metadata(
    event_name: &str,
    category: NotificationCategory,
    priority: NotificationPriority,
) -> Result<(), String> {
    let expected = METADATA_REGISTRY.get(event_name)
        .ok_or(format!("Unknown event: {}", event_name))?;
    
    if category != expected.category {
        return Err(format!(
            "Event {} expects category {:?}, got {:?}",
            event_name, expected.category, category
        ));
    }
    
    if priority != expected.priority {
        return Err(format!(
            "Event {} expects priority {:?}, got {:?}",
            event_name, expected.priority, priority
        ));
    }
    
    Ok(())
}
```

### Build-Time Verification

```rust
// In build.rs or compilation phase
fn verify_all_events_have_metadata() -> Result<(), Box<dyn Error>> {
    for event in REGISTERED_EVENTS.iter() {
        if !METADATA_REGISTRY.contains_key(event) {
            return Err(format!(
                "Event '{}' is missing category and priority metadata. \
                 Add metadata to {}",
                event,
                format!("EVENT_METADATA.rs")
            ).into());
        }
    }
    Ok(())
}

// Build will fail with clear error if metadata is missing
```

---

## Off-Chain Filtering Logic

### Consumer-Side Implementation Examples

#### Example 1: Subscription to Admin Alerts

```typescript
// TypeScript - Subscribe to all Admin category events
const adminSubscriber = new EventSubscriber({
    filter: {
        categories: ['Admin'],
        minPriority: 'High'
    }
});

adminSubscriber.on('event', (event) => {
    console.log(`Admin alert: ${event.name} (${event.priority})`);
    // Send to admin dashboard
    adminDashboard.recordEvent(event);
});
```

#### Example 2: Compliance Logging

```python
# Python - Subscribe to Financial and High-Priority Admin events
class ComplianceLogger:
    def __init__(self, indexer):
        self.indexer = indexer
        self.filter = {
            'categories': ['Financial', 'Admin'],
            'minPriority': 'High',
            'operator': 'OR'
        }
    
    def start_listening(self):
        for event in self.indexer.subscribe(self.filter):
            self.log_to_compliance_system(event)
            self.validate_against_regulations(event)
    
    def log_to_compliance_system(self, event):
        # Record financial transactions and admin actions
        compliance_db.insert({
            'event_type': event.name,
            'category': event.category,
            'priority': event.priority,
            'org_id': event.org_id,
            'timestamp': event.emitted_at,
            'data': event.data
        })
```

#### Example 3: Dashboard Filtering

```javascript
// React - Dashboard showing only critical operational events
function CriticalAlertsDashboard() {
    const [events, setEvents] = useState([]);
    
    useEffect(() => {
        const subscription = contractEvents.subscribe({
            filter: {
                minPriority: 'Critical'
            },
            onEvent: (event) => {
                setEvents(prev => [event, ...prev].slice(0, 100));
            }
        });
        
        return () => subscription.unsubscribe();
    }, []);
    
    return (
        <div className="alerts">
            {events.map(e => (
                <Alert
                    key={e.transactionHash}
                    type={e.category}
                    severity={e.priority}
                    message={e.name}
                />
            ))}
        </div>
    );
}
```

#### Example 4: Indexer Subscription

```rust
// Rust - Indexer subscribing by category
struct EventIndexer {
    db: Database,
    filters: Vec<EventFilter>,
}

impl EventIndexer {
    pub fn subscribe_by_category(&mut self, category: NotificationCategory) {
        self.filters.push(EventFilter {
            categories: vec![category],
            minPriority: None,
        });
    }
    
    pub fn process_event(&self, event: &ContractEvent) -> Result<()> {
        // Extract metadata from trailing topics
        let category = NotificationCategory::from_u8(event.topic(3))?;
        let priority = NotificationPriority::from_u8(event.topic(4))?;
        
        // Apply subscription filters
        if self.matches_filters(&category, &priority) {
            self.db.insert_event(event, category, priority)?;
        }
        
        Ok(())
    }
    
    fn matches_filters(&self, category: &NotificationCategory, priority: &NotificationPriority) -> bool {
        self.filters.iter().any(|f| {
            f.categories.contains(category) &&
            f.minPriority.as_ref().map_or(true, |min| priority >= min)
        })
    }
}
```

### Efficient Topic-Based Filtering

The most efficient filtering happens at the blockchain indexer level by filtering on topics:

```solidity
// Pseudo-code: How indexers subscribe by topic
// Most indexing services (The Graph, Alchemy, etc.) support topic filtering

// Subscribe to all Notification category events (topic index 3 = 0x03)
const filter = {
    address: contractAddress,
    topics: [
        null,                    // Match any event signature
        null,                    // Match any org_id
        null,                    // Match any recipient_id
        ethers.id('Notification')  // Topic 3 = category
    ]
};

// Subscribe to only Critical priority events (topic index 4 = 0x03)
const criticalFilter = {
    address: contractAddress,
    topics: [
        null,                    // Any event
        null,                    // Any org_id
        null,                    // Any recipient_id
        null,                    // Any category
        ethers.id('Critical')    // Topic 4 = priority
    ]
};

// Subscribe to Financial OR Critical (multiple event filters with OR)
const financialOrCritical = [
    { ...baseFilter, topics: [..., ethers.id('Financial'), null] },
    { ...baseFilter, topics: [..., null, ethers.id('Critical')] }
];
```

---

## Testing Strategy

### Metadata Consistency Tests

```rust
#[cfg(test)]
mod metadata_tests {
    #[test]
    fn test_all_events_emit_category_and_priority() {
        // Verify every event type emits metadata
        for event_type in &REGISTERED_EVENT_TYPES {
            let result = emit_test_event(event_type);
            assert!(result.category.is_some(), 
                    "Event {} missing category", event_type);
            assert!(result.priority.is_some(), 
                    "Event {} missing priority", event_type);
        }
    }
    
    #[test]
    fn test_category_consistency_across_emissions() {
        // Same event type always has same category
        for event_type in &REGISTERED_EVENT_TYPES {
            let emit1 = emit_test_event(event_type);
            let emit2 = emit_test_event(event_type);
            
            assert_eq!(emit1.category, emit2.category,
                      "Category mismatch for {}", event_type);
        }
    }
    
    #[test]
    fn test_priority_consistency_across_emissions() {
        // Same event type always has same priority
        for event_type in &REGISTERED_EVENT_TYPES {
            let emit1 = emit_test_event(event_type);
            let emit2 = emit_test_event(event_type);
            
            assert_eq!(emit1.priority, emit2.priority,
                      "Priority mismatch for {}", event_type);
        }
    }
}
```

### Backward Compatibility Tests

```rust
#[cfg(test)]
mod compatibility_tests {
    #[test]
    fn test_old_listeners_can_parse_new_events() {
        // Simulate old listener reading only first N topics
        let event = emit_test_event("NotificationScheduled");
        
        // Old code reads 3 topics (signature + 2 indexed fields)
        let old_parse_result = parse_first_n_topics(&event, 3);
        assert!(old_parse_result.is_ok());
        
        // New topics (category, priority) should not break parsing
        assert_eq!(old_parse_result.unwrap().org_id, event.org_id);
    }
    
    #[test]
    fn test_no_changes_to_event_data_fields() {
        // Event data must be identical before/after metadata addition
        let event = emit_test_event("NotificationScheduled");
        
        assert_eq!(event.scheduled_for, EXPECTED_SCHEDULED_FOR);
        assert_eq!(event.payload_hash, EXPECTED_PAYLOAD_HASH);
        assert_eq!(event.version, EXPECTED_VERSION);
    }
    
    #[test]
    fn test_metadata_topics_are_appended_not_inserted() {
        // Category/priority should be at positions 3 and 4
        let event = emit_test_event("NotificationScheduled");
        
        // Pre-existing topics unchanged
        assert_eq!(event.topic(1), event.org_id);
        assert_eq!(event.topic(2), event.recipient_id);
        
        // New topics at end
        assert_eq!(event.topic(3), NotificationCategory::Notification);
        assert_eq!(event.topic(4), NotificationPriority::Medium);
    }
}
```

### Event Coverage Tests

```rust
#[cfg(test)]
mod coverage_tests {
    #[test]
    fn test_all_events_have_metadata_mapping() {
        let unmapped_events: Vec<_> = REGISTERED_EVENT_TYPES
            .iter()
            .filter(|evt| !METADATA_REGISTRY.contains_key(*evt))
            .collect();
        
        assert!(
            unmapped_events.is_empty(),
            "Events missing metadata: {:?}",
            unmapped_events
        );
    }
    
    #[test]
    fn test_metadata_registry_completeness() {
        // All entries in registry must correspond to real events
        for (event_name, metadata) in METADATA_REGISTRY.iter() {
            assert!(
                REGISTERED_EVENT_TYPES.contains(&event_name),
                "Registry contains unknown event: {}",
                event_name
            );
        }
    }
    
    #[test]
    fn test_category_priority_pairings_valid() {
        // Verify priority assignments match category rules
        for (event_name, metadata) in METADATA_REGISTRY.iter() {
            match metadata.category {
                NotificationCategory::System => {
                    // System events that are Critical must be control-related
                    if metadata.priority == NotificationPriority::Critical {
                        assert!(
                            event_name.contains("Ownership") ||
                            event_name.contains("Transfer"),
                            "Critical System event '{}' not control-related",
                            event_name
                        );
                    }
                }
                NotificationCategory::Financial => {
                    // Financial Critical events must be money movement
                    if metadata.priority == NotificationPriority::Critical {
                        assert_eq!(
                            event_name, "Withdrawal",
                            "Critical Financial event must be Withdrawal"
                        );
                    }
                }
                _ => {} // Other categories have flexible priority
            }
        }
    }
}
```

### Property-Based Testing

See the Correctness Properties section for property-based test specifications.

---

## Migration Guide

### For Existing Integrations

#### Step 1: Identify Current Event Listening Code

```typescript
// Before: Current listener without filtering
const listener = web3.eth.subscribe('logs', {
    address: contractAddress
}, (error, event) => {
    if (error) console.log(error);
    else {
        // Process ALL events, regardless of type
        processEvent(event);
    }
});
```

#### Step 2: Add Filtering by Category

```typescript
// After: Listener with category filtering
const listener = web3.eth.subscribe('logs', {
    address: contractAddress,
    topics: [
        null,  // Any event signature
        null,  // Any org_id
        null,  // Any recipient_id
        web3.utils.keccak256(
            web3.eth.abi.encodeParameter('string', 'Notification')
        )  // Filter to Notification category only
    ]
}, (error, event) => {
    if (error) console.log(error);
    else {
        // Now only processing Notification category events
        processNotificationEvent(event);
    }
});
```

#### Step 3: Add Priority Threshold Filtering

```typescript
// Tier 1: Add critical-only alerts
const criticalAlerts = web3.eth.subscribe('logs', {
    address: contractAddress,
    topics: [
        null,  // Any event
        null,  // Any org_id
        null,  // Any recipient_id
        null,  // Any category
        web3.utils.keccak256(
            web3.eth.abi.encodeParameter('uint8', 3)  // Critical = 3
        )  // Filter to Critical priority only
    ]
});

// Tier 2: Combine category + priority filters
const adminHighPriority = web3.eth.subscribe('logs', {
    address: contractAddress,
    topics: [
        null,
        null,
        null,
        web3.utils.keccak256(web3.eth.abi.encodeParameter('string', 'Admin')),
        web3.utils.keccak256(web3.eth.abi.encodeParameter('uint8', 2))  // High or Critical
    ]
});
```

### For New Integrations

#### Integration Checklist

- [ ] Understand the five notification categories
- [ ] Review event-to-category-priority mapping table
- [ ] Define your filtering requirements (which categories/priorities do you need?)
- [ ] Implement topic-based filtering at the indexer level
- [ ] Add tests verifying you receive only expected events
- [ ] Document your filtering logic for maintenance
- [ ] Monitor for unexpected event types (set up alerting)

#### Setup Template

```typescript
import { ContractEventSubscriber } from '@notification-system/sdk';

class MyNotificationConsumer {
    private subscriber: ContractEventSubscriber;
    
    constructor(contractAddress: string) {
        // Define your filtering rules
        this.subscriber = new ContractEventSubscriber(contractAddress, {
            // Example: financial + critical admin events for compliance
            filters: [
                {
                    category: 'Financial',
                    minPriority: 'Medium'
                },
                {
                    category: 'Admin',
                    minPriority: 'Critical'
                }
            ],
            combineMode: 'OR'  // Match ANY filter
        });
    }
    
    async start() {
        this.subscriber.on('event', this.handleEvent.bind(this));
        await this.subscriber.connect();
    }
    
    private handleEvent(event: ContractEvent) {
        // Event is pre-filtered, guaranteed to match our criteria
        console.log(`Received: ${event.name} (${event.category}/${event.priority})`);
        
        // Route to appropriate handler
        switch (event.category) {
            case 'Financial':
                this.handleFinancialEvent(event);
                break;
            case 'Admin':
                this.handleAdminEvent(event);
                break;
        }
    }
}
```

### Deployment Phases

**Phase 1: Preparation** (Week 0)
- Update all event structs with metadata fields
- Add build-time verification
- Deploy with backward-compatible changes

**Phase 2: Documentation & Examples** (Week 0-1)
- Publish consumer migration guide
- Release SDK updates with filtering support
- Provide code examples

**Phase 3: Consumer Migration** (Week 1-4)
- Existing consumers update at own pace
- No forced migration required
- Both filtered and unfiltered listeners continue working

**Phase 4: Optimization** (Week 4+)
- Monitor adoption rates
- Deprecate old listener patterns (with timeline)
- Eventually retire support for non-filtering listeners

---

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system—essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

Before defining correctness properties, I'll analyze each acceptance criterion for testability using the prework tool.
### Acceptance Criteria Testability Analysis

Based on the prework analysis, the following acceptance criteria are testable as properties or examples:

**Key Testable Properties** (Universal properties that hold for all inputs):
- All events must have exactly one category and priority
- Category and priority must be consistent across multiple emissions of the same event
- Metadata topics must be appended as trailing topics (not inserted)
- Event data fields must remain unchanged
- Old listeners reading only first N topics must continue working
- Critical priority only assigned to specific event types

**Testable Examples/Verification**:
- Category/priority assignments for all events
- Metadata registry completeness
- Build-time verification of metadata presence
- Event mapping to categories and priorities

---

### Correctness Properties

#### Property 1: Universal Category Assignment

**For all** events emitted from the contract, each event SHALL carry exactly one NotificationCategory value (never empty, never multiple).

**Validates: Requirements 1.6, 4.1**

**Implementation**: Generate random contract state and trigger various events. Verify that each emitted event has exactly one category value in its metadata.

**Property Test Configuration**:
- Minimum iterations: 100
- Test tag: **Feature: notification-type-filtering, Property 1: Universal category assignment**

---

#### Property 2: Universal Priority Assignment

**For all** events emitted from the contract, each event SHALL carry exactly one NotificationPriority value selected from {Low, Medium, High, Critical}.

**Validates: Requirements 2.2, 5.1**

**Implementation**: Generate random contract state and trigger various events. Verify that each emitted event has exactly one priority value and that the value is within the valid set.

**Property Test Configuration**:
- Minimum iterations: 100
- Test tag: **Feature: notification-type-filtering, Property 2: Universal priority assignment**

---

#### Property 3: Category Consistency Across Emissions

**For all** event types, emitting the same event type multiple times from different code paths SHALL produce identical NotificationCategory values.

**Validates: Requirements 4.2, 4.3, 4.6**

**Implementation**: For each known event type, emit it multiple times from different contract functions/paths and verify that the category remains constant.

**Property Test Configuration**:
- Minimum iterations: 50 (per event type)
- Test tag: **Feature: notification-type-filtering, Property 3: Category consistency**

---

#### Property 4: Priority Consistency Across Emissions

**For all** event types, emitting the same event type multiple times SHALL produce identical NotificationPriority values.

**Validates: Requirements 5.2, 9.4, 9.5**

**Implementation**: For each known event type, emit it multiple times and verify that the priority remains constant.

**Property Test Configuration**:
- Minimum iterations: 50 (per event type)
- Test tag: **Feature: notification-type-filtering, Property 4: Priority consistency**

---

#### Property 5: Metadata as Trailing Topics

**For all** events emitted from the contract, NotificationCategory SHALL be the second-to-last indexed topic and NotificationPriority SHALL be the last indexed topic.

**Validates: Requirements 2.5, 6.1, 6.2, 9.6**

**Implementation**: Parse all emitted events and verify that topics N-1 and N (where N is topic count) contain category and priority respectively.

**Property Test Configuration**:
- Minimum iterations: 100
- Test tag: **Feature: notification-type-filtering, Property 5: Trailing topic position**

---

#### Property 6: Backward Compatibility - Topic Immutability

**For all** pre-existing indexed topics in events, adding metadata topics SHALL NOT change their position, value, or type.

**Validates: Requirements 3.1, 3.2, 3.3, 3.4, 12.1, 12.6**

**Implementation**: Compare event emission before and after metadata addition. Verify that topics 0 through N-3 remain identical.

**Property Test Configuration**:
- Minimum iterations: 100
- Test tag: **Feature: notification-type-filtering, Property 6: Backward compatibility**

---

#### Property 7: Event Data Field Preservation

**For all** events emitted from the contract, the non-indexed event data fields SHALL remain identical before and after metadata addition (no field additions, removals, reordering, or type changes).

**Validates: Requirements 12.1, 12.2, 12.3, 12.4, 12.5**

**Implementation**: Parse event data before and after implementation. Verify all data fields match exactly.

**Property Test Configuration**:
- Minimum iterations: 100
- Test tag: **Feature: notification-type-filtering, Property 7: Data field preservation**

---

#### Property 8: Critical Priority Restriction

**For all** events assigned NotificationPriority.Critical, the event SHALL be one of: {AuthorizationFailure, AdminTransferred, Withdrawal, OwnershipTransferInitiated, OwnershipTransferred}.

**Validates: Requirements 5.4, 11.1**

**Implementation**: Scan metadata registry for all Critical priority events and verify they are in the allowed set.

**Property Test Configuration**:
- Minimum iterations: 1 (deterministic check)
- Test tag: **Feature: notification-type-filtering, Property 8: Critical priority restriction**

---

#### Property 9: Complete Event Coverage

**For all** registered event types in the contract, exactly one NotificationCategory and one NotificationPriority SHALL be assigned in the metadata registry.

**Validates: Requirements 2.6, 9.1, 9.2, 13.1, 13.2**

**Implementation**: Iterate through all registered event types and verify that each has an entry in the metadata registry with category and priority defined.

**Property Test Configuration**:
- Minimum iterations: 1 (deterministic check)
- Test tag: **Feature: notification-type-filtering, Property 9: Complete event coverage**

---

#### Property 10: Event Category Mapping Completeness

**For all** event types in the system, each SHALL appear in exactly one category within the documented category-to-events mapping.

**Validates: Requirements 10.1, 10.2, 10.3, 10.4, 10.5, 15.1, 15.5**

**Implementation**: Parse category mapping and verify that:
1. Each registered event appears in exactly one category list
2. No event appears in multiple categories
3. No unmapped events exist

**Property Test Configuration**:
- Minimum iterations: 1 (deterministic check)
- Test tag: **Feature: notification-type-filtering, Property 10: Category mapping completeness**

---

#### Property 11: Old Listener Compatibility

**For all** events, existing listener code that reads only the first N pre-metadata topics SHALL successfully parse events without errors or data corruption.

**Validates: Requirements 3.1, 3.5, 3.6**

**Implementation**: Simulate old listener parsing logic that reads only first N topics and verify it succeeds for all events.

**Property Test Configuration**:
- Minimum iterations: 100
- Test tag: **Feature: notification-type-filtering, Property 11: Old listener compatibility**

---

#### Property 12: Build-Time Metadata Verification

**For all** newly-added events to the contract codebase, the compilation process SHALL fail with a clear error message if either NotificationCategory or NotificationPriority is missing.

**Validates: Requirements 13.2, 13.4**

**Implementation**: Add test event without metadata and verify build fails. Add event with metadata and verify build succeeds.

**Property Test Configuration**:
- Minimum iterations: 2 (with/without metadata)
- Test tag: **Feature: notification-type-filtering, Property 12: Build-time verification**

---

### Property Reflection and Consolidation

All 12 properties provide unique validation value and do not significantly overlap:

1. Properties 1-2 validate fundamental metadata presence
2. Properties 3-4 validate consistency across emissions
3. Properties 5-7 validate backward compatibility structure
4. Property 8 validates priority assignment rules
5. Properties 9-10 validate complete coverage and mapping
6. Property 11 validates old listener compatibility
7. Property 12 validates build-time enforcement

No consolidation needed; each property tests a distinct aspect of the feature.

---

## Error Handling

### Missing or Invalid Metadata

#### Scenario: Event Emission Without Category

```rust
// Error case: Attempting to emit without category
match emit_event(event, None, priority) {
    Ok(_) => panic!("Should have failed without category"),
    Err(e) => {
        assert_eq!(e.kind(), ErrorKind::MissingMetadata);
        assert!(e.message().contains("category"));
    }
}

// Recovery: Must provide category
let result = emit_event(event, Some(NotificationCategory::Admin), priority);
assert!(result.is_ok());
```

#### Scenario: Invalid Priority Value

```rust
// At parsing time, invalid priority values fail gracefully
let result = NotificationPriority::from_u8(99);
assert!(result.is_none());

// Valid values succeed
assert!(NotificationPriority::from_u8(0).is_some()); // Low
assert!(NotificationPriority::from_u8(3).is_some()); // Critical
```

#### Scenario: Category-Priority Mismatch

```rust
// Build-time check prevents invalid category/priority combinations
// Example: Events like "AuthorizationFailure" must use Critical priority

#[test]
#[should_panic(expected = "AuthorizationFailure requires Critical priority")]
fn test_invalid_priority_for_critical_event() {
    emit_categorized_event(
        AuthorizationFailure { ... },
        NotificationCategory::Admin,
        NotificationPriority::Low,  // Wrong! Should be Critical
    );
}
```

### Handling Edge Cases

#### Ambiguous Categorization

```rust
// When event could fit multiple categories, choose primary
// Example: Withdrawal could be Financial OR Admin
// Decision: Assign to Financial (primary) with code comment

#[event]
pub struct Withdrawal {
    // Category: Financial (primary)
    // Could also be: Admin (due to authorization)
    // Chosen: Financial because primary purpose is money movement
    
    #[indexed]
    pub category: NotificationCategory,  // = Financial
    
    #[indexed]
    pub priority: NotificationPriority,  // = Critical
}
```

#### New Events with Unknown Categories

```rust
// If future event cannot fit existing categories:

// 1. Document the issue:
// /// NEW EVENT: ReputationBurnEvent
// /// Potential categories: Financial (user reputation change),
// ///                       Notification (affects users),
// ///                       System (internal audit)
// /// Decision: Assign to Financial since it affects user economic standing

// 2. Explicitly assign category (forces decision):
emit_categorized_event(
    ReputationBurnEvent { ... },
    NotificationCategory::Financial,
    NotificationPriority::Medium,
);

// 3. If truly cannot fit:
// - Propose new category to stakeholders
// - Document rationale
// - Update taxonomy
// - This is rare and requires deliberation
```

#### Filtering Failures

```rust
// Consumer-side error handling for filter failures

class EventConsumer {
    fn apply_filters(&self, event: &ContractEvent) -> Result<bool> {
        let category = NotificationCategory::from_u8(event.topic(3))
            .ok_or(Error::InvalidCategory)?;
        
        let priority = NotificationPriority::from_u8(event.topic(4))
            .ok_or(Error::InvalidPriority)?;
        
        // Safely check filters
        Ok(self.matches_subscription(&category, &priority))
    }
}
```

---

## Implementation Details

### Code Pattern: Emitting a Categorized Event

```rust
// Step 1: Define the event struct with metadata fields
#[event]
pub struct NotificationScheduled {
    #[indexed]
    pub org_id: u64,
    
    #[indexed]
    pub recipient_id: u64,
    
    #[indexed]
    pub category: NotificationCategory,      // NEW
    
    #[indexed]
    pub priority: NotificationPriority,      // NEW
    
    pub scheduled_for: u64,
    pub payload_hash: [u8; 32],
}

// Step 2: Emit with metadata
pub fn schedule_notification(
    env: &Env,
    org_id: u64,
    recipient_id: u64,
    scheduled_for: u64,
) -> Result<u128> {
    let notification_id = generate_id();
    
    env.events().publish((
        "NotificationScheduled",
        org_id,
        recipient_id,
        NotificationCategory::Notification,
        NotificationPriority::Medium,
    ), (
        scheduled_for,
        compute_payload_hash(&data),
    ));
    
    Ok(notification_id)
}

// Step 3: Consumers read and filter
// Off-chain (TypeScript):
const filter = {
    topics: [
        '0x...',  // NotificationScheduled signature
        null,     // Any org_id
        null,     // Any recipient_id
        web3.utils.keccak256('Notification'),  // Topic 3 = Category
        web3.utils.keccak256('2'),  // Topic 4 = Priority (Medium=2)
    ]
};
```

### Metadata Registry Structure

```rust
// Static registry mapping event names to metadata
lazy_static! {
    pub static ref METADATA_REGISTRY: HashMap<String, EventMetadata> = {
        let mut m = HashMap::new();
        
        m.insert("AutoshareCreated".to_string(), EventMetadata {
            category: NotificationCategory::Group,
            priority: NotificationPriority::Low,
        });
        
        m.insert("AdminTransferred".to_string(), EventMetadata {
            category: NotificationCategory::Admin,
            priority: NotificationPriority::Critical,
        });
        
        m.insert("Withdrawal".to_string(), EventMetadata {
            category: NotificationCategory::Financial,
            priority: NotificationPriority::Critical,
        });
        
        // ... all 33 events
        
        m
    };
}

// Build-time verification function
pub fn verify_all_events_have_metadata() -> Result<(), String> {
    for event_name in &ALL_REGISTERED_EVENTS {
        if !METADATA_REGISTRY.contains_key(*event_name) {
            return Err(format!(
                "Event '{}' missing from metadata registry. \
                 Add entry to METADATA_REGISTRY in metadata.rs",
                event_name
            ));
        }
    }
    Ok(())
}
```

### Macro for Event Emission with Validation

```rust
/// Emit an event with validated metadata
/// 
/// Ensures category and priority are correct for the event type
/// Fails at compile time if metadata is missing
macro_rules! emit_typed_event {
    (
        $env:expr,
        $event_name:expr,
        $org_id:expr,
        $recipient_id:expr,
        $event_data:expr
    ) => {{
        let metadata = METADATA_REGISTRY
            .get($event_name)
            .expect(&format!("Unknown event: {}", $event_name));
        
        $env.events().publish((
            $event_name,
            $org_id,
            $recipient_id,
            metadata.category,
            metadata.priority,
        ), $event_data);
    }};
}
```

---

## Documentation Requirements

### Required Documentation Artifacts

1. **Event Taxonomy Reference**
   - All 33 events listed with category and priority
   - Business purpose for each event
   - Example scenarios

2. **Consumer Integration Guide**
   - How to read metadata from events
   - Topic indices for category/priority
   - Filtering examples (TypeScript, Python, Rust)
   - Performance recommendations

3. **Migration Guide**
   - Step-by-step process for adopting filtering
   - Before/after code examples
   - Backward compatibility guarantees

4. **API Documentation**
   - EventEmitter trait documentation
   - NotificationCategory enum documentation
   - NotificationPriority enum documentation
   - Example implementations

5. **Code Comments**
   - Each event struct includes category/priority in comments
   - Each enum variant includes description
   - Rationale for category assignments documented

---

## Performance Impact Analysis

### Gas Cost Analysis

**Metadata Addition Impact**:
- Adding two indexed topics (category, priority) to each event
- Each indexed topic adds ~375 gas (Ethereum equivalent; Soroban costs may differ)
- Per-event overhead: ~750 gas
- Impact on total contract gas: <1% (events represent <5% of total gas)

**Result**: Negligible performance impact on gas consumption

### Indexing Performance

**Positive Impact**:
- Off-chain consumers can filter at indexer level (O(1) topic matching)
- Eliminates need to decode payloads for filtering (~10-100ms per event)
- Reduces off-chain compute by 80-90% for filtered consumers

**Network Impact**:
- No change to event data size (only indexed topics added)
- Indexed topics don't increase storage (stored in bloom filter)
- Network transmission unchanged

**Result**: Significant improvement for filtered consumers; no degradation for unfiltered

### Storage Implications

- Metadata stored in event topics, not contract storage
- No increase to contract state size
- No additional storage costs

---

## Migration Path Summary

### Phased Rollout

**Week 0**: Event struct updates, build verification
**Week 1**: Unit test implementation, backward compatibility testing
**Week 2**: Integration environment validation
**Week 3+**: Production deployment, consumer migration

### Consumer Adoption Timeline

- **Immediate**: Unfiltered consumers continue unchanged
- **Month 1**: Example implementations published
- **Month 2**: First consumers adopt filtering (reduce load 80-90%)
- **Month 3+**: Gradual migration to filtering; unfiltered deprecated

### Rollback Plan

If critical issue discovered:
1. Deploy with metadata set to default values (no actual filtering)
2. Existing listeners unaffected
3. New listeners gracefully handle missing metadata
4. No breaking changes to on-chain state

---

## Edge Cases and Constraints

### 1. New Event Category Assignment

**Constraint**: WHERE a new event is added to the contract, it SHALL be assigned exactly one category and priority before merge to main branch.

**Implementation**: Build-time check fails if new event lacks metadata in METADATA_REGISTRY.

### 2. Category Reclassification

**Constraint**: WHERE an event's category must change (rare), this SHALL only be done with:
- Explicit documentation of why
- Code comment explaining decision
- Migration notes for off-chain consumers
- Schema version increment

**Rationale**: Changing category breaks filter assumptions for consumers who rely on current assignment

### 3. Priority Volatility

**Constraint**: Priority values are recommended to remain stable but may be adjusted for operational tuning. However, avoid frequent changes to prevent consumer confusion.

**Rationale**: Category is fixed; priority is operational guidance and may evolve

### 4. Sub-Category Filtering

**Constraint**: The system does not support sub-category filtering (e.g., "only AutoshareCreated not AutoshareUpdated"). Consumers needing finer filtering implement off-chain logic.

**Rationale**: Simplicity; category/priority provide sufficient segmentation for 90% of use cases

### 5. Future Extensibility

**Constraint**: If future metadata beyond category/priority is needed, it SHALL be appended as additional trailing topics following the same pattern (not inserted within).

**Design**: Structure supports arbitrary future metadata additions without breaking compatibility

---

## Success Criteria

### Feature Completion Checklist

- [ ] All 33 events have category and priority assigned
- [ ] Metadata registry complete and verified
- [ ] Build-time checks prevent incomplete implementations
- [ ] Unit tests verify metadata consistency (100+ iterations per property)
- [ ] Backward compatibility tests pass (old listeners work unchanged)
- [ ] Documentation complete with consumer examples
- [ ] Migration guide published
- [ ] Performance impact measured and acceptable (<1% gas overhead)
- [ ] Property-based tests pass for all correctness properties
- [ ] Edge cases documented and handled

### Success Metrics

- 100% of events have metadata assigned
- 95%+ test coverage for metadata-related code
- 0 backward compatibility issues reported
- Off-chain filtering reduces target consumers' load by 80-90%
- Documentation examples used by >50% of new integrations
- Zero unhandled edge cases or ambiguous categorizations

---

## Design Review Checklist

- [ ] All 15 requirements addressed in design
- [ ] Backward compatibility strategy is sound
- [ ] Correctness properties are comprehensive and testable
- [ ] Error handling covers all identified edge cases
- [ ] Performance impact is acceptable
- [ ] Documentation is complete and clear
- [ ] Implementation examples are practical and correct
- [ ] Migration path is realistic and low-risk
- [ ] Build-time verification is automatic and failsafe

---

## Appendix: Key Definitions

**NotificationCategory**: Enumerated type with five values representing high-level business domains (Group, Admin, Financial, Notification, System)

**NotificationPriority**: Enumerated type with four values representing event urgency (Low, Medium, High, Critical)

**Indexed Topic**: A searchable field in an emitted event, accessible to off-chain consumers for efficient filtering

**Trailing Topic**: A topic that appears at the end of the event's topic list, preserving existing topics in their original positions

**Metadata**: Category and Priority information attached to events as indexed topics

**Backward Compatibility**: Ability of existing event listeners to continue functioning without modification when new metadata is added

**Off-Chain Consumer**: External system (indexer, webhook, dashboard) that subscribes to and processes contract events
