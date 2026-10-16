use soroban_sdk::{contractevent, contracttype, Address, BytesN, String, Vec};

/// High-level notification category attached to every emitted event.
///
/// Off-chain consumers (listeners, indexers, dashboards) often only care about a
/// subset of the events the contract emits. Each event carries its category as a
/// trailing, indexed event topic so consumers can subscribe to  or filter out
/// whole categories without having to decode the event payload first.
///
/// # Backward compatibility
///
/// The category is published as the *last* topic of every event, after the event
/// name and any pre-existing topics. Existing listeners that read the event name
/// (the first topic) and the previously defined topics/data are unaffected: the
/// extra trailing topic is simply ignored by consumers that don't look for it.
#[contracttype]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum NotificationCategory {
    /// Lifecycle changes to AutoShare groups: created, updated, activated,
    /// deactivated.
    Group = 0,
    /// Administrative / system actions: pause, unpause, admin transfer.
    Admin = 1,
    /// Movement of funds: withdrawals.
    Financial = 2,
    /// Scheduled notification operations: scheduling, expiry, cancellation.
    Notification = 3,
    /// System testing category
    System = 4,
}

/// Severity level attached to every emitted event alongside its category.
///
/// Off-chain consumers (alerting, dashboards, paging) often route notifications
/// by priority rather than (or in addition to) category. Each event carries its
/// priority as a trailing, indexed event topic so consumers can subscribe to
/// or page on  high-priority notifications without decoding the payload.
///
/// # Backward compatibility
///
/// The priority is published as the *last* topic of every event, after the
/// event name, the previously defined topics, and the category. Existing
/// listeners that only read the event name (the first topic), the prior topics,
/// or the category will continue to work unchanged: the extra trailing topic is
/// simply ignored by consumers that don't look for it.
#[contracttype]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum NotificationPriority {
    /// Informational: routine lifecycle events. No action required.
    Low = 0,
    /// Standard: day-to-day operational events worth tracking.
    Medium = 1,
    /// Elevated: events the operator should review promptly.
    High = 2,
    /// Urgent: security-relevant or funds-moving events that demand
    /// immediate attention (e.g. admin transfer, authorization failure).
    Critical = 3,
}

// ============================================================================
// Group lifecycle events
// ============================================================================

/// Emitted when a new AutoShare group is created.
#[contractevent(data_format = "single-value")]
#[derive(Clone)]
pub struct AutoshareCreated {
    #[topic]
    pub creator: Address,
    #[topic]
    pub category: NotificationCategory,
    #[topic]
    pub priority: NotificationPriority,
    pub id: BytesN<32>,
}

/// Emitted when an AutoShare group's member list is updated.
#[contractevent(data_format = "single-value")]
#[derive(Clone)]
pub struct AutoshareUpdated {
    #[topic]
    pub updater: Address,
    #[topic]
    pub category: NotificationCategory,
    #[topic]
    pub priority: NotificationPriority,
    pub id: BytesN<32>,
}

/// Emitted when an AutoShare group is deactivated by its creator.
#[contractevent(data_format = "single-value")]
#[derive(Clone)]
pub struct GroupDeactivated {
    #[topic]
    pub creator: Address,
    #[topic]
    pub category: NotificationCategory,
    #[topic]
    pub priority: NotificationPriority,
    pub id: BytesN<32>,
}

/// Emitted when a deactivated AutoShare group is reactivated by its creator.
#[contractevent(data_format = "single-value")]
#[derive(Clone)]
pub struct GroupActivated {
    #[topic]
    pub creator: Address,
    #[topic]
    pub category: NotificationCategory,
    #[topic]
    pub priority: NotificationPriority,
    pub id: BytesN<32>,
}

// ============================================================================
// Admin / system events
// ============================================================================

/// Emitted when a notification category is registered on-chain.
#[contractevent]
#[derive(Clone)]
pub struct CategoryRegistered {
    #[topic]
    pub admin: Address,
    #[topic]
    pub category: NotificationCategory,
    #[topic]
    pub priority: NotificationPriority,
}

/// Emitted when the contract is paused by the admin.
#[contractevent]
/// Emitted when a recipient updates a delivery channel preference.
///
/// Off-chain consumers can filter on `recipient` and inspect `channel` /
/// `enabled` in the event data to react to channel configuration changes
/// without decoding full preference storage.
#[contractevent]
#[derive(Clone)]
pub struct ChannelPreferenceUpdated {
    #[topic]
    pub recipient: Address,
    #[topic]
    pub category: NotificationCategory,
    #[topic]
    pub priority: NotificationPriority,
    /// Delivery channel that changed (0 = Wallet, 1 = Email, 2 = InApp).
    pub channel: u32,
    /// Whether the channel is now enabled.
    pub enabled: bool,
    /// Ledger timestamp when the preference was updated.
    pub updated_at: u64,
}

