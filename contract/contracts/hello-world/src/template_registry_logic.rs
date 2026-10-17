/// Template Registry Logic — Issue #352
///
/// Provides register/update/query operations for reusable notification templates.
/// Templates are stored in persistent storage keyed by a caller-supplied
/// `BytesN<32>` ID.  Only the original owner (creator) of a template may update
/// it.  Attempting to reference a non-existent template ID reverts with a clear
/// error.
use crate::base::errors::Error;
use crate::base::events::{
    AuthorizationFailure, NotificationCategory, NotificationPriority, TemplateRegistered,
    TemplateUpdated,
};
use crate::base::types::NotificationTemplate;
use soroban_sdk::{contracttype, Address, BytesN, Env, String};

// ============================================================================
// Limits
// ============================================================================

/// Maximum allowed byte-length for a template name.
const MAX_TEMPLATE_NAME_LEN: u32 = 100;

// ============================================================================
// Storage keys
// ============================================================================

/// Persistent-storage key variants used by the template registry.
///
/// Keys are separate from `DataKey` in `autoshare_logic` to avoid the two
/// enums merging into a single namespace and to keep each module's storage
/// footprint explicit.  Both enums live in persistent storage and are
/// distinguished by their variant discriminant at the serialisation layer.
#[contracttype]
pub enum TemplateKey {
    /// Full `NotificationTemplate` record keyed by template ID.
    Template(BytesN<32>),
}

// ============================================================================
// Public API
// ============================================================================

/// Register a new notification template on-chain.
///
/// The caller becomes the owner of the template and is the only address
/// authorised to update it in the future.
///
/// # Arguments
/// * `id`      – caller-chosen unique identifier; reverts with `AlreadyExists`
///               if it is already taken.
/// * `creator` – address that will own the template (must authorise the call).
/// * `name`    – human-readable label (max 100 bytes); reverts with
///               `TemplateNameTooLong` if exceeded.
/// * `content` – notification payload/body; must not be empty, reverts with
///               `TemplateContentEmpty` otherwise.
///
/// # Errors
/// - `AlreadyExists`        – a template with this `id` is already registered.
/// - `TemplateNameTooLong`  – `name` exceeds `MAX_TEMPLATE_NAME_LEN` bytes.
/// - `TemplateContentEmpty` – `content` is an empty string.
///
/// # Events
/// Emits [`TemplateRegistered`] on success.
pub fn register_template(
    env: Env,
    id: BytesN<32>,
    creator: Address,
    name: String,
    content: String,
) -> Result<(), Error> {
    creator.require_auth();

    let key = TemplateKey::Template(id.clone());

    // Prevent overwriting an existing template.
    if env.storage().persistent().has(&key) {
        return Err(Error::AlreadyExists);
    }

    validate_name(&name)?;
    validate_content(&content)?;

    let template = NotificationTemplate {
        id: id.clone(),
        owner: creator.clone(),
        name,
        content,
        created_at: env.ledger().timestamp(),
        updated_at: None,
    };

    env.storage().persistent().set(&key, &template);

    TemplateRegistered {
        owner: creator,
        category: NotificationCategory::Notification,
        priority: NotificationPriority::Medium,
        template_id: id,
    }
    .publish(&env);

    Ok(())
}

/// Update the `name` and/or `content` of an existing template.
///
/// Only the original owner of the template is permitted to call this function.
/// Any other caller reverts with `Unauthorized`.
///
/// # Arguments
/// * `id`     – identifier of the template to update.
/// * `caller` – must match the template's stored `owner`; must authorise the call.
/// * `name`   – replacement name (max 100 bytes).
/// * `content`– replacement content; must not be empty.
///
/// # Errors
/// - `TemplateNotFound`     – no template is registered under `id`.
/// - `Unauthorized`         – `caller` is not the template owner.
/// - `TemplateNameTooLong`  – replacement `name` exceeds `MAX_TEMPLATE_NAME_LEN`.
/// - `TemplateContentEmpty` – replacement `content` is empty.
///
/// # Events
/// Emits [`TemplateUpdated`] on success.
pub fn update_template(
    env: Env,
    id: BytesN<32>,
    caller: Address,
    name: String,
    content: String,
) -> Result<(), Error> {
    caller.require_auth();

    let key = TemplateKey::Template(id.clone());

    let mut template: NotificationTemplate = env
        .storage()
        .persistent()
        .get(&key)
        .ok_or(Error::TemplateNotFound)?;

    // Only the original owner may update.
    if template.owner != caller {
        publish_authorization_failure(&env, &caller, "update_template");
        return Err(Error::Unauthorized);
    }

    validate_name(&name)?;
    validate_content(&content)?;

    template.name = name;
    template.content = content;
    template.updated_at = Some(env.ledger().timestamp());

    env.storage().persistent().set(&key, &template);

    TemplateUpdated {
        owner: caller,
        category: NotificationCategory::Notification,
        priority: NotificationPriority::Medium,
        template_id: id,
    }
    .publish(&env);

    Ok(())
}

/// Return the full record for a registered template.
///
/// # Errors
/// - `TemplateNotFound` – no template is registered under `id`.
pub fn get_template(env: Env, id: BytesN<32>) -> Result<NotificationTemplate, Error> {
    let key = TemplateKey::Template(id);
    env.storage()
        .persistent()
        .get(&key)
        .ok_or(Error::TemplateNotFound)
}

/// Return `true` if a template with the given `id` exists, `false` otherwise.
///
/// This is a pure view function and never reverts.
pub fn template_exists(env: Env, id: BytesN<32>) -> bool {
    let key = TemplateKey::Template(id);
    env.storage().persistent().has(&key)
}

// ============================================================================
// Validation helpers
// ============================================================================

fn validate_name(name: &String) -> Result<(), Error> {
    if name.len() > MAX_TEMPLATE_NAME_LEN {
        return Err(Error::TemplateNameTooLong);
    }
    Ok(())
}

fn validate_content(content: &String) -> Result<(), Error> {
    if content.len() == 0 {
        return Err(Error::TemplateContentEmpty);
    }
    Ok(())
}

// ============================================================================
// Auth helpers
// ============================================================================

fn publish_authorization_failure(env: &Env, caller: &Address, action: &str) {
    AuthorizationFailure {
        caller: caller.clone(),
        category: NotificationCategory::Admin,
        priority: NotificationPriority::Critical,
        action: String::from_str(env, action),
    }
    .publish(env);
}
