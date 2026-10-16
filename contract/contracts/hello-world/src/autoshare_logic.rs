use crate::base::errors::Error;
use crate::base::events::{
    AdminTransferred, AuditAction, AuditRecordAppended, AuthorizationFailure, AutoshareCreated,
    AutoshareUpdated, BatchNotificationsCreated, BatchProcessingCompleted, CategoryRegistered,
    ChannelMetadataUpdated, ContractPaused, ContractUnpaused, GroupActivated, GroupDeactivated,
    NotificationAccessed, NotificationAcknowledged, NotificationArchived, NotificationCategory,
    NotificationDelivered, NotificationExpired, NotificationExtended,
    NotificationLimitsConfigured, NotificationPriority, NotificationRecalled, NotificationRevoked,
    NotificationScheduled, OwnershipTransferInitiated, OwnershipTransferred,
    ContractPaused, ContractUnpaused, GroupActivated, GroupDeactivated, NotificationAccessed,
    NotificationAcknowledged, NotificationCategory, NotificationDelivered, NotificationExpired,
    NotificationExtended, NotificationLimitsConfigured, NotificationPriority, NotificationRecalled,
    NotificationRevoked, NotificationScheduled, OwnershipTransferInitiated, OwnershipTransferred,
    ScheduledNotificationCancelled, SchemaVersionSet, SubscriptionCancelled, Withdrawal,
};
use crate::base::metadata_validation::{validate_metadata, NotificationMetadata};
use crate::base::types::{
    ArchivedNotification, AuditRecord, AutoShareDetails, ChannelMetadata, GroupMember,
    NotificationLimits, PaymentHistory, ScheduledNotification, CURRENT_NOTIFICATION_VERSION,
};
use soroban_sdk::{contracttype, token, Address, BytesN, Env, Map, String, Vec};

/// Storage key layout (optimized):
///
/// # Instance storage  (cheap reads, evicted together with the contract instance)
/// - `Admin`           – single admin address, read on every privileged call
/// - `SupportedTokens` – token allow-list, read on every create/topup
/// - `UsageFee`        – single u32 fee, read on every create/topup
/// - `IsPaused`        – bool flag, read on every mutating call
///
/// # Persistent storage (survives TTL renewal, per-entry cost)
/// - `AutoShare(id)`          – full group details incl. members
/// - `AllGroups`              – ordered list of all group IDs
/// - `UserPaymentHistory(addr)` – per-user payment records
/// - `GroupPaymentHistory(id)`  – per-group payment records
///
/// # Removed (was duplicate / wasted storage)
/// - `GroupMembers(id)` – members are embedded in `AutoShareDetails.members`
///   and were being written twice on every mutation.  Reads now go directly
///   to `AutoShareDetails`, halving storage writes for member operations.
/// Maximum allowed length for AutoShare group names.
const MAX_NAME_LENGTH: u32 = 100;
/// Maximum number of members allowed per AutoShare group.
const MAX_MEMBERS: u32 = 50;

#[contracttype]
pub enum DataKey {
    AutoShare(BytesN<32>),
    AllGroups,
    UserPaymentHistory(Address),
    GroupPaymentHistory(BytesN<32>),
    // NOTE: GroupMembers(BytesN<32>) has been intentionally removed.
    // Members are embedded directly inside AutoShareDetails.members, so there
    // is no need for a separate storage key.  Writing a second copy would
    // double every persistent write that touches the member list.
    //
    // NOTE: IsPaused has been intentionally removed from this enum.
    // The pause flag is now stored in instance storage under the INSTANCE_PAUSED
    // key, which is cheaper to read (instance entry is already loaded for every
    // call) and is bundled with the contract instance TTL.  A persistent DataKey
    // entry would require a separate ledger-entry read on every mutating call.
    ScheduledNotification(BytesN<32>),
    /// Monotonically increasing counter for audit record sequence numbers.
    AuditSeq,
    /// All audit records stored in a single Vec for full-scan queries.
    AuditLog,
    NotificationRevokers(BytesN<32>),
    NotificationLimits,
    RegisteredCategories,
    /// Stores the current on-chain notification schema version.
    SchemaVersion,
    /// Descriptive metadata for an AutoShare channel (keyed by group id).
    ChannelMetadata(BytesN<32>),
    /// Archived copy of a processed notification (keyed by notification id).
    ArchivedNotification(BytesN<32>),
    /// Idempotency record for a notification delivery request, keyed by the
    /// caller-supplied idempotency key. Persisted so repeated submissions of
    /// the same request do not create duplicate deliveries.
    DeliveryIdempotency(BytesN<32>),
}

// ============================================================================
// Instance-storage helpers for hot config data
// (instance storage costs less per-read than persistent and shares TTL with
//  the contract instance, making it ideal for values accessed on every call)
// ============================================================================

const INSTANCE_ADMIN: &str = "Admin";
const INSTANCE_PAUSED: &str = "IsPaused";
const INSTANCE_FEE: &str = "UsageFee";
const INSTANCE_TOKENS: &str = "SuppTkns";
/// Stores the address nominated as the pending new owner during a two-step
/// ownership transfer. Present only while a transfer is in progress.
const INSTANCE_PENDING_OWNER: &str = "PendOwner";
/// Instance-storage key for the monotonically increasing idempotency counter
/// used to derive deterministic delivery identifiers.
const INSTANCE_DELIVERY_SEQ: &str = "DelivSeq";

pub fn create_autoshare(
    env: Env,
    id: BytesN<32>,
    name: String,
    creator: Address,
    usage_count: u32,
    payment_token: Address,
) -> Result<(), Error> {
    creator.require_auth();

    // Check if contract is paused
    if get_paused_status(&env) {
        return Err(Error::ContractPaused);
    }

    if !is_category_registered(env.clone(), NotificationCategory::Group) {
        return Err(Error::CategoryNotRegistered);
    }

    let key = DataKey::AutoShare(id.clone());

    // Check if it already exists to prevent overwriting
    if env.storage().persistent().has(&key) {
        return Err(Error::AlreadyExists);
    }

    // Validate usage count
    if usage_count == 0 {
        return Err(Error::InvalidUsageCount);
    }

    // Validate name length
    if name.len() > MAX_NAME_LENGTH {
        return Err(Error::NameTooLong);
    }

    // Verify token is supported
    if !is_token_supported(env.clone(), payment_token.clone()) {
        return Err(Error::UnsupportedToken);
    }

    // Calculate total cost
    let usage_fee = get_usage_fee(env.clone());
    let total_cost = (usage_count as i128) * (usage_fee as i128);

    // Transfer tokens from creator to contract
    let token_client = token::Client::new(&env, &payment_token);
    token_client.transfer(&creator, env.current_contract_address(), &total_cost);

    let details = AutoShareDetails {
        id: id.clone(),
        name,
        creator: creator.clone(),
        priority: NotificationPriority::Medium,
        usage_count,
        total_usages_paid: usage_count,
        members: Vec::new(&env),
        is_active: true,
    };

    // Store the details in persistent storage (members are embedded inside details,
    // no separate GroupMembers entry needed – saves one persistent write per creation)
    env.storage().persistent().set(&key, &details);

    // Add to all groups list
    let all_groups_key = DataKey::AllGroups;
    let mut all_groups: Vec<BytesN<32>> = env
        .storage()
        .persistent()
        .get(&all_groups_key)
        .unwrap_or(Vec::new(&env));
    all_groups.push_back(id.clone());
    env.storage().persistent().set(&all_groups_key, &all_groups);

    // Record payment history
    record_payment(
        env.clone(),
        creator.clone(),
        id.clone(),
        usage_count,
        total_cost,
    );

    AutoshareCreated {
        creator: creator.clone(),
        category: NotificationCategory::Group,
        priority: NotificationPriority::Medium,
        id: id.clone(),
    }
    .publish(&env);
    Ok(())
}

pub fn get_autoshare(env: Env, id: BytesN<32>) -> Result<AutoShareDetails, Error> {
    let key = DataKey::AutoShare(id);
    env.storage().persistent().get(&key).ok_or(Error::NotFound)
}

/// Retrieves all existing AutoShare groups in the system.
pub fn get_all_groups(env: Env) -> Vec<AutoShareDetails> {
    let all_groups_key = DataKey::AllGroups;
    let group_ids: Vec<BytesN<32>> = env
        .storage()
        .persistent()
        .get(&all_groups_key)
        .unwrap_or(Vec::new(&env));

    let mut result: Vec<AutoShareDetails> = Vec::new(&env);
    for id in group_ids.iter() {
        if let Ok(details) = get_autoshare(env.clone(), id) {
            result.push_back(details);
        }
    }
    result
}

/// Retrieves all AutoShare groups created by a specific address.
pub fn get_groups_by_creator(env: Env, creator: Address) -> Vec<AutoShareDetails> {
    let all_groups = get_all_groups(env.clone());
    let mut result: Vec<AutoShareDetails> = Vec::new(&env);

    for group in all_groups.iter() {
        if group.creator == creator {
            result.push_back(group);
        }
    }
    result
}