/// Emitted when an AutoShare group is deactivated by its creator.
#[contractevent(data_format = "single-value")]
#[derive(Clone)]
pub struct ContractPaused {
    #[topic]
    pub admin: Address,
    #[topic]
    pub category: NotificationCategory,
    #[topic]
    pub priority: NotificationPriority,
}

/// Emitted when the contract is unpaused by the admin.
#[contractevent]
#[derive(Clone)]
pub struct ContractUnpaused {
    #[topic]
    pub admin: Address,
    #[topic]
    pub category: NotificationCategory,
    #[topic]
    pub priority: NotificationPriority,
}

/// Emitted when the admin rights of the contract are transferred.
#[contractevent(data_format = "single-value")]
#[derive(Clone)]
pub struct AdminTransferred {
    #[topic]
    pub old_admin: Address,
    #[topic]
    pub category: NotificationCategory,
    #[topic]
    pub priority: NotificationPriority,
    pub new_admin: Address,
}

/// Emitted when an authorization failure is detected by the contract.
#[contractevent(data_format = "single-value")]
#[derive(Clone)]
pub struct AuthorizationFailure {
    #[topic]
    pub caller: Address,
    #[topic]
    pub category: NotificationCategory,
    #[topic]
    pub priority: NotificationPriority,
    pub action: String,
}

// ============================================================================
// Financial events
// ============================================================================

/// Emitted when the admin withdraws collected usage fees from the contract.
#[contractevent(data_format = "single-value")]
#[derive(Clone)]
pub struct Withdrawal {
    #[topic]
    pub token: Address,
    #[topic]
    pub recipient: Address,
    #[topic]
    pub category: NotificationCategory,
    #[topic]
    pub priority: NotificationPriority,
    pub amount: i128,
}

// ============================================================================
// Notification lifecycle events
// ============================================================================

/// Emitted when a notification is scheduled on-chain with a bounded lifetime.
///
/// `payload_version` carries the protocol version of the stored
/// [`ScheduledNotification`] payload so off-chain consumers can identify
/// the schema without fetching the full storage record.  Version 1 is the
/// initial versioned payload format.  Consumers that do not recognise the
/// version should skip processing and log an unsupported-version warning.
#[contractevent]
#[derive(Clone)]
pub struct NotificationScheduled {
    #[topic]
    pub creator: Address,
    #[topic]
    pub category: NotificationCategory,
    #[topic]
    pub priority: NotificationPriority,
    pub notification_id: BytesN<32>,
    /// Protocol version of the stored notification payload.
    /// Matches [`CURRENT_NOTIFICATION_VERSION`] at the time of scheduling.
    pub payload_version: u32,
}

/// Emitted when a scheduled notification's lifetime elapses and it is expired.
#[contractevent(data_format = "single-value")]
#[derive(Clone)]
pub struct NotificationExpired {
    #[topic]
    pub notification_id: BytesN<32>,
    #[topic]
    pub category: NotificationCategory,
    #[topic]
    pub priority: NotificationPriority,
    pub expires_at: u64,
}

/// Emitted when a scheduled notification is cancelled.
#[contractevent(data_format = "single-value")]
#[derive(Clone)]
pub struct ScheduledNotificationCancelled {
    #[topic]
    pub caller: Address,
    #[topic]
    pub category: NotificationCategory,
    #[topic]
    pub priority: NotificationPriority,
    pub notification_id: BytesN<32>,
}

/// Emitted when a notification is confirmed as delivered to its intended recipient.
#[contractevent(data_format = "single-value")]
#[derive(Clone)]
pub struct NotificationDelivered {
    #[topic]
    pub notification_id: BytesN<32>,
    #[topic]
    pub delivered_by: Address,
    #[topic]
    pub category: NotificationCategory,
    #[topic]
    pub priority: NotificationPriority,
    pub delivered_at: u64,
}

/// Emitted when a sender recalls a scheduled notification before delivery confirmation.
#[contractevent(data_format = "single-value")]
#[derive(Clone)]
pub struct NotificationRecalled {
    #[topic]
    pub notification_id: BytesN<32>,
    #[topic]
    pub recalled_by: Address,
    #[topic]
    pub category: NotificationCategory,
    #[topic]
    pub priority: NotificationPriority,
    pub recalled_at: u64,
}

