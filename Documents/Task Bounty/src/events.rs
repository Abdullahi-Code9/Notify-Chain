use crate::types::{ApiCredential, ApiCredentialRotation, Task};
use soroban_sdk::{symbol_short, Address, Env, String};

/// Emit TaskCreated event
pub fn emit_task_created(env: &Env, task: &Task) {
    env.events().publish(
        (symbol_short!("task"), symbol_short!("created")),
        (
            task.id,
            task.poster.clone(),
            task.title.clone(),
            task.reward,
            task.deadline,
        ),
    );
}

/// Emit WorkSubmitted event
pub fn emit_work_submitted(
    env: &Env,
    task_id: u64,
    submission_id: u64,
    contributor: &Address,
    work_url: &String,
) {
    env.events().publish(
        (symbol_short!("work"), symbol_short!("submit")),
        (task_id, submission_id, contributor.clone(), work_url.clone()),
    );
}

/// Emit SubmissionApproved event
pub fn emit_submission_approved(
    env: &Env,
    task_id: u64,
    submission_id: u64,
    contributor: &Address,
    reward: i128,
) {
    env.events().publish(
        (symbol_short!("sub"), symbol_short!("approved")),
        (task_id, submission_id, contributor.clone(), reward),
    );
}

/// Emit SubmissionRejected event
pub fn emit_submission_rejected(
    env: &Env,
    task_id: u64,
    submission_id: u64,
    contributor: &Address,
) {
    env.events().publish(
        (symbol_short!("sub"), symbol_short!("rejected")),
        (task_id, submission_id, contributor.clone()),
    );
}

/// Emit TaskCancelled event
pub fn emit_task_cancelled(env: &Env, task_id: u64, poster: &Address) {
    env.events().publish(
        (symbol_short!("task"), symbol_short!("cancel")),
        (task_id, poster.clone()),
    );
}

/// Emit DisputeRaised event
pub fn emit_dispute_raised(
    env: &Env,
    task_id: u64,
    submission_id: u64,
    raiser: &Address,
    reason: &String,
    resolution_deadline: u64,
) {
    env.events().publish(
        (symbol_short!("disp"), symbol_short!("raised")),
        (
            task_id,
            submission_id,
            raiser.clone(),
            reason.clone(),
            resolution_deadline,
        ),
    );
}

/// Emit DisputeResolved event
pub fn emit_dispute_resolved(
    env: &Env,
    dispute_id: u64,
    task_id: u64,
    submission_id: u64,
    resolver: &Address,
    ruling: &String,
) {
    env.events().publish(
        (symbol_short!("disp"), symbol_short!("resolved")),
        (
            dispute_id,
            task_id,
            submission_id,
            resolver.clone(),
            ruling.clone(),
        ),
    );
}

/// Emit DisputeEscalated event — fired when the resolution deadline expires
/// and an authorized party triggers escalation.
pub fn emit_dispute_escalated(
    env: &Env,
    dispute_id: u64,
    task_id: u64,
    submission_id: u64,
    escalated_by: &Address,
    resolution_deadline: u64,
) {
    env.events().publish(
        (symbol_short!("disp"), symbol_short!("escalatd")),
        (
            dispute_id,
            task_id,
            submission_id,
            escalated_by.clone(),
            resolution_deadline,
        ),
    );
}

/// Emit ApiKeyRegistered event
pub fn emit_api_key_registered(env: &Env, credential: &ApiCredential) {
    env.events().publish(
        (symbol_short!("api"), symbol_short!("register")),
        (
            credential.organization.clone(),
            credential.id,
            credential.label.clone(),
            credential.fingerprint.clone(),
        ),
    );
}

/// Emit ApiKeyRotated event
pub fn emit_api_key_rotated(env: &Env, rotation: &ApiCredentialRotation) {
    env.events().publish(
        (symbol_short!("api"), symbol_short!("rotate")),
        (
            rotation.organization.clone(),
            rotation.old_credential_id,
            rotation.new_credential_id,
            rotation.actor.clone(),
            rotation.reason.clone(),
        ),
    );
}

/// Emit ApiKeyRevoked event
pub fn emit_api_key_revoked(env: &Env, organization: &Address, credential_id: u64) {
    env.events().publish(
        (symbol_short!("api"), symbol_short!("revoke")),
        (organization.clone(), credential_id),
    );
}

/// Emit AdminTransferProposed event
pub fn emit_admin_transfer_proposed(env: &Env, current_admin: &Address, proposed_admin: &Address) {
    env.events().publish(
        (symbol_short!("admin"), symbol_short!("proposed")),
        (current_admin.clone(), proposed_admin.clone()),
    );
}

/// Emit AdminTransferAccepted event
pub fn emit_admin_transfer_accepted(env: &Env, new_admin: &Address) {
    env.events().publish(
        (symbol_short!("admin"), symbol_short!("accepted")),
        new_admin.clone(),
    );
}

/// Emit AdminTransferCancelled event
pub fn emit_admin_transfer_cancelled(env: &Env, admin: &Address) {
    env.events().publish(
        (symbol_short!("admin"), symbol_short!("cancel")),
        admin.clone(),
    );
}
