use crate::base::clock::current_time;
use crate::base::events::{
    NotificationCategory, NotificationPriority, ReputationTierChanged, ReputationUpdated,
};
use crate::base::reputation::{ReputationTier, SenderReputation};
use soroban_sdk::{contracttype, Address, Env};

#[contracttype]
#[derive(Clone)]
enum ReputationKey {
    Sender(Address),
}

fn tier_as_u32(tier: ReputationTier) -> u32 {
    match tier {
        ReputationTier::Unverified => 0,
        ReputationTier::Bronze => 1,
        ReputationTier::Silver => 2,
        ReputationTier::Gold => 3,
        ReputationTier::Platinum => 4,
    }
}

/// Initialize or get a sender's reputation record.
pub fn get_or_create_reputation(
    env: &Env,
    sender: &Address,
) -> Result<SenderReputation, soroban_sdk::Error> {
    let key = ReputationKey::Sender(sender.clone());

    match env
        .storage()
        .persistent()
        .get::<_, SenderReputation>(&key)
    {
        Some(rep) => Ok(rep),
        None => {
            let current_time = current_time(env);
            Ok(SenderReputation::new(sender.clone(), current_time))
        }
    }
}

fn save_reputation(env: &Env, reputation: &SenderReputation) {
    let key = ReputationKey::Sender(reputation.sender.clone());
    env.storage().persistent().set(&key, reputation);
}

/// Record a successful notification delivery and update reputation.
pub fn record_successful_delivery(
    env: &Env,
    sender: &Address,
) -> Result<(), soroban_sdk::Error> {
    let mut reputation = get_or_create_reputation(env, sender)?;
    let old_tier = tier_as_u32(reputation.get_tier());
    reputation.record_successful_delivery(current_time(env));
    let new_tier = tier_as_u32(reputation.get_tier());
    save_reputation(env, &reputation);

    ReputationUpdated {
        sender: sender.clone(),
        category: NotificationCategory::Notification,
        priority: NotificationPriority::Low,
        new_score: reputation.reputation_score,
        successful_count: reputation.successful_deliveries,
        failed_count: reputation.failed_deliveries,
    }
    .publish(env);

    if old_tier != new_tier {
        ReputationTierChanged {
            sender: sender.clone(),
            category: NotificationCategory::Notification,
            priority: NotificationPriority::High,
            old_tier,
            new_tier,
            reputation_score: reputation.reputation_score,
        }
        .publish(env);
    }

    Ok(())
}

/// Record a failed notification delivery and update reputation.
pub fn record_failed_delivery(env: &Env, sender: &Address) -> Result<(), soroban_sdk::Error> {
    let mut reputation = get_or_create_reputation(env, sender)?;
    let old_tier = tier_as_u32(reputation.get_tier());
    reputation.record_failed_delivery(current_time(env));
    let new_tier = tier_as_u32(reputation.get_tier());
    save_reputation(env, &reputation);

    ReputationUpdated {
        sender: sender.clone(),
        category: NotificationCategory::Notification,
        priority: NotificationPriority::Medium,
        new_score: reputation.reputation_score,
        successful_count: reputation.successful_deliveries,
        failed_count: reputation.failed_deliveries,
    }
    .publish(env);

    if old_tier != new_tier {
        ReputationTierChanged {
            sender: sender.clone(),
            category: NotificationCategory::Notification,
            priority: NotificationPriority::High,
            old_tier,
            new_tier,
            reputation_score: reputation.reputation_score,
        }
        .publish(env);
    }

    Ok(())
}

/// Returns the reputation score for a sender, or the initial default.
pub fn get_reputation_score(env: &Env, sender: &Address) -> Result<i64, soroban_sdk::Error> {
    Ok(get_or_create_reputation(env, sender)?.reputation_score)
}

/// Returns the full reputation record for a sender.
pub fn get_reputation(env: &Env, sender: &Address) -> Result<SenderReputation, soroban_sdk::Error> {
    get_or_create_reputation(env, sender)
}

/// Returns the reputation tier discriminant for a sender.
pub fn get_reputation_tier(env: &Env, sender: &Address) -> Result<u32, soroban_sdk::Error> {
    Ok(tier_as_u32(get_or_create_reputation(env, sender)?.get_tier()))
}