/// Emitted when a scheduled notification is revoked by an authorized sender.
#[contractevent(data_format = "single-value")]
#[derive(Clone)]
pub struct NotificationRevoked {
    #[topic]
    pub notification_id: BytesN<32>,
    #[topic]
    pub revoked_by: Address,
    #[topic]
    pub category: NotificationCategory,
    #[topic]
    pub priority: NotificationPriority,
    // GAS: Removed `revoked_at` — derivable from ledger metadata
}

/// Emitted when a scheduled notification's expiry period is extended by an authorized sender.
#[contractevent(data_format = "single-value")]
#[derive(Clone)]
pub struct NotificationExtended {
    #[topic]
    pub notification_id: BytesN<32>,
    #[topic]
    pub caller: Address,
    #[topic]
    pub category: NotificationCategory,
    #[topic]
    pub priority: NotificationPriority,
    pub new_expires_at: u64,
}

/// Emitted when a notification is acknowledged by an authorized user.
#[contractevent(data_format = "single-value")]
#[derive(Clone)]
pub struct NotificationAcknowledged {
    #[topic]
    pub notification_id: BytesN<32>,
    #[topic]
    pub acknowledger: Address,
    #[topic]
    pub category: NotificationCategory,
    #[topic]
    pub priority: NotificationPriority,
    pub timestamp: u64,
}

/// Emitted when a subscriber cancels an active notification subscription.
#[contractevent(data_format = "single-value")]
#[derive(Clone)]
pub struct SubscriptionCancelled {
    #[topic]
    pub group_id: BytesN<32>,
    #[topic]
    pub subscriber: Address,
    #[topic]
    pub category: NotificationCategory,
    #[topic]
    pub priority: NotificationPriority,
    pub cancelled_at: u64,
}

// ============================================================================
// Batch events
// ============================================================================

/// Emitted when a batch of notifications is created in a single transaction.
#[contractevent]
#[derive(Clone)]
pub struct BatchNotificationsCreated {
    #[topic]
    pub creator: Address,
    #[topic]
    pub category: NotificationCategory,
    #[topic]
    pub priority: NotificationPriority,
    pub count: u32,
    pub ids: Vec<BytesN<32>>,
}

/// Emitted when an off-chain batch of notifications finishes processing.
#[contractevent(data_format = "single-value")]
#[derive(Clone)]
pub struct BatchProcessingCompleted {
    #[topic]
    pub batch_id: BytesN<32>,
    #[topic]
    pub category: NotificationCategory,
    #[topic]
    pub priority: NotificationPriority,
    pub processed_count: u32,
}

// ============================================================================
// Audit Logging
// ============================================================================

/// Discriminator for each stage in the notification lifecycle that the audit
/// log tracks.  Values are fixed-width integers so they serialise compactly on
/// chain and can be matched exactly by off-chain indexers.
#[contracttype]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum AuditAction {
    /// A notification was created (scheduled on-chain).
    Created = 0,
    /// A delivery attempt was made for a notification.
    DeliveryAttempt = 1,
    /// A delivery attempt failed.
    DeliveryFailed = 2,
    /// The recipient acknowledged the notification.
    Acknowledged = 3,
    /// The notification was cancelled before expiry.
    Cancelled = 4,
    /// The notification expired naturally.
    Expired = 5,
}

/// Emitted when a new audit record is appended to the on-chain log.
#[contractevent]
#[derive(Clone)]
pub struct AuditRecordAppended {
    #[topic]
    pub notification_id: BytesN<32>,
    #[topic]
    pub action: AuditAction,
    #[topic]
    pub category: NotificationCategory,
    pub seq: u64,
    pub actor: Address,
    // GAS: Removed `timestamp` — derivable from ledger metadata
}

// ============================================================================
// Ownership transfer events
// ============================================================================

/// Emitted when the current owner initiates a two-step ownership transfer.
#[contractevent(data_format = "single-value")]
#[derive(Clone)]
pub struct OwnershipTransferInitiated {
    #[topic]
    pub previous_owner: Address,
    #[topic]
    pub category: NotificationCategory,
    #[topic]
    pub priority: NotificationPriority,
    pub pending_owner: Address,
}

/// Emitted when a two-step ownership transfer is completed.
#[contractevent(data_format = "single-value")]
#[derive(Clone)]
pub struct OwnershipTransferred {
    #[topic]
    pub previous_owner: Address,
    #[topic]
    pub category: NotificationCategory,
    #[topic]
    pub priority: NotificationPriority,
    pub new_owner: Address,
}