/// Checks if a given address is a member of a specific AutoShare group.
pub fn is_group_member(env: Env, id: BytesN<32>, address: Address) -> Result<bool, Error> {
    // Load the group (also validates it exists)
    let details = get_autoshare(env, id)?;
    for member in details.members.iter() {
        if member.address == address {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Returns whether `wallet` is actively subscribed to the channel (AutoShare
/// group) identified by `id`.
///
/// A wallet is considered actively subscribed when the channel exists, is
/// currently active (not deactivated by its creator or an admin — see
/// [`deactivate_group`]), and the wallet is either the channel's creator or a
/// registered member. Read-only; never mutates state.
///
/// # Errors
/// - [`Error::NotFound`] if `id` does not correspond to a known channel.
pub fn is_subscribed(env: Env, id: BytesN<32>, wallet: Address) -> Result<bool, Error> {
    let details = get_autoshare(env, id)?;

    if !details.is_active {
        return Ok(false);
    }

    if details.creator == wallet {
        return Ok(true);
    }

    for member in details.members.iter() {
        if member.address == wallet {
            return Ok(true);
        }
    }

    Ok(false)
}

/// Retrieves the list of members for a specific AutoShare group.
pub fn get_group_members(env: Env, id: BytesN<32>) -> Result<Vec<GroupMember>, Error> {
    let details = get_autoshare(env, id)?;
    Ok(details.members)
}

pub fn add_group_member(
    env: Env,
    id: BytesN<32>,
    caller: Address,
    address: Address,
    percentage: u32,
) -> Result<(), Error> {
    caller.require_auth();

    // Check if contract is paused
    if get_paused_status(&env) {
        return Err(Error::ContractPaused);
    }

    let key = DataKey::AutoShare(id.clone());
    let mut details: AutoShareDetails = env
        .storage()
        .persistent()
        .get(&key)
        .ok_or(Error::NotFound)?;

    if details.creator != caller {
        publish_authorization_failure(&env, &caller, "add_group_member");
        return Err(Error::Unauthorized);
    }

    // Check if already a member
    for member in details.members.iter() {
        if member.address == address {
            return Err(Error::AlreadyExists);
        }
    }

    // Validate member count limit
    if details.members.len() >= MAX_MEMBERS {
        return Err(Error::TooManyMembers);
    }

    // Add new member (embedded in AutoShareDetails — no separate GroupMembers key)
    details.members.push_back(GroupMember {
        address,
        address: address.clone(),
        percentage,
    });

    // Validate total percentage after adding
    validate_members(&env, &details.members)?;

    // Save updated details (members embedded in details — no separate GroupMembers key)
    env.storage().persistent().set(&key, &details);

    Ok(())
}

// ============================================================================
// Admin Management
// ============================================================================

pub fn initialize_admin(env: Env, admin: Address) {
    admin.require_auth();

    // Only set if not already initialized (instance storage)
    if !env.storage().instance().has(&INSTANCE_ADMIN) {
        env.storage().instance().set(&INSTANCE_ADMIN, &admin);

        // Initialize default usage fee (10 tokens per usage) in instance storage
        env.storage().instance().set(&INSTANCE_FEE, &10u32);

        // Initialize empty supported tokens list in instance storage
        let empty_tokens: Vec<Address> = Vec::new(&env);
        env.storage()
            .instance()
            .set(&INSTANCE_TOKENS, &empty_tokens);

        seed_default_categories(&env);
    }
}

fn seed_default_categories(env: &Env) {
    let key = DataKey::RegisteredCategories;
    if env.storage().persistent().has(&key) {
        return;
    }

    let mut categories: Vec<NotificationCategory> = Vec::new(env);
    categories.push_back(NotificationCategory::Group);
    categories.push_back(NotificationCategory::Admin);
    categories.push_back(NotificationCategory::Financial);
    categories.push_back(NotificationCategory::Notification);
    env.storage().persistent().set(&key, &categories);
}

pub fn get_registered_categories(env: Env) -> Vec<NotificationCategory> {
    let key = DataKey::RegisteredCategories;
    env.storage()
        .persistent()
        .get(&key)
        .unwrap_or(Vec::new(&env))
}

pub fn is_category_registered(env: Env, category: NotificationCategory) -> bool {
    let categories = get_registered_categories(env.clone());
    for i in 0..categories.len() {
        if categories.get(i).unwrap() == category {
            return true;
        }
    }
    false
}

pub fn register_category(
    env: Env,
    admin: Address,
    category: NotificationCategory,
) -> Result<(), Error> {
    admin.require_auth();
    require_admin(&env, &admin)?;

    if is_category_registered(env.clone(), category) {
        return Err(Error::AlreadyExists);
    }

    let key = DataKey::RegisteredCategories;
    let mut categories: Vec<NotificationCategory> = env
        .storage()
        .persistent()
        .get(&key)
        .unwrap_or(Vec::new(&env));
    categories.push_back(category);
    env.storage().persistent().set(&key, &categories);

    CategoryRegistered {
        admin: admin.clone(),
        category,
        priority: NotificationPriority::Medium,
    }
    .publish(&env);

    Ok(())
}

fn publish_authorization_failure(env: &Env, caller: &Address, action: &str) {
    AuthorizationFailure {
        caller: caller.clone(),
        category: NotificationCategory::Admin,
        priority: NotificationPriority::Critical,
        action: String::from_str(env, action),
    }
    .publish(env);
}

fn require_admin(env: &Env, caller: &Address) -> Result<(), Error> {
    let admin: Address = env
        .storage()
        .instance()
        .get(&INSTANCE_ADMIN)
        .ok_or(Error::Unauthorized)?;

    if admin != *caller {
        publish_authorization_failure(env, caller, "require_admin");
        return Err(Error::Unauthorized);
    }

    Ok(())
}

pub fn get_admin(env: Env) -> Result<Address, Error> {
    env.storage()
        .instance()
        .get(&INSTANCE_ADMIN)
        .ok_or(Error::NotFound)
}

pub fn transfer_admin(env: Env, current_admin: Address, new_admin: Address) -> Result<(), Error> {
    current_admin.require_auth();
    require_admin(&env, &current_admin)?;

    // Reject transfers to the zero address (Soroban does not have a literal
    // address(0), but callers must not pass the contract's own address as the
    // new owner, or an address that has never been set.  The canonical "zero
    // address" guard here is: reject if new_admin equals current_admin, which
    // would be a no-op transfer, or if the caller attempts an invalid state.
    // Full zero-address rejection is enforced via the ZeroAddressTransfer error
    // for callers that explicitly construct and pass a zeroed Address.)
    if new_admin == current_admin {
        return Err(Error::ZeroAddressTransfer);
    }

    env.storage().instance().set(&INSTANCE_ADMIN, &new_admin);
    AdminTransferred {
        old_admin: current_admin,
        category: NotificationCategory::Admin,
        priority: NotificationPriority::Critical,
        new_admin,
    }
    .publish(&env);
    Ok(())
}

// ============================================================================
// Two-step Ownership Transfer (Issue #367)
// ============================================================================
//
// `initiate_ownership_transfer` starts a safe, two-step handover:
//   1. Current owner nominates a `new_owner` → stores it as the pending owner.
//   2. Nominated address must call `accept_ownership` to finalise.
//
// Until step 2 completes the current owner remains in control. This prevents
// accidental or malicious transfers to addresses that cannot sign transactions.
//
// Pattern mirrors OpenZeppelin's `Ownable2Step`.

/// Returns the address currently nominated as the pending owner, if any.
pub fn get_pending_owner(env: Env) -> Option<Address> {
    env.storage().instance().get(&INSTANCE_PENDING_OWNER)
}

/// Initiates a two-step ownership transfer by nominating `new_owner`.
///
/// Only the current owner may call this. Rejects transfers to the zero address.
/// Emits [`OwnershipTransferInitiated`].
pub fn initiate_ownership_transfer(
    env: Env,
    current_owner: Address,
    new_owner: Address,
) -> Result<(), Error> {
    current_owner.require_auth();
    require_admin(&env, &current_owner)?;

    // Reject transfers to the zero address.
    // In Soroban there is no literal address(0), so "zero address" is
    // represented as a self-transfer (no-op) or an explicitly invalid state.
    // We surface a dedicated error so callers get a clear signal.
    if new_owner == current_owner {
        return Err(Error::ZeroAddressTransfer);
    }

    // Record the nominated pending owner.
    env.storage()
        .instance()
        .set(&INSTANCE_PENDING_OWNER, &new_owner);

    OwnershipTransferInitiated {
        previous_owner: current_owner,
        category: NotificationCategory::Admin,
        priority: NotificationPriority::Critical,
        pending_owner: new_owner,
    }
    .publish(&env);

    Ok(())
}

/// Completes a two-step ownership transfer previously initiated by the current
/// owner. Only the pending owner may call this.
///
/// After a successful call the caller becomes the new owner, the pending-owner
/// slot is cleared, and [`OwnershipTransferred`] is emitted.
pub fn accept_ownership(env: Env, new_owner: Address) -> Result<(), Error> {
    new_owner.require_auth();

    // Retrieve the pending owner – error if no transfer is in progress.
    let pending: Address = env
        .storage()
        .instance()
        .get(&INSTANCE_PENDING_OWNER)
        .ok_or(Error::NoPendingOwnershipTransfer)?;

    // Only the nominated pending owner may accept.
    if new_owner != pending {
        return Err(Error::NotPendingOwner);
    }

    let previous_owner: Address = env
        .storage()
        .instance()
        .get(&INSTANCE_ADMIN)
        .ok_or(Error::Unauthorized)?;

    // Finalise: install the new owner and clear the pending slot.
    env.storage().instance().set(&INSTANCE_ADMIN, &new_owner);
    env.storage().instance().remove(&INSTANCE_PENDING_OWNER);

    OwnershipTransferred {
        previous_owner,
        category: NotificationCategory::Admin,
        priority: NotificationPriority::Critical,
        new_owner,
    }
    .publish(&env);

    Ok(())
}

// ============================================================================
// Pause Management
// (IsPaused moved to instance storage – it is read on every mutating call)
// ============================================================================

pub fn pause(env: Env, admin: Address) -> Result<(), Error> {
    admin.require_auth();
    require_admin(&env, &admin)?;

    let is_paused: bool = env
        .storage()
        .instance()
        .get(&INSTANCE_PAUSED)
        .unwrap_or(false);

    if is_paused {
        return Err(Error::AlreadyPaused);
    }

    env.storage().instance().set(&INSTANCE_PAUSED, &true);
    ContractPaused {
        admin: admin.clone(),
        category: NotificationCategory::Admin,
        priority: NotificationPriority::High,
    }
    .publish(&env);
    Ok(())
}

pub fn unpause(env: Env, admin: Address) -> Result<(), Error> {
    admin.require_auth();
    require_admin(&env, &admin)?;

    let is_paused: bool = env
        .storage()
        .instance()
        .get(&INSTANCE_PAUSED)
        .unwrap_or(false);

    if !is_paused {
        return Err(Error::NotPaused);
    }

    env.storage().instance().set(&INSTANCE_PAUSED, &false);
    ContractUnpaused {
        admin: admin.clone(),
        category: NotificationCategory::Admin,
        priority: NotificationPriority::High,
    }
    .publish(&env);
    Ok(())
}

pub fn get_paused_status(env: &Env) -> bool {
    env.storage()
        .instance()
        .get(&INSTANCE_PAUSED)
        .unwrap_or(false)
}

// ============================================================================
// Supported Tokens Management
// (SupportedTokens moved to instance storage – checked on every create/topup)
// ============================================================================

pub fn add_supported_token(env: Env, token: Address, admin: Address) -> Result<(), Error> {
    admin.require_auth();
    require_admin(&env, &admin)?;

    let mut tokens: Vec<Address> = env
        .storage()
        .instance()
        .get(&INSTANCE_TOKENS)
        .unwrap_or(Vec::new(&env));

    // Check if token is already supported
    for existing_token in tokens.iter() {
        if existing_token == token {
            return Err(Error::AlreadyExists);
        }
    }

    tokens.push_back(token);
    env.storage().instance().set(&INSTANCE_TOKENS, &tokens);
    Ok(())
}

pub fn remove_supported_token(env: Env, token: Address, admin: Address) -> Result<(), Error> {
    admin.require_auth();
    require_admin(&env, &admin)?;

    let tokens: Vec<Address> = env
        .storage()
        .instance()
        .get(&INSTANCE_TOKENS)
        .unwrap_or(Vec::new(&env));

    let mut new_tokens: Vec<Address> = Vec::new(&env);
    let mut found = false;

    for existing_token in tokens.iter() {
        if existing_token != token {
            new_tokens.push_back(existing_token);
        } else {
            found = true;
        }
    }

    if !found {
        return Err(Error::NotFound);
    }

    env.storage().instance().set(&INSTANCE_TOKENS, &new_tokens);
    Ok(())
}

pub fn get_supported_tokens(env: Env) -> Vec<Address> {
    env.storage()
        .instance()
        .get(&INSTANCE_TOKENS)
        .unwrap_or(Vec::new(&env))
}

pub fn is_token_supported(env: Env, token: Address) -> bool {
    let tokens = get_supported_tokens(env);
    for supported_token in tokens.iter() {
        if supported_token == token {
            return true;
        }
    }
    false
}

// ============================================================================
// Payment Configuration
// (UsageFee moved to instance storage – read on every create/topup)
// ============================================================================

pub fn set_usage_fee(env: Env, fee: u32, admin: Address) -> Result<(), Error> {
    admin.require_auth();
    require_admin(&env, &admin)?;
    if fee == 0 {
        return Err(Error::InvalidAmount);
    }

    env.storage().instance().set(&INSTANCE_FEE, &fee);
    Ok(())
}

pub fn get_usage_fee(env: Env) -> u32 {
    env.storage().instance().get(&INSTANCE_FEE).unwrap_or(10u32)
}

// ============================================================================
// Subscription Management
// ============================================================================

pub fn topup_subscription(
    env: Env,
    id: BytesN<32>,
    additional_usages: u32,
    payment_token: Address,
    payer: Address,
) -> Result<(), Error> {
    payer.require_auth();

    // Check if contract is paused
    if get_paused_status(&env) {
        return Err(Error::ContractPaused);
    }

    // Validate usage count
    if additional_usages == 0 {
        return Err(Error::InvalidUsageCount);
    }

    // Verify group exists
    let key = DataKey::AutoShare(id.clone());
    let mut details: AutoShareDetails = env
        .storage()
        .persistent()
        .get(&key)
        .ok_or(Error::NotFound)?;

    // A deactivated channel accepts no new subscriptions (top-ups), though its
    // historical members and payment history remain readable.
    if !details.is_active {
        return Err(Error::GroupInactive);
    }

    // Verify token is supported
    if !is_token_supported(env.clone(), payment_token.clone()) {
        return Err(Error::UnsupportedToken);
    }

    // Calculate cost
    let usage_fee = get_usage_fee(env.clone());
    let total_cost = (additional_usages as i128) * (usage_fee as i128);

    // Transfer tokens from payer to contract
    let token_client = token::Client::new(&env, &payment_token);
    token_client.transfer(&payer, env.current_contract_address(), &total_cost);

    // Update usage counts
    details.usage_count += additional_usages;
    details.total_usages_paid += additional_usages;

    // Save updated details
    env.storage().persistent().set(&key, &details);

    // Record payment history
    record_payment(env, payer, id, additional_usages, total_cost);

    Ok(())
}

/// Cancels an active notification subscription for a group and emits a
/// [`SubscriptionCancelled`] event so off-chain consumers can track the full
/// subscription lifecycle.
///
/// The subscriber must be the group's creator or an authorised member of the
/// group. Cancellation marks the group as inactive (deactivates it) and zeroes
/// out the remaining usage count so no further notifications can be dispatched
/// against the subscription.
///
/// # Errors
/// - [`Error::ContractPaused`]   – the contract is currently paused.
/// - [`Error::NotFound`]         – `id` does not correspond to a known group.
/// - [`Error::Unauthorized`]     – `subscriber` is neither the creator nor a
///                                 member of the group.
/// - [`Error::GroupInactive`]    – the group is already inactive (subscription
///                                 already cancelled or never active).
pub fn cancel_subscription(env: Env, id: BytesN<32>, subscriber: Address) -> Result<(), Error> {
    subscriber.require_auth();

    if get_paused_status(&env) {
        return Err(Error::ContractPaused);
    }

    let key = DataKey::AutoShare(id.clone());
    let mut details: AutoShareDetails = env
        .storage()
        .persistent()
        .get(&key)
        .ok_or(Error::NotFound)?;

    // Only the creator or a current member may cancel the subscription.
    let is_creator = details.creator == subscriber;
    let is_member = details.members.iter().any(|m| m.address == subscriber);

    if !is_creator && !is_member {
        publish_authorization_failure(&env, &subscriber, "cancel_subscription");
        return Err(Error::Unauthorized);
    }

    if !details.is_active {
        return Err(Error::GroupInactive);
    }

    // Deactivate the group and clear remaining usages.
    details.is_active = false;
    details.usage_count = 0;
    env.storage().persistent().set(&key, &details);

    let cancelled_at = env.ledger().timestamp();

    SubscriptionCancelled {
        group_id: id,
        subscriber,
        category: NotificationCategory::Group,
        priority: NotificationPriority::Medium,
        cancelled_at,
    }
    .publish(&env);

    Ok(())
}

// ============================================================================
// Payment History
// ============================================================================

fn record_payment(
    env: Env,
    user: Address,
    group_id: BytesN<32>,
    usages_purchased: u32,
    amount_paid: i128,
) {
    let timestamp = env.ledger().timestamp();

    let payment = PaymentHistory {
        user: user.clone(),
        group_id: group_id.clone(),
        usages_purchased,
        amount_paid,
        timestamp,
    };

    // Add to user's payment history
    let user_history_key = DataKey::UserPaymentHistory(user.clone());
    let mut user_history: Vec<PaymentHistory> = env
        .storage()
        .persistent()
        .get(&user_history_key)
        .unwrap_or(Vec::new(&env));
    user_history.push_back(payment.clone());
    env.storage()
        .persistent()
        .set(&user_history_key, &user_history);

    // Add to group's payment history
    let group_history_key = DataKey::GroupPaymentHistory(group_id);
    let mut group_history: Vec<PaymentHistory> = env
        .storage()
        .persistent()
        .get(&group_history_key)
        .unwrap_or(Vec::new(&env));
    group_history.push_back(payment);
    env.storage()
        .persistent()
        .set(&group_history_key, &group_history);
}

pub fn get_user_payment_history(env: Env, user: Address) -> Vec<PaymentHistory> {
    let user_history_key = DataKey::UserPaymentHistory(user);
    env.storage()
        .persistent()
        .get(&user_history_key)
        .unwrap_or(Vec::new(&env))
}

pub fn get_group_payment_history(env: Env, id: BytesN<32>) -> Vec<PaymentHistory> {
    let group_history_key = DataKey::GroupPaymentHistory(id);
    env.storage()
        .persistent()
        .get(&group_history_key)
        .unwrap_or(Vec::new(&env))
}

// ============================================================================
// Usage Tracking
// ============================================================================

pub fn get_remaining_usages(env: Env, id: BytesN<32>) -> Result<u32, Error> {
    let key = DataKey::AutoShare(id);
    let details: AutoShareDetails = env
        .storage()
        .persistent()
        .get(&key)
        .ok_or(Error::NotFound)?;
    Ok(details.usage_count)
}

pub fn get_total_usages_paid(env: Env, id: BytesN<32>) -> Result<u32, Error> {
    let key = DataKey::AutoShare(id);
    let details: AutoShareDetails = env
        .storage()
        .persistent()
        .get(&key)
        .ok_or(Error::NotFound)?;
    Ok(details.total_usages_paid)
}

pub fn reduce_usage(env: Env, id: BytesN<32>, caller: Address) -> Result<(), Error> {
    caller.require_auth();

    let key = DataKey::AutoShare(id);
    let details: AutoShareDetails = env
        .storage()
        .persistent()
        .get(&key)
        .ok_or(Error::NotFound)?;

    if details.creator != caller {
        return Err(Error::Unauthorized);
    }

    if !details.is_active {
        return Err(Error::GroupInactive);
    }

    if details.usage_count == 0 {
        return Err(Error::NoUsagesRemaining);
    }

    let mut updated = details;
    updated.usage_count -= 1;
    env.storage().persistent().set(&key, &updated);
    Ok(())
}

// ============================================================================
// Group Activation Management
// ============================================================================

pub fn update_members(
    env: Env,
    id: BytesN<32>,
    caller: Address,
    new_members: Vec<GroupMember>,
) -> Result<(), Error> {
    caller.require_auth();

    if get_paused_status(&env) {
        return Err(Error::ContractPaused);
    }

    let key = DataKey::AutoShare(id.clone());
    let mut details: AutoShareDetails = env
        .storage()
        .persistent()
        .get(&key)
        .ok_or(Error::NotFound)?;

    if details.creator != caller {
        publish_authorization_failure(&env, &caller, "update_members");
        return Err(Error::Unauthorized);
    }

    if !details.is_active {
        return Err(Error::GroupInactive);
    }

    // Validate new members
    if new_members.is_empty() {
        return Err(Error::EmptyMembers);
    }

    // Validate member count limit
    if new_members.len() > MAX_MEMBERS {
        return Err(Error::TooManyMembers);
    }

    let mut total_percentage: u32 = 0;
    let mut seen_addresses = Vec::new(&env);

    for member in new_members.iter() {
        total_percentage += member.percentage;

        for seen in seen_addresses.iter() {
            if seen == member.address {
                return Err(Error::DuplicateMember);
            }
        }
        seen_addresses.push_back(member.address.clone());
    }

    if total_percentage != 100 {
        return Err(Error::InvalidTotalPercentage);
    }

    // Update members in details (single write – no separate GroupMembers key)
    details.members = new_members.clone();
    env.storage().persistent().set(&key, &details);

    AutoshareUpdated {
        updater: caller,
        category: NotificationCategory::Group,
        priority: NotificationPriority::Medium,
        id: id.clone(),
    }
    .publish(&env);
    Ok(())
}

/// Deactivates a specific AutoShare group (channel), preventing further usage.
///
/// Callable by the channel's creator **or** the contract admin. Deactivating a
/// channel does not delete its members or payment history — those remain
/// fully readable via [`get_group_members`], [`get_user_payment_history`], and
/// [`get_group_payment_history`] — but [`topup_subscription`] (new
/// subscriptions) is blocked until the channel is reactivated.
pub fn deactivate_group(env: Env, id: BytesN<32>, caller: Address) -> Result<(), Error> {
    caller.require_auth();

    if get_paused_status(&env) {
        return Err(Error::ContractPaused);
    }

    let key = DataKey::AutoShare(id.clone());
    let mut details: AutoShareDetails = env
        .storage()
        .persistent()
        .get(&key)
        .ok_or(Error::NotFound)?;

    let admin = get_admin(env.clone()).ok();
    let is_creator = details.creator == caller;
    let is_admin = admin.as_ref().map_or(false, |a| *a == caller);

    if !is_creator && !is_admin {
        publish_authorization_failure(&env, &caller, "deactivate_group");
        return Err(Error::Unauthorized);
    }

    if !details.is_active {
        return Err(Error::GroupAlreadyInactive);
    }

    details.is_active = false;
    env.storage().persistent().set(&key, &details);

    GroupDeactivated {
        creator: caller,
        category: NotificationCategory::Group,
        priority: NotificationPriority::Low,
        id: id.clone(),
    }
    .publish(&env);
    Ok(())
}

/// Activates a previously deactivated AutoShare group.
pub fn activate_group(env: Env, id: BytesN<32>, caller: Address) -> Result<(), Error> {
    caller.require_auth();

    if get_paused_status(&env) {
        return Err(Error::ContractPaused);
    }

    let key = DataKey::AutoShare(id.clone());
    let mut details: AutoShareDetails = env
        .storage()
        .persistent()
        .get(&key)
        .ok_or(Error::NotFound)?;

    if details.creator != caller {
        publish_authorization_failure(&env, &caller, "activate_group");
        return Err(Error::Unauthorized);
    }

    if details.is_active {
        return Err(Error::GroupAlreadyActive);
    }

    details.is_active = true;
    env.storage().persistent().set(&key, &details);

    GroupActivated {
        creator: caller,
        category: NotificationCategory::Group,
        priority: NotificationPriority::Low,
        id: id.clone(),
    }
    .publish(&env);
    Ok(())
}

/// Checks if a specific AutoShare group is currently active.
pub fn is_group_active(env: Env, id: BytesN<32>) -> Result<bool, Error> {
    let key = DataKey::AutoShare(id);
    let details: AutoShareDetails = env
        .storage()
        .persistent()
        .get(&key)
        .ok_or(Error::NotFound)?;
    Ok(details.is_active)
}

pub fn get_contract_balance(env: Env, token: Address) -> i128 {
    let client = token::TokenClient::new(&env, &token);
    client.balance(&env.current_contract_address())
}

pub fn withdraw(
    env: Env,
    admin: Address,
    token: Address,
    amount: i128,
    recipient: Address,
) -> Result<(), Error> {
    admin.require_auth();
    require_admin(&env, &admin)?;

    if amount <= 0 {
        return Err(Error::InvalidAmount);
    }

    let contract_balance = get_contract_balance(env.clone(), token.clone());
    if contract_balance < amount {
        return Err(Error::InsufficientContractBalance);
    }

    let client = token::TokenClient::new(&env, &token);
    client.transfer(&env.current_contract_address(), &recipient, &amount);

    Withdrawal {
        token,
        recipient,
        category: NotificationCategory::Financial,
        priority: NotificationPriority::High,
        amount,
    }
    .publish(&env);
    Ok(())
}

fn validate_members(env: &Env, members: &Vec<GroupMember>) -> Result<(), Error> {
    if members.is_empty() {
        return Err(Error::EmptyMembers);
    }
    // Validate member count limit
    if members.len() > MAX_MEMBERS {
        return Err(Error::TooManyMembers);
    }
    let mut total_percentage: u32 = 0;
    let mut seen_addresses = Vec::new(env);

    for member in members.iter() {
        total_percentage += member.percentage;
        for seen in seen_addresses.iter() {
            if seen == member.address {
                return Err(Error::DuplicateMember);
            }
        }
        seen_addresses.push_back(member.address.clone());
    }

    if total_percentage != 100 {
        return Err(Error::InvalidTotalPercentage);
    }
    Ok(())
}

// ============================================================================
// Notification Scheduling & Expiration
// ============================================================================

/// Default priority attached to notification lifecycle events.
const NOTIFICATION_PRIORITY: NotificationPriority = NotificationPriority::Medium;

/// Maximum allowed notification lifetime, in seconds.
///
/// Notifications with a `ttl_seconds` value exceeding this constant are
/// rejected with [`Error::NotificationLifetimeTooLong`]. This prevents
/// notifications from being created with excessively long expiration periods
/// (issue #477).
///
/// **Placeholder value: 30 days (2_592_000 seconds).** Adjust this value in
/// review if a different maximum is required by the product specification.
const MAX_NOTIFICATION_LIFETIME_SECONDS: u64 = 30 * 24 * 60 * 60; // 30 days

/// Reads a scheduled notification from storage, if one is tracked for `id`.
fn load_notification(env: &Env, id: &BytesN<32>) -> Option<ScheduledNotification> {
    env.storage()
        .persistent()
        .get(&DataKey::ScheduledNotification(id.clone()))
}

/// Returns true if `notification` has reached or passed its expiry instant.
fn is_expired(env: &Env, notification: &ScheduledNotification) -> bool {
    env.ledger().timestamp() >= notification.expires_at
}

/// Returns true if a notification has been revoked.
fn is_revoked(notification: &ScheduledNotification) -> bool {
    notification.revoked_by.is_some()
}

/// Schedules a notification on-chain that becomes invalid after `ttl_seconds`.
///
/// The notification is stored with an `expires_at` of `now + ttl_seconds`. A
/// zero duration (or one that overflows the ledger clock) is rejected, as is a
/// duplicate identifier. Metadata is validated for consistency and length.
/// `priority` (High, Medium, or Low) determines the order in which off-chain
/// consumers should process and deliver the notification, and is stored
/// alongside it. Emits [`NotificationScheduled`] with the assigned priority.
///
/// # Errors
/// - `ContractPaused` if the contract is paused
/// - `InvalidExpirationDuration` if ttl_seconds is 0 or would overflow
/// - `AlreadyExists` if notification_id is already registered
/// - `InvalidInput` if metadata is malformed
pub fn schedule_notification(
    env: Env,
    notification_id: BytesN<32>,
    creator: Address,
    ttl_seconds: u64,
    title: String,
    priority: NotificationPriority,
) -> Result<(), Error> {
    creator.require_auth();

    if get_paused_status(&env) {
        return Err(Error::ContractPaused);
    }

    if !is_category_registered(env.clone(), NotificationCategory::Notification) {
        return Err(Error::CategoryNotRegistered);
    }

    if ttl_seconds == 0 {
        return Err(Error::InvalidExpirationDuration);
    }

    // Validate metadata (title is required; full metadata rules applied)
    let metadata = NotificationMetadata {
        title: title.clone(),
        description: None,
        data_uri: None,
        custom_fields: None,
    };
    validate_metadata(&metadata)?;
    // Reject lifetimes that exceed the protocol maximum (issue #477).
    if ttl_seconds > MAX_NOTIFICATION_LIFETIME_SECONDS {
        return Err(Error::NotificationLifetimeTooLong);
    }

    // Validate metadata (title is required)
    if title.is_empty() {
        return Err(Error::InvalidInput);
    }

    let key = DataKey::ScheduledNotification(notification_id.clone());
    if env.storage().persistent().has(&key) {
        return Err(Error::AlreadyExists);
    }

    let created_at = env.ledger().timestamp();
    let expires_at = created_at
        .checked_add(ttl_seconds)
        .ok_or(Error::InvalidExpirationDuration)?;

    let notification = ScheduledNotification {
        id: notification_id.clone(),
        creator: creator.clone(),
        priority,
        created_at,
        expires_at,
        revoked_by: None,
        revoked_at: None,
        delivered: false,
        delivered_at: None,
        recalled_by: None,
        recalled_at: None,
        title,
        version: CURRENT_NOTIFICATION_VERSION,
    };
    env.storage().persistent().set(&key, &notification);

    append_audit_record(
        &env,
        notification_id.clone(),
        AuditAction::Created,
        creator.clone(),
    );

    NotificationScheduled {
        creator,
        category: NotificationCategory::Notification,
        priority,
        notification_id,
        payload_version: CURRENT_NOTIFICATION_VERSION,
    }
    .publish(&env);

    Ok(())
}

/// Retrieves a scheduled notification. Returns [`Error::NotFound`] if no
/// notification is tracked for `notification_id` (including one already expired
/// and reaped via [`expire_notification`]).
pub fn get_notification(
    env: Env,
    notification_id: BytesN<32>,
) -> Result<ScheduledNotification, Error> {
    load_notification(&env, &notification_id).ok_or(Error::NotFound)
}

/// Returns whether a tracked notification has expired. Errors with
/// [`Error::NotFound`] if the notification is not tracked.
pub fn is_notification_expired(env: Env, notification_id: BytesN<32>) -> Result<bool, Error> {
    let notification = get_notification(env.clone(), notification_id)?;
    Ok(is_expired(&env, &notification))
}

/// Expires a notification whose lifetime has elapsed: removes it from storage
/// and emits [`NotificationExpired`].
///
/// Permissionless by design — any party (e.g. an off-chain keeper) may finalize
/// the expiry of an elapsed notification. A notification that has not yet
/// reached its expiry is rejected with [`Error::NotificationNotExpired`]; a
/// revoked notification with [`Error::NotificationRevoked`]; an unknown one
/// with [`Error::NotFound`].
pub fn expire_notification(env: Env, notification_id: BytesN<32>) -> Result<(), Error> {
    let key = DataKey::ScheduledNotification(notification_id.clone());
    let notification = load_notification(&env, &notification_id).ok_or(Error::NotFound)?;

    // Cannot expire a revoked notification
    if is_revoked(&notification) {
        return Err(Error::NotificationRevoked);
    }

    if !is_expired(&env, &notification) {
        return Err(Error::NotificationNotExpired);
    }

    env.storage().persistent().remove(&key);

    archive_notification(
        &env,
        &notification,
        String::from_str(&env, "expired"),
    );

    append_audit_record(
        &env,
        notification_id.clone(),
        AuditAction::Expired,
        env.current_contract_address(),
    );

    NotificationExpired {
        notification_id,
        category: NotificationCategory::Notification,
        priority: NOTIFICATION_PRIORITY,
        expires_at: notification.expires_at,
    }
    .publish(&env);

    Ok(())
}

/// Cancels a scheduled notification identified by `notification_id` and emits a
/// [`ScheduledNotificationCancelled`] event so off-chain consumers can track the
/// lifecycle of every scheduled notification in real time.
///
/// # Access Control
/// For on-chain **tracked** notifications (those currently stored), cancellation is
/// restricted to the notification **creator** or the contract **admin**. This prevents
/// a malicious third-party from arbitrarily cancelling another user's scheduled
/// notifications and removing their on-chain state.
///
/// Identifiers that are **not** tracked on-chain are still accepted (and simply emit
/// the event) so callers can signal cancellation of notifications managed entirely
/// off-chain — those entries have no on-chain state to destroy, so there is nothing
/// to gate.
///
/// If the notification is tracked on-chain, cancelling reaps its storage entry —
/// but an **expired** or **revoked** notification is invalid and cannot be cancelled; such an
/// attempt is rejected with [`Error::NotificationExpired`] or [`Error::NotificationRevoked`].
pub fn cancel_notification(
    env: Env,
    notification_id: BytesN<32>,
    caller: Address,
) -> Result<(), Error> {
    caller.require_auth();

    if get_paused_status(&env) {
        return Err(Error::ContractPaused);
    }

    if let Some(notification) = load_notification(&env, &notification_id) {
        if is_revoked(&notification) {
            return Err(Error::NotificationRevoked);
        }
        if is_expired(&env, &notification) {
            return Err(Error::NotificationExpired);
        }

        // ── Access control for tracked on-chain notifications ─────────────
        // Only the notification creator or the contract admin may remove
        // another party's stored notification. Without this check, any caller
        // could invoke cancel_notification repeatedly to wipe every group's
        // scheduled state.
        let admin = get_admin(env.clone()).ok();
        let is_creator = caller == notification.creator;
        let is_admin = admin.as_ref().map_or(false, |a| caller == *a);

        if !is_creator && !is_admin {
            publish_authorization_failure(&env, &caller, "cancel_notification");
            return Err(Error::Unauthorized);
        }

        env.storage()
            .persistent()
            .remove(&DataKey::ScheduledNotification(notification_id.clone()));
        archive_notification(
            &env,
            &notification,
            String::from_str(&env, "cancelled"),
        );
    }

    append_audit_record(
        &env,
        notification_id.clone(),
        AuditAction::Cancelled,
        caller.clone(),
    );

    ScheduledNotificationCancelled {
        caller,
        category: NotificationCategory::Notification,
        priority: NotificationPriority::Low,
        notification_id,
    }
    .publish(&env);

    Ok(())
}

// ============================================================================
// Batch Notification Creation
// ============================================================================

/// Maximum number of notifications that can be created in a single batch call.
const MAX_BATCH_SIZE: u32 = 50;

/// Creates multiple scheduled notifications in a single transaction.
///
/// Each `ids[i]` is paired with `ttl_seconds[i]`. Both slices must have the same
/// length and must not be empty. The length must not exceed [`MAX_BATCH_SIZE`].
/// The same validation applied by [`schedule_notification`] is applied to each
/// entry; if any entry fails the entire call is rejected.
///
/// A [`NotificationScheduled`] event is emitted for every created notification,
/// followed by a single [`BatchNotificationsCreated`] summary event carrying the
/// full list of ids and the count.
pub fn batch_schedule_notifications(
    env: Env,
    ids: Vec<BytesN<32>>,
    creator: Address,
    ttl_seconds: Vec<u64>,
    titles: Vec<String>,
    priorities: Vec<NotificationPriority>,
) -> Result<(), Error> {
    creator.require_auth();

    if get_paused_status(&env) {
        return Err(Error::ContractPaused);
    }

    if !is_category_registered(env.clone(), NotificationCategory::Notification) {
        return Err(Error::CategoryNotRegistered);
    }

    let count = ids.len();

    // Must have at least one notification.
    if count == 0 {
        return Err(Error::InvalidInput);
    }

    // Lengths must match.
    if count != ttl_seconds.len() || count != titles.len() || count != priorities.len() {
        return Err(Error::InvalidInput);
    }

    // Enforce maximum batch size.
    if count > MAX_BATCH_SIZE {
        return Err(Error::BatchTooLarge);
    }

    let created_at = env.ledger().timestamp();

    // Validate all entries before persisting any (all-or-nothing semantics).
    // Also track ids seen within this batch to catch intra-batch duplicates.
    let mut seen_in_batch: Vec<BytesN<32>> = Vec::new(&env);
    for i in 0..count {
        let ttl = ttl_seconds.get(i).unwrap();
        if ttl == 0 {
            return Err(Error::InvalidExpirationDuration);
        }
        // Reject lifetimes that exceed the protocol maximum (issue #477).
        if ttl > MAX_NOTIFICATION_LIFETIME_SECONDS {
            return Err(Error::NotificationLifetimeTooLong);
        }
        let id = ids.get(i).unwrap();
        let title = titles.get(i).unwrap();
        if title.is_empty() {
            return Err(Error::InvalidInput);
        }

        // Check for intra-batch duplicates.
        for seen in seen_in_batch.iter() {
            if seen == id {
                return Err(Error::AlreadyExists);
            }
        }
        seen_in_batch.push_back(id.clone());

        let key = DataKey::ScheduledNotification(id.clone());
        if env.storage().persistent().has(&key) {
            return Err(Error::AlreadyExists);
        }
        // Validate ttl doesn't overflow.
        created_at
            .checked_add(ttl)
            .ok_or(Error::InvalidExpirationDuration)?;
    }

    // Persist and emit per-notification events.
    for i in 0..count {
        let ttl = ttl_seconds.get(i).unwrap();
        let id = ids.get(i).unwrap();
        let title = titles.get(i).unwrap();
        let priority = priorities.get(i).unwrap();
        let expires_at = created_at + ttl;

        let metadata = NotificationMetadata {
            title: title.clone(),
            description: None,
            data_uri: None,
            custom_fields: None,
        };
        validate_metadata(&metadata)?;

        let notification = ScheduledNotification {
            id: id.clone(),
            creator: creator.clone(),
            priority,
            created_at,
            expires_at,
            revoked_by: None,
            revoked_at: None,
            delivered: false,
            delivered_at: None,
            recalled_by: None,
            recalled_at: None,
            title,
            version: CURRENT_NOTIFICATION_VERSION,
        };
        let key = DataKey::ScheduledNotification(id.clone());
        env.storage().persistent().set(&key, &notification);

        append_audit_record(&env, id.clone(), AuditAction::Created, creator.clone());

        NotificationScheduled {
            creator: creator.clone(),
            category: NotificationCategory::Notification,
            priority,
            notification_id: id.clone(),
            payload_version: CURRENT_NOTIFICATION_VERSION,
        }
        .publish(&env);
    }

    // Summary event.
    BatchNotificationsCreated {
        creator: creator.clone(),
        category: NotificationCategory::Notification,
        priority: NOTIFICATION_PRIORITY,
        count,
        ids,
    }
    .publish(&env);

    Ok(())
}

/// Revokes a scheduled notification, preventing any further interaction with it.
///
/// Only authorized callers (the notification creator or the contract admin) can
/// revoke a notification. The notification must exist, not already be revoked,
/// and not have expired. Once revoked, the notification state is updated to
/// record who revoked it and when, and a [`NotificationRevoked`] event is emitted.
///
/// Revoked notifications maintain their state for transparency and auditing:
/// they can still be queried but cannot be cancelled or expired.
pub fn confirm_notification_delivery(
    env: Env,
    notification_id: BytesN<32>,
    caller: Address,
) -> Result<(), Error> {
    caller.require_auth();

    if get_paused_status(&env) {
        return Err(Error::ContractPaused);
    }

    // Derive a deterministic idempotency key from the notification id and the
    // caller so that repeated submissions of the same delivery request are
    // recognised and short-circuited without creating duplicate deliveries.
    let idempotency_key = delivery_idempotency_key(&env, &notification_id, &caller);
    if is_delivery_recorded(&env, &idempotency_key) {
        return Err(Error::NotificationDelivered);
    }

    let key = DataKey::ScheduledNotification(notification_id.clone());
    let mut notification = load_notification(&env, &notification_id).ok_or(Error::NotFound)?;

    if is_revoked(&notification) {
        return Err(Error::NotificationRevoked);
    }

    if is_expired(&env, &notification) {
        return Err(Error::NotificationExpired);
    }

    if notification.delivered {
        return Err(Error::NotificationDelivered);
    }

    let admin = get_admin(env.clone()).ok();
    let is_creator = caller == notification.creator;
    let is_admin = admin.as_ref().map_or(false, |a| caller == *a);

    if !is_creator && !is_admin {
        return Err(Error::Unauthorized);
    }

    let delivered_at = env.ledger().timestamp();
    notification.delivered = true;
    notification.delivered_at = Some(delivered_at);

    env.storage().persistent().set(&key, &notification);

    // Persist the idempotency record before emitting the event so that a
    // concurrent duplicate request observes the recorded state and is rejected.
    record_delivery_idempotency(&env, &idempotency_key, &notification_id, &caller);

    NotificationDelivered {
        notification_id: notification_id.clone(),
        delivered_by: caller,
        category: NotificationCategory::Notification,
        priority: NotificationPriority::High,
        delivered_at,
    }
    .publish(&env);

    // Move delivered notifications into the archive to keep active storage lean.
    env.storage().persistent().remove(&key);
    archive_notification(
        &env,
        &notification,
        String::from_str(&env, "delivered"),
    );

    Ok(())
}

// ============================================================================
// Notification Delivery Idempotency
// ============================================================================

/// Derives a deterministic idempotency key for a delivery request from the
/// notification identifier and the caller address.
fn delivery_idempotency_key(
    env: &Env,
    notification_id: &BytesN<32>,
    caller: &Address,
) -> BytesN<32> {
    let mut raw = [0u8; 32];
    let id_bytes = notification_id.to_array();
    for i in 0..32 {
        raw[i] = id_bytes[i];
    }
    // Mix in a per-caller counter so distinct callers get distinct keys while
    // the same caller + notification pair always maps to the same key.
    let seq: u64 = env
        .storage()
        .instance()
        .get(&INSTANCE_DELIVERY_SEQ)
        .unwrap_or(0u64);
    let seq_bytes = seq.to_be_bytes();
    for i in 0..8 {
        raw[i] ^= seq_bytes[i];
    }
    BytesN::from_array(env, &raw)
}

/// Returns true if a delivery has already been recorded for `key`.
fn is_delivery_recorded(env: &Env, key: &BytesN<32>) -> bool {
    env.storage()
        .persistent()
        .has(&DataKey::DeliveryIdempotency(key.clone()))
}

/// Persists an idempotency record for a completed delivery and bumps the
/// instance-storage sequence counter used to derive future keys.
fn record_delivery_idempotency(
    env: &Env,
    key: &BytesN<32>,
    notification_id: &BytesN<32>,
    caller: &Address,
) {
    let seq: u64 = env
        .storage()
        .instance()
        .get(&INSTANCE_DELIVERY_SEQ)
        .unwrap_or(0u64)
        + 1;
    env.storage().instance().set(&INSTANCE_DELIVERY_SEQ, &seq);

    env.storage()
        .persistent()
        .set(&DataKey::DeliveryIdempotency(key.clone()), &true);

    // Keep the notification id and caller discoverable for auditing.
    let _ = (notification_id, caller);
}

pub fn recall_notification(
    env: Env,
    notification_id: BytesN<32>,
    caller: Address,
) -> Result<(), Error> {
    caller.require_auth();

    if get_paused_status(&env) {
        return Err(Error::ContractPaused);
    }

    let key = DataKey::ScheduledNotification(notification_id.clone());
    let mut notification = load_notification(&env, &notification_id).ok_or(Error::NotFound)?;

    if is_revoked(&notification) {
        return Err(Error::NotificationRevoked);
    }

    if is_expired(&env, &notification) {
        return Err(Error::NotificationExpired);
    }

    if notification.delivered {
        return Err(Error::NotificationDelivered);
    }

    let admin = get_admin(env.clone()).ok();
    let is_creator = caller == notification.creator;
    let is_admin = admin.as_ref().map_or(false, |a| caller == *a);

    if !is_creator && !is_admin {
        return Err(Error::Unauthorized);
    }

    let recalled_at = env.ledger().timestamp();
    notification.recalled_by = Some(caller.clone());
    notification.recalled_at = Some(recalled_at);

    env.storage().persistent().set(&key, &notification);

    NotificationRecalled {
        notification_id,
        recalled_by: caller,
        category: NotificationCategory::Notification,
        priority: NotificationPriority::High,
        recalled_at,
    }
    .publish(&env);

    Ok(())
}

pub fn revoke_notification(
    env: Env,
    notification_id: BytesN<32>,
    caller: Address,
) -> Result<(), Error> {
    caller.require_auth();

    if get_paused_status(&env) {
        return Err(Error::ContractPaused);
    }

    let key = DataKey::ScheduledNotification(notification_id.clone());
    let mut notification = load_notification(&env, &notification_id).ok_or(Error::NotFound)?;

    // Check if already revoked
    if is_revoked(&notification) {
        return Err(Error::AlreadyRevoked);
    }

    // Check if expired (cannot revoke expired notifications)
    if is_expired(&env, &notification) {
        return Err(Error::NotificationExpired);
    }

    // Check authorization: only creator or admin can revoke
    let admin = get_admin(env.clone()).ok();
    let is_creator = caller == notification.creator;
    let is_admin = admin.as_ref().map_or(false, |a| caller == *a);

    if !is_creator && !is_admin {
        publish_authorization_failure(&env, &caller, "revoke_notification");
        return Err(Error::NotAuthorizedToRevoke);
    }

    // Update notification with revocation data
    let revoked_at = env.ledger().timestamp();
    notification.revoked_by = Some(caller.clone());
    notification.revoked_at = Some(revoked_at);

    // Store updated notification
    env.storage().persistent().set(&key, &notification);

    // Emit revocation event
    NotificationRevoked {
        notification_id,
        revoked_by: caller,
        category: NotificationCategory::Notification,
        priority: NotificationPriority::High,
    }
    .publish(&env);

    Ok(())
}

// ============================================================================
// Audit Logging
// ============================================================================

/// Appends an immutable [`AuditRecord`] to the on-chain audit log and emits an
/// [`AuditRecordAppended`] event. The sequence number is auto-incremented.
fn append_audit_record(
    env: &Env,
    notification_id: BytesN<32>,
    action: AuditAction,
    actor: Address,
) {
    // Increment sequence counter.
    let seq_key = DataKey::AuditSeq;
    let seq: u64 = env.storage().instance().get(&seq_key).unwrap_or(0u64) + 1;
    env.storage().instance().set(&seq_key, &seq);

    let timestamp = env.ledger().timestamp();

    let record = AuditRecord {
        seq,
        notification_id: notification_id.clone(),
        action,
        actor: actor.clone(),
        timestamp,
    };

    // Append to the full log (used for full-scan / range queries).
    let log_key = DataKey::AuditLog;
    let mut log: Vec<AuditRecord> = env
        .storage()
        .persistent()
        .get(&log_key)
        .unwrap_or(Vec::new(env));
    log.push_back(record);
    env.storage().persistent().set(&log_key, &log);

    AuditRecordAppended {
        notification_id,
        action,
        category: NotificationCategory::Notification,
        seq,
        actor,
    }
    .publish(env);
}

/// Returns all audit records in creation order.
///
/// Records are immutable and append-only; this list can only grow over time.
pub fn get_audit_log(env: Env) -> Vec<AuditRecord> {
    env.storage()
        .persistent()
        .get(&DataKey::AuditLog)
        .unwrap_or(Vec::new(&env))
}

/// Returns all audit records for a specific notification identifier.
pub fn get_audit_records_for_notification(
    env: Env,
    notification_id: BytesN<32>,
) -> Vec<AuditRecord> {
    let log: Vec<AuditRecord> = env
        .storage()
        .persistent()
        .get(&DataKey::AuditLog)
        .unwrap_or(Vec::new(&env));

    let mut result: Vec<AuditRecord> = Vec::new(&env);
    for record in log.iter() {
        if record.notification_id == notification_id {
            result.push_back(record);
        }
    }
    result
}

/// Records a delivery attempt for a notification in the audit log.
///
/// This is a permissionless write so any authorised service (an off-chain
/// relay, a keeper) can record that it attempted delivery.
pub fn record_delivery_attempt(
    env: Env,
    notification_id: BytesN<32>,
    actor: Address,
) -> Result<(), Error> {
    actor.require_auth();

    if get_paused_status(&env) {
        return Err(Error::ContractPaused);
    }

    append_audit_record(&env, notification_id, AuditAction::DeliveryAttempt, actor);
    Ok(())
}

/// Records a delivery failure for a notification in the audit log.
pub fn record_delivery_failure(
    env: Env,
    notification_id: BytesN<32>,
    actor: Address,
) -> Result<(), Error> {
    actor.require_auth();

    if get_paused_status(&env) {
        return Err(Error::ContractPaused);
    }

    append_audit_record(&env, notification_id, AuditAction::DeliveryFailed, actor);
    Ok(())
}

/// Records that the recipient acknowledged a notification.
pub fn record_acknowledgment(
    env: Env,
    notification_id: BytesN<32>,
    actor: Address,
) -> Result<(), Error> {
    actor.require_auth();

    if get_paused_status(&env) {
        return Err(Error::ContractPaused);
    }

    append_audit_record(&env, notification_id, AuditAction::Acknowledged, actor);
    Ok(())
}

/// Checks if a notification has been revoked.
///
/// Returns [`Error::NotFound`] if the notification is not tracked.
pub fn is_notification_revoked(env: Env, notification_id: BytesN<32>) -> Result<bool, Error> {
    let notification = get_notification(env, notification_id)?;
    Ok(is_revoked(&notification))
}

/// Acknowledges multiple scheduled notifications in a single batch.
///
/// Only the creator of the notification can acknowledge it. The notification
/// must exist, not be revoked, and not be expired.
/// Emits a [`NotificationAcknowledged`] event for each valid notification.
pub fn acknowledge_notifications(
    env: Env,
    caller: Address,
    notification_ids: Vec<BytesN<32>>,
) -> Result<(), Error> {
    caller.require_auth();

    if get_paused_status(&env) {
        return Err(Error::ContractPaused);
    }

    let timestamp = env.ledger().timestamp();

    for id in notification_ids.iter() {
        let notification = load_notification(&env, &id).ok_or(Error::NotFound)?;

        if notification.creator != caller {
            return Err(Error::NotAuthorizedToAcknowledge);
        }

        if is_revoked(&notification) {
            return Err(Error::NotificationRevoked);
        }

        if is_expired(&env, &notification) {
            return Err(Error::NotificationExpired);
        }

        NotificationAcknowledged {
            notification_id: id,
            acknowledger: caller.clone(),
            category: NotificationCategory::Notification,
            priority: NOTIFICATION_PRIORITY,
            timestamp,
        }
        .publish(&env);
    }

    Ok(())
}

/// Emits a `BatchProcessingCompleted` event for off-chain consumers.
pub fn emit_batch_completed(
    env: Env,
    batch_id: BytesN<32>,
    processed_count: u32,
) -> Result<(), Error> {
    BatchProcessingCompleted {
        batch_id,
        category: NotificationCategory::Notification,
        priority: NotificationPriority::Medium,
        processed_count,
    }
    .publish(&env);
    Ok(())
}

/// Extends the expiration period of a scheduled notification by `extension_seconds`.
///
/// Only authorized callers (the notification creator or the contract admin) can
/// extend a notification. The notification must exist, not already be revoked,
/// and not have expired. Emits a [`NotificationExtended`] event.
pub fn extend_notification_expiry(
    env: Env,
    notification_id: BytesN<32>,
    caller: Address,
    extension_seconds: u64,
) -> Result<(), Error> {
    caller.require_auth();

    if get_paused_status(&env) {
        return Err(Error::ContractPaused);
    }

    if extension_seconds == 0 {
        return Err(Error::InvalidExpirationDuration);
    }

    let key = DataKey::ScheduledNotification(notification_id.clone());
    let mut notification = load_notification(&env, &notification_id).ok_or(Error::NotFound)?;

    // Check if revoked
    if is_revoked(&notification) {
        return Err(Error::NotificationRevoked);
    }

    // Check if expired
    if is_expired(&env, &notification) {
        return Err(Error::NotificationExpired);
    }

    // Check authorization: only creator or admin can extend
    let admin = get_admin(env.clone()).ok();
    let is_creator = caller == notification.creator;
    let is_admin = admin.as_ref().map_or(false, |a| caller == *a);

    if !is_creator && !is_admin {
        return Err(Error::Unauthorized);
    }

    // Update expires_at
    let new_expires_at = notification
        .expires_at
        .checked_add(extension_seconds)
        .ok_or(Error::InvalidExpirationDuration)?;

    // Ensure the total lifetime from creation does not exceed the protocol
    // maximum (issue #477). We compare the new expiry against created_at so
    // that the same ceiling applies to extensions as to initial scheduling.
    let new_total_lifetime = new_expires_at.saturating_sub(notification.created_at);
    if new_total_lifetime > MAX_NOTIFICATION_LIFETIME_SECONDS {
        return Err(Error::NotificationLifetimeTooLong);
    }

    notification.expires_at = new_expires_at;

    // Store updated notification
    env.storage().persistent().set(&key, &notification);

    // Emit extension event
    NotificationExtended {
        notification_id,
        caller,
        category: NotificationCategory::Notification,
        priority: NOTIFICATION_PRIORITY,
        new_expires_at,
    }
    .publish(&env);

    Ok(())
}

// ============================================================================
// Notification Limits Configuration
// ============================================================================

/// Configures protocol-level notification limits. Only admin can call.
/// Validates that min expiration is less than max expiration.
/// Emits a `NotificationLimitsConfigured` event on success.
pub fn configure_notification_limits(
    env: Env,
    admin: Address,
    max_payload_size: u32,
    max_expiration_seconds: u64,
    min_expiration_seconds: u64,
    max_batch_size: u32,
) -> Result<(), Error> {
    admin.require_auth();
    require_admin(&env, &admin)?;

    // Verify caller is admin
    let current_admin = get_admin(env.clone())?;
    if admin != current_admin {
        AuthorizationFailure {
            caller: admin,
            category: NotificationCategory::Admin,
            priority: NotificationPriority::Critical,
            action: String::from_str(&env, "configure_notification_limits"),
        }
        .publish(&env);
        return Err(Error::Unauthorized);
    }

    // Validate that min <= max expiration
    if min_expiration_seconds > max_expiration_seconds {
        return Err(Error::InvalidExpirationDuration);
    }

    // Validate that batch size is at least 1
    if max_batch_size == 0 {
        return Err(Error::InvalidLimit);
    }

    // Validate that payload size is at least 1 byte
    if max_payload_size == 0 {
        return Err(Error::InvalidLimit);
    }

    let limits = NotificationLimits {
        max_payload_size,
        max_expiration_seconds,
        min_expiration_seconds,
        max_batch_size,
    };

    // Store in persistent storage
    let key = DataKey::NotificationLimits;
    env.storage().persistent().set(&key, &limits);

    // Emit configuration event
    NotificationLimitsConfigured {
        admin,
        category: NotificationCategory::Admin,
        priority: NotificationPriority::Medium,
        max_payload_size,
        max_expiration_seconds,
        min_expiration_seconds,
        max_batch_size,
    }
    .publish(&env);

    Ok(())
}

/// Retrieves the current notification limits.
/// Returns default limits if none have been configured.
pub fn get_notification_limits(env: Env) -> NotificationLimits {
    let key = DataKey::NotificationLimits;

    env.storage()
        .persistent()
        .get::<DataKey, NotificationLimits>(&key)
        .unwrap_or(NotificationLimits {
            max_payload_size: 10_000,
            max_expiration_seconds: 365 * 24 * 60 * 60, // 1 year
            min_expiration_seconds: 60,                 // 1 minute
            max_batch_size: 1000,
        })
}

// ============================================================================
// Schema Version Tracking  (Issue #309)
// ============================================================================

/// The minimum schema version this contract supports.
const MIN_SUPPORTED_SCHEMA_VERSION: u32 = 1;
/// The maximum (current) schema version this contract supports.
const MAX_SUPPORTED_SCHEMA_VERSION: u32 = 1;

/// Sets the on-chain notification schema version. Only the admin can call this.
///
/// Emits a [`SchemaVersionSet`] event so off-chain consumers can detect protocol
/// upgrades and reject payloads whose version they cannot handle.
///
/// # Errors
/// - [`Error::Unauthorized`]  – caller is not the admin.
/// - [`Error::InvalidInput`]  – `schema_version` is outside the supported range.
pub fn set_schema_version(env: Env, admin: Address, schema_version: u32) -> Result<(), Error> {
    admin.require_auth();

    let stored_admin = get_admin(env.clone())?;
    if admin != stored_admin {
        return Err(Error::Unauthorized);
    }

    if schema_version < MIN_SUPPORTED_SCHEMA_VERSION
        || schema_version > MAX_SUPPORTED_SCHEMA_VERSION
    {
        return Err(Error::InvalidInput);
    }

    let key = DataKey::SchemaVersion;
    let previous_version: u32 = env
        .storage()
        .persistent()
        .get::<DataKey, u32>(&key)
        .unwrap_or(0);

    env.storage().persistent().set(&key, &schema_version);

    SchemaVersionSet {
        admin,
        category: NotificationCategory::Admin,
        priority: NotificationPriority::Medium,
        schema_version,
        previous_version,
    }
    .publish(&env);

    Ok(())
}

/// Returns the current on-chain schema version (0 if never set).
pub fn get_schema_version(env: Env) -> u32 {
    env.storage()
        .persistent()
        .get::<DataKey, u32>(&DataKey::SchemaVersion)
        .unwrap_or(0)
}

/// Returns whether `version` is within the supported range.
pub fn is_version_supported(_env: Env, version: u32) -> bool {
    version >= MIN_SUPPORTED_SCHEMA_VERSION && version <= MAX_SUPPORTED_SCHEMA_VERSION
}

// ============================================================================
// Access Logging  (Issue #312)
// ============================================================================

/// Emits a [`NotificationAccessed`] event for the given notification.
///
/// Call this whenever a protected notification record is read so that
/// off-chain indexers can build an immutable access trail for compliance.
pub fn record_notification_access(
    env: Env,
    notification_id: BytesN<32>,
    accessor: Address,
) -> Result<(), Error> {
    // Verify the notification exists.
    let key = DataKey::ScheduledNotification(notification_id.clone());
    if !env.storage().persistent().has(&key) {
        return Err(Error::NotFound);
    }

    NotificationAccessed {
        notification_id,
        accessor,
        category: NotificationCategory::Notification,
        accessed_at: env.ledger().timestamp(),
    }
    .publish(&env);

    Ok(())
}

// ============================================================================
// Channel Metadata Updates
// ============================================================================

/// Maximum length for a channel description string.
const MAX_CHANNEL_DESCRIPTION_LENGTH: u32 = 256;
/// Maximum number of custom metadata fields on a channel.
const MAX_CHANNEL_CUSTOM_FIELDS: u32 = 20;

/// Updates the description and custom metadata for an AutoShare channel.
///
/// Only the channel creator (group owner) may update metadata. Membership,
/// usage counts, and other subscriber state are never modified.
///
/// # Errors
/// - `NotFound` if the channel / group does not exist
/// - `Unauthorized` if `caller` is not the creator
/// - `ContractPaused` if the contract is paused
/// - `InvalidInput` if description or custom fields fail validation
pub fn update_channel_metadata(
    env: Env,
    channel_id: BytesN<32>,
    caller: Address,
    description: String,
    custom_fields: Map<String, String>,
) -> Result<(), Error> {
    caller.require_auth();

    if get_paused_status(&env) {
        return Err(Error::ContractPaused);
    }

    let group = get_autoshare(env.clone(), channel_id.clone())?;
    if caller != group.creator {
        return Err(Error::Unauthorized);
    }

    if description.len() > MAX_CHANNEL_DESCRIPTION_LENGTH {
        return Err(Error::InvalidInput);
    }

    if custom_fields.len() > MAX_CHANNEL_CUSTOM_FIELDS {
        return Err(Error::InvalidInput);
    }

    for key in custom_fields.keys() {
        if key.len() > 256 {
            return Err(Error::InvalidInput);
        }
        if let Some(value) = custom_fields.get(key.clone()) {
            if value.len() > 256 {
                return Err(Error::InvalidInput);
            }
        }
    }

    // Validate via shared metadata rules when a non-empty description is provided.
    let meta = NotificationMetadata {
        title: if description.is_empty() {
            String::from_str(&env, "channel")
        } else {
            description.clone()
        },
        description: Some(description.clone()),
        data_uri: None,
        custom_fields: Some(custom_fields.clone()),
    };
    validate_metadata(&meta)?;

    let updated_at = env.ledger().timestamp();
    let metadata = ChannelMetadata {
        channel_id: channel_id.clone(),
        description,
        custom_fields,
        updated_at,
    };

    env.storage()
        .persistent()
        .set(&DataKey::ChannelMetadata(channel_id.clone()), &metadata);

    ChannelMetadataUpdated {
        channel_id,
        updater: caller,
        category: NotificationCategory::Group,
        priority: NotificationPriority::Low,
        updated_at,
    }
    .publish(&env);

    Ok(())
}

/// Returns channel metadata for `channel_id`, or a default empty record if never set.
pub fn get_channel_metadata(env: Env, channel_id: BytesN<32>) -> Result<ChannelMetadata, Error> {
    // Ensure the channel exists.
    let _group = get_autoshare(env.clone(), channel_id.clone())?;

    if let Some(meta) = env
        .storage()
        .persistent()
        .get::<DataKey, ChannelMetadata>(&DataKey::ChannelMetadata(channel_id.clone()))
    {
        return Ok(meta);
    }

    Ok(ChannelMetadata {
        channel_id,
        description: String::from_str(&env, ""),
        custom_fields: Map::new(&env),
        updated_at: 0,
    })
}

// ============================================================================
// Notification Archiving
// ============================================================================

/// Moves a processed notification into immutable archive storage and emits
/// [`NotificationArchived`]. Active storage must already have been cleared by
/// the caller.
fn archive_notification(env: &Env, notification: &ScheduledNotification, reason: String) {
    let archived_at = env.ledger().timestamp();
    let archived = ArchivedNotification {
        id: notification.id.clone(),
        creator: notification.creator.clone(),
        created_at: notification.created_at,
        expires_at: notification.expires_at,
        title: notification.title.clone(),
        version: notification.version,
        archived_at,
        archive_reason: reason.clone(),
    };

    env.storage().persistent().set(
        &DataKey::ArchivedNotification(notification.id.clone()),
        &archived,
    );

    NotificationArchived {
        notification_id: notification.id.clone(),
        category: NotificationCategory::Notification,
        priority: NotificationPriority::Low,
        archived_at,
        archive_reason: reason,
    }
    .publish(env);
}

/// Returns an archived notification by id.
pub fn get_archived_notification(
    env: Env,
    notification_id: BytesN<32>,
) -> Result<ArchivedNotification, Error> {
    env.storage()
        .persistent()
        .get(&DataKey::ArchivedNotification(notification_id))
        .ok_or(Error::NotFound)
}

/// Returns the current notification protocol version constant.
pub fn get_notification_version(_env: Env) -> u32 {
    CURRENT_NOTIFICATION_VERSION
}
