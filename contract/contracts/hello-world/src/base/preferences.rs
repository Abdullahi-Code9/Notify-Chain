/// Notification preference types — Issue #178
///
/// Stores per-recipient preferences for notification delivery channels
/// and category toggles. Designed to be read by off-chain services
/// (email, in-app) as well as on-chain consumers (wallet notifications).
use crate::base::clock::current_time;
use soroban_sdk::{contracttype, Address, Env, Vec};

// ============================================================================
// Types
// ============================================================================

/// Delivery channels a recipient can enable or disable.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DeliveryChannel {
    /// On-chain wallet / event-based notifications (always available)
    Wallet,
    /// Email notifications (requires verified email via off-chain service)
    Email,
    /// In-app / push notifications
    InApp,
}

/// Notification categories that can be toggled independently.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum NotificationCategory {
    /// Payment events (received, sent, topup)
    Payment,
    /// Group membership changes (added, removed)
    GroupMembership,
    /// Group status changes (activated, deactivated)
    GroupStatus,
    /// Contract-level alerts (paused, admin transfer)
    SystemAlerts,
    /// All-purpose general notifications
    General,
}

/// A single channel preference toggle.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ChannelPreference {
    pub channel: DeliveryChannel,
    pub enabled: bool,
}

/// A single category preference toggle.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CategoryPreference {
    pub category: NotificationCategory,
    pub enabled: bool,
}

/// Full notification preferences for a recipient.
///
/// - `channels`   – which delivery channels are active
/// - `categories` – which notification categories are active
/// - `updated_at` – ledger timestamp of the last update
#[contracttype]
#[derive(Clone, Debug)]
pub struct RecipientPreferences {
    pub recipient: Address,
    pub channels: Vec<ChannelPreference>,
    pub categories: Vec<CategoryPreference>,
    pub updated_at: u64,
}

// ============================================================================
// Storage helpers
// ============================================================================

/// Derive the persistent storage key for a recipient's preferences.
/// Using a tuple key keeps things compact and avoids string allocation.
pub fn prefs_key(recipient: &Address) -> (u32, Address) {
    // 0x5052 = ASCII "PR" — namespace prefix to avoid key collisions
    (0x5052_u32, recipient.clone())
}

/// Returns the default channel preferences (all enabled).
pub fn default_channels(env: &Env) -> Vec<ChannelPreference> {
    let mut channels = Vec::new(env);
    channels.push_back(ChannelPreference {
        channel: DeliveryChannel::Wallet,
        enabled: true,
    });
    channels.push_back(ChannelPreference {
        channel: DeliveryChannel::Email,
        enabled: true,
    });
    channels.push_back(ChannelPreference {
        channel: DeliveryChannel::InApp,
        enabled: true,
    });
    channels
}

/// Returns the default category preferences (all enabled).
pub fn default_categories(env: &Env) -> Vec<CategoryPreference> {
    let mut categories = Vec::new(env);
    categories.push_back(CategoryPreference {
        category: NotificationCategory::Payment,
        enabled: true,
    });
    categories.push_back(CategoryPreference {
        category: NotificationCategory::GroupMembership,
        enabled: true,
    });
    categories.push_back(CategoryPreference {
        category: NotificationCategory::GroupStatus,
        enabled: true,
    });
    categories.push_back(CategoryPreference {
        category: NotificationCategory::SystemAlerts,
        enabled: true,
    });
    categories.push_back(CategoryPreference {
        category: NotificationCategory::General,
        enabled: true,
    });
    categories
}

/// Load a recipient's preferences from persistent storage, returning
/// default all-enabled preferences if none have been set yet.
pub fn load_preferences(env: &Env, recipient: &Address) -> RecipientPreferences {
    let key = prefs_key(recipient);
    env.storage()
        .persistent()
        .get(&key)
        .unwrap_or(RecipientPreferences {
            recipient: recipient.clone(),
            channels: default_channels(env),
            categories: default_categories(env),
            updated_at: current_time(env),
        })
}

/// Persist a recipient's preferences.
pub fn save_preferences(env: &Env, prefs: &RecipientPreferences) {
    let key = prefs_key(&prefs.recipient);
    env.storage().persistent().set(&key, prefs);
}
