/// Notification channel types and storage helpers.
///
/// Channels are named notification streams that users can subscribe to.
/// Each channel records its original creator and maintains an active
/// subscriber count for efficient read-only queries.
use soroban_sdk::{contractevent, contracttype, Address, BytesN, Env, String, Vec};

use crate::base::events::{NotificationCategory, NotificationPriority};

// ============================================================================
// Types
// ============================================================================

/// On-chain notification channel metadata.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NotificationChannel {
    /// Unique channel identifier.
    pub id: BytesN<32>,
    /// Wallet that originally created the channel.
    pub creator: Address,
    /// Human-readable channel name.
    pub name: String,
    /// Number of currently active subscribers.
    pub subscriber_count: u32,
    /// Whether the channel accepts new subscriptions.
    pub is_active: bool,
    /// Ledger timestamp when the channel was created.
    pub created_at: u64,
}

/// Result summary returned by batch subscription.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BatchSubscribeResult {
    /// Number of channels successfully subscribed.
    pub succeeded: u32,
    /// Number of channels skipped due to errors (not found, inactive, already subscribed).
    pub failed: u32,
    /// Channel ids that were successfully subscribed in this call.
    pub subscribed_ids: Vec<BytesN<32>>,
}

// ============================================================================
// Storage keys
// ============================================================================

#[contracttype]
#[derive(Clone)]
pub enum ChannelDataKey {
    /// Channel metadata keyed by channel id.
    Channel(BytesN<32>),
    /// Ordered list of all channel ids.
    AllChannels,
    /// Active subscription flag: (channel_id, subscriber) -> bool.
    Subscription(BytesN<32>, Address),
    /// List of subscriber addresses for a channel (for enumeration).
    ChannelSubscribers(BytesN<32>),
}

/// Maximum channels allowed in a single `batch_subscribe` call.
/// Sourced from the shared limits in [`crate::base::constants`].
pub const MAX_BATCH_SUBSCRIBE: u32 = crate::base::constants::MAX_BATCH_SUBSCRIBE;
/// Maximum length for a channel name.
/// Sourced from the shared limits in [`crate::base::constants`].
pub const MAX_CHANNEL_NAME_LENGTH: u32 = crate::base::constants::MAX_CHANNEL_NAME_LEN;

// ============================================================================
// Storage helpers
// ============================================================================

pub fn load_channel(env: &Env, id: &BytesN<32>) -> Option<NotificationChannel> {
    env.storage()
        .persistent()
        .get(&ChannelDataKey::Channel(id.clone()))
}

pub fn save_channel(env: &Env, channel: &NotificationChannel) {
    env.storage()
        .persistent()
        .set(&ChannelDataKey::Channel(channel.id.clone()), channel);
}

pub fn is_subscribed(env: &Env, channel_id: &BytesN<32>, subscriber: &Address) -> bool {
    env.storage()
        .persistent()
        .get(&ChannelDataKey::Subscription(channel_id.clone(), subscriber.clone()))
        .unwrap_or(false)
}

pub fn set_subscribed(env: &Env, channel_id: &BytesN<32>, subscriber: &Address, value: bool) {
    let key = ChannelDataKey::Subscription(channel_id.clone(), subscriber.clone());
    if value {
        env.storage().persistent().set(&key, &true);
    } else {
        env.storage().persistent().remove(&key);
    }
}

pub fn load_subscribers(env: &Env, channel_id: &BytesN<32>) -> Vec<Address> {
    env.storage()
        .persistent()
        .get(&ChannelDataKey::ChannelSubscribers(channel_id.clone()))
        .unwrap_or(Vec::new(env))
}

pub fn save_subscribers(env: &Env, channel_id: &BytesN<32>, subscribers: &Vec<Address>) {
    env.storage()
        .persistent()
        .set(
            &ChannelDataKey::ChannelSubscribers(channel_id.clone()),
            subscribers,
        );
}

pub fn push_all_channel_id(env: &Env, id: &BytesN<32>) {
    let key = ChannelDataKey::AllChannels;
    let mut all: Vec<BytesN<32>> = env.storage().persistent().get(&key).unwrap_or(Vec::new(env));
    all.push_back(id.clone());
    env.storage().persistent().set(&key, &all);
}

// ============================================================================
// Events
// ============================================================================

/// Emitted when a notification channel is created.
#[contractevent(data_format = "single-value")]
#[derive(Clone)]
pub struct ChannelCreated {
    #[topic]
    pub creator: Address,
    #[topic]
    pub category: NotificationCategory,
    #[topic]
    pub priority: NotificationPriority,
    pub channel_id: BytesN<32>,
}

/// Emitted when a user successfully subscribes to a channel.
#[contractevent(data_format = "single-value")]
#[derive(Clone)]
pub struct ChannelSubscribed {
    #[topic]
    pub channel_id: BytesN<32>,
    #[topic]
    pub subscriber: Address,
    #[topic]
    pub category: NotificationCategory,
    pub subscriber_count: u32,
}

/// Emitted when a user unsubscribes from a channel.
#[contractevent(data_format = "single-value")]
#[derive(Clone)]
pub struct ChannelUnsubscribed {
    #[topic]
    pub channel_id: BytesN<32>,
    #[topic]
    pub subscriber: Address,
    #[topic]
    pub category: NotificationCategory,
    pub subscriber_count: u32,
}

/// Summary event for a batch subscribe call.
#[contractevent]
#[derive(Clone)]
pub struct BatchSubscribeCompleted {
    #[topic]
    pub subscriber: Address,
    #[topic]
    pub category: NotificationCategory,
    #[topic]
    pub priority: NotificationPriority,
    pub succeeded: u32,
    pub failed: u32,
}