// ============================================================================
// Notification Limits Configuration
// ============================================================================
/// Emitted when a sender's reputation score is updated.
/// Triggered by successful or failed notification delivery.
#[contractevent]
#[derive(Clone)]
pub struct ReputationUpdated {
    #[topic]
    pub sender: Address,
    #[topic]
    pub category: NotificationCategory,
    #[topic]
    pub priority: NotificationPriority,
    pub new_score: i64,
    pub successful_count: u32,
    pub failed_count: u32,
}

/// Emitted when protocol-level notification limits are configured or updated.
#[contractevent]
#[derive(Clone)]
pub struct NotificationLimitsConfigured {
    #[topic]
    pub admin: Address,
    #[topic]
    pub category: NotificationCategory,
    #[topic]
    pub priority: NotificationPriority,
    pub max_payload_size: u32,
    pub max_expiration_seconds: u64,
    pub min_expiration_seconds: u64,
    pub max_batch_size: u32,
}

/// Emitted when a sender's reputation tier changes (e.g., from Bronze to Silver).
#[contractevent]
#[derive(Clone)]
pub struct ReputationTierChanged {
    #[topic]
    pub sender: Address,
    #[topic]
    pub category: NotificationCategory,
    #[topic]
    pub priority: NotificationPriority,
    pub old_tier: u32,
    pub new_tier: u32,
    pub reputation_score: i64,
}

// ============================================================================
// Schema Version Tracking  (Issue #309)
// ============================================================================

/// Emitted when the on-chain notification schema version is set or upgraded.
#[contractevent]
#[derive(Clone)]
pub struct SchemaVersionSet {
    #[topic]
    pub admin: Address,
    #[topic]
    pub category: NotificationCategory,
    #[topic]
    pub priority: NotificationPriority,
    /// New schema version number.
    pub schema_version: u32,
    /// Previous schema version (0 when first set).
    pub previous_version: u32,
}

// ============================================================================
// Access Logging  (Issue #312)
// ============================================================================

/// Emitted whenever a protected notification record is accessed.
#[contractevent]
#[derive(Clone)]
pub struct NotificationAccessed {
    #[topic]
    pub notification_id: BytesN<32>,
    #[topic]
    pub accessor: Address,
    #[topic]
    pub category: NotificationCategory,
    /// Ledger timestamp (seconds) when the access occurred.
    pub accessed_at: u64,
}

/// Emitted when an authorized user updates a channel's description or metadata.
///
/// Existing subscribers / members are unaffected — only descriptive metadata changes.
#[contractevent]
#[derive(Clone)]
pub struct ChannelMetadataUpdated {
    #[topic]
    pub channel_id: BytesN<32>,
    #[topic]
    pub updater: Address,
    #[topic]
    pub category: NotificationCategory,
    #[topic]
    pub priority: NotificationPriority,
    pub updated_at: u64,
}

/// Emitted when a processed notification is moved into the on-chain archive.
#[contractevent]
#[derive(Clone)]
pub struct NotificationArchived {
    #[topic]
    pub notification_id: BytesN<32>,
    #[topic]
    pub category: NotificationCategory,
    #[topic]
    pub priority: NotificationPriority,
    pub archived_at: u64,
    pub archive_reason: String,
}

// ============================================================================
// Template Registry  (Issue #352)
// ============================================================================

/// Emitted when a new notification template is registered on-chain.
///
/// Off-chain indexers key off `template_id` to track registered templates.
/// The owner's address is published as an indexed topic for creator-based
/// filtering.
#[contractevent(data_format = "single-value")]
#[derive(Clone)]
pub struct TemplateRegistered {
    /// Address that created and owns the template.
    #[topic]
    pub owner: Address,
    #[topic]
    pub category: NotificationCategory,
    #[topic]
    pub priority: NotificationPriority,
    /// Unique identifier of the newly registered template.
    pub template_id: BytesN<32>,
}

/// Emitted when an existing notification template is updated by its owner.
///
/// Off-chain indexers should use `template_id` to invalidate any cached
/// versions of the template and re-fetch the updated content.
#[contractevent(data_format = "single-value")]
#[derive(Clone)]
pub struct TemplateUpdated {
    /// Address that owns (and updated) the template.
    #[topic]
    pub owner: Address,
    #[topic]
    pub category: NotificationCategory,
    #[topic]
    pub priority: NotificationPriority,
    /// Unique identifier of the updated template.
    pub template_id: BytesN<32>,
}
