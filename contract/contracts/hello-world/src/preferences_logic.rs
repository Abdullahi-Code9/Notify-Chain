/// Recipient Preference Management Logic — Issue #178
///
/// Provides get/set/reset operations for per-user notification preferences.
/// Preferences are stored in persistent storage keyed by recipient address.
use crate::base::clock::current_time;
use crate::base::errors::Error;
use crate::base::events::{
    ChannelPreferenceUpdated, NotificationCategory as EventCategory, NotificationPriority,
};
use crate::base::preferences::{
    default_categories, default_channels, load_preferences, save_preferences, CategoryPreference,
    ChannelPreference, DeliveryChannel, NotificationCategory, RecipientPreferences,
};
use soroban_sdk::{Address, Env, Vec};

// ============================================================================
// Public API
// ============================================================================

/// Return the full preferences for `recipient`.
/// If no preferences have been set, returns all-enabled defaults.
pub fn get_preferences(env: Env, recipient: Address) -> RecipientPreferences {
    load_preferences(&env, &recipient)
}

/// Atomically replace all channel and category preferences for `recipient`.
///
/// # Errors
/// - `InvalidInput` if `channels` or `categories` is empty.
/// - `InvalidInput` if a channel or category appears more than once.
pub fn set_preferences(
    env: Env,
    recipient: Address,
    channels: Vec<ChannelPreference>,
    categories: Vec<CategoryPreference>,
) -> Result<(), Error> {
    recipient.require_auth();

    validate_channels(&env, &channels)?;
    validate_categories(&env, &categories)?;

    let prefs = RecipientPreferences {
        recipient: recipient.clone(),
        channels,
        categories,
        updated_at: current_time(&env),
    };

    save_preferences(&env, &prefs);

    // Emit one event per channel so consumers see the updated fields.
    for ch in prefs.channels.iter() {
        emit_channel_preference_updated(&env, &recipient, &ch.channel, ch.enabled, prefs.updated_at);
    }

    Ok(())
}

/// Toggle a single delivery channel on or off for `recipient`.
///
/// If the channel does not yet exist in the stored preferences it is appended.
pub fn set_channel_preference(
    env: Env,
    recipient: Address,
    channel: DeliveryChannel,
    enabled: bool,
) -> Result<(), Error> {
    recipient.require_auth();

    let mut prefs = load_preferences(&env, &recipient);
    let mut found = false;

    for i in 0..prefs.channels.len() {
        let c = prefs.channels.get(i).unwrap();
        if c.channel == channel {
            prefs.channels.set(
                i,
                ChannelPreference {
                    channel: channel.clone(),
                    enabled,
                },
            );
            found = true;
            break;
        }
    }

    if !found {
        prefs.channels.push_back(ChannelPreference {
            channel: channel.clone(),
            enabled,
        });
    }

    prefs.updated_at = current_time(&env);
    save_preferences(&env, &prefs);

    emit_channel_preference_updated(&env, &recipient, &channel, enabled, prefs.updated_at);

    Ok(())
}

/// Toggle a single notification category on or off for `recipient`.
///
/// If the category does not yet exist in the stored preferences it is appended.
pub fn set_category_preference(
    env: Env,
    recipient: Address,
    category: NotificationCategory,
    enabled: bool,
) -> Result<(), Error> {
    recipient.require_auth();

    let mut prefs = load_preferences(&env, &recipient);
    let mut found = false;

    for i in 0..prefs.categories.len() {
        let c = prefs.categories.get(i).unwrap();
        if c.category == category {
            prefs.categories.set(
                i,
                CategoryPreference {
                    category: category.clone(),
                    enabled,
                },
            );
            found = true;
            break;
        }
    }

    if !found {
        prefs
            .categories
            .push_back(CategoryPreference { category, enabled });
    }

    prefs.updated_at = current_time(&env);
    save_preferences(&env, &prefs);
    Ok(())
}

/// Reset all preferences for `recipient` to the default all-enabled state.
pub fn reset_preferences(env: Env, recipient: Address) -> Result<(), Error> {
    recipient.require_auth();

    let prefs = RecipientPreferences {
        recipient: recipient.clone(),
        channels: default_channels(&env),
        categories: default_categories(&env),
        updated_at: current_time(&env),
    };

    save_preferences(&env, &prefs);

    for ch in prefs.channels.iter() {
        emit_channel_preference_updated(&env, &recipient, &ch.channel, ch.enabled, prefs.updated_at);
    }

    Ok(())
}

/// Check whether a specific channel is enabled for `recipient`.
pub fn is_channel_enabled(env: Env, recipient: Address, channel: DeliveryChannel) -> bool {
    let prefs = load_preferences(&env, &recipient);
    for c in prefs.channels.iter() {
        if c.channel == channel {
            return c.enabled;
        }
    }
    // Default to enabled if not explicitly set
    true
}

/// Check whether a specific category is enabled for `recipient`.
pub fn is_category_enabled(env: Env, recipient: Address, category: NotificationCategory) -> bool {
    let prefs = load_preferences(&env, &recipient);
    for c in prefs.categories.iter() {
        if c.category == category {
            return c.enabled;
        }
    }
    // Default to enabled if not explicitly set
    true
}

// ============================================================================
// Validation helpers
// ============================================================================

fn validate_channels(env: &Env, channels: &Vec<ChannelPreference>) -> Result<(), Error> {
    if channels.is_empty() {
        return Err(Error::InvalidInput);
    }
    // Ensure no duplicate channels
    let mut seen: Vec<u32> = Vec::new(env);
    for ch in channels.iter() {
        let discriminant = channel_discriminant(&ch.channel);
        for s in seen.iter() {
            if s == discriminant {
                return Err(Error::InvalidInput);
            }
        }
        seen.push_back(discriminant);
    }
    Ok(())
}

fn validate_categories(env: &Env, categories: &Vec<CategoryPreference>) -> Result<(), Error> {
    if categories.is_empty() {
        return Err(Error::InvalidInput);
    }
    let mut seen: Vec<u32> = Vec::new(env);
    for cat in categories.iter() {
        let discriminant = category_discriminant(&cat.category);
        for s in seen.iter() {
            if s == discriminant {
                return Err(Error::InvalidInput);
            }
        }
        seen.push_back(discriminant);
    }
    Ok(())
}

fn channel_discriminant(channel: &DeliveryChannel) -> u32 {
    match channel {
        DeliveryChannel::Wallet => 0,
        DeliveryChannel::Email => 1,
        DeliveryChannel::InApp => 2,
    }
}

fn category_discriminant(category: &NotificationCategory) -> u32 {
    match category {
        NotificationCategory::Payment => 0,
        NotificationCategory::GroupMembership => 1,
        NotificationCategory::GroupStatus => 2,
        NotificationCategory::SystemAlerts => 3,
        NotificationCategory::General => 4,
    }
}

fn emit_channel_preference_updated(
    env: &Env,
    recipient: &Address,
    channel: &DeliveryChannel,
    enabled: bool,
    updated_at: u64,
) {
    ChannelPreferenceUpdated {
        recipient: recipient.clone(),
        category: EventCategory::Notification,
        priority: NotificationPriority::Medium,
        channel: channel_discriminant(channel),
        enabled,
        updated_at,
    }
    .publish(env);
}
