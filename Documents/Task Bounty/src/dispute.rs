use crate::events;
use crate::storage;
use crate::types::{Dispute, DisputeStatus, Error, SubmissionStatus, TaskStatus};
use soroban_sdk::{panic_with_error, Address, Env, String};

/// Raise a dispute for a submission. Either the task poster or the submission
/// contributor may raise a dispute. A configurable resolution deadline is
/// recorded so the dispute can be escalated if it remains unresolved.
pub fn raise_dispute(
    env: &Env,
    task_id: u64,
    submission_id: u64,
    raiser: Address,
    reason: String,
) {
    if !storage::task_exists(env, task_id) {
        panic_with_error!(env, Error::TaskNotFound);
    }
    let mut task = storage::get_task(env, task_id);

    if !storage::submission_exists(env, submission_id) {
        panic_with_error!(env, Error::SubmissionNotFound);
    }
    let submission = storage::get_submission(env, submission_id);

    if submission.task_id != task_id {
        panic_with_error!(env, Error::Unauthorized);
    }

    if raiser != task.poster && raiser != submission.contributor {
        panic_with_error!(env, Error::Unauthorized);
    }

    if submission.status != SubmissionStatus::Pending
        && submission.status != SubmissionStatus::Rejected
    {
        panic_with_error!(env, Error::InvalidSubmissionStatus);
    }

    if storage::has_active_dispute(env, task_id, submission_id) {
        panic_with_error!(env, Error::DisputeAlreadyExists);
    }

    let now = env.ledger().timestamp();
    let resolution_period = storage::get_resolution_period(env);
    let resolution_deadline = now + resolution_period;

    let dispute_id = storage::increment_dispute_counter(env);
    let dispute = Dispute {
        id: dispute_id,
        task_id,
        submission_id,
        raiser: raiser.clone(),
        created_at: now,
        resolution_deadline,
        status: DisputeStatus::Open,
        reason: reason.clone(),
    };

    storage::set_dispute(env, &dispute);
    storage::set_active_dispute(env, task_id, submission_id, dispute_id);

    task.status = TaskStatus::Disputed;
    storage::set_task(env, &task);

    events::emit_dispute_raised(
        env,
        task_id,
        submission_id,
        &raiser,
        &reason,
        resolution_deadline,
    );
}

/// Resolve an open dispute. Only the designated dispute resolver may call this.
/// The resolver supplies a ruling string that is recorded in the emitted event.
/// Funds are NOT released here — the ruling informs off-chain or a subsequent
/// approve/reject call; this keeps the resolution logic orthogonal to payment.
pub fn resolve_dispute(
    env: &Env,
    dispute_id: u64,
    resolver: Address,
    ruling: String,
) {
    if !storage::dispute_exists(env, dispute_id) {
        panic_with_error!(env, Error::DisputeNotFound);
    }

    let authorized_resolver = storage::get_dispute_resolver(env);
    if resolver != authorized_resolver {
        panic_with_error!(env, Error::Unauthorized);
    }

    let mut dispute = storage::get_dispute(env, dispute_id);

    if dispute.status == DisputeStatus::Resolved {
        panic_with_error!(env, Error::DisputeAlreadyResolved);
    }
    if dispute.status == DisputeStatus::Escalated {
        panic_with_error!(env, Error::DisputeAlreadyEscalated);
    }

    dispute.status = DisputeStatus::Resolved;
    storage::set_dispute(env, &dispute);

    // Mirror resolved status on the task so callers can observe the outcome
    let mut task = storage::get_task(env, dispute.task_id);
    task.status = TaskStatus::Disputed; // remains Disputed; poster must approve/cancel next
    storage::set_task(env, &task);

    events::emit_dispute_resolved(
        env,
        dispute_id,
        dispute.task_id,
        dispute.submission_id,
        &resolver,
        &ruling,
    );
}

/// Escalate a dispute whose resolution deadline has passed without resolution.
/// Anyone may trigger escalation once the deadline has elapsed — this is an
/// administrative signal that the dispute needs elevated attention.
/// Unauthorized parties cannot release funds by calling this.
pub fn escalate_dispute(env: &Env, dispute_id: u64, escalated_by: Address) {
    if !storage::dispute_exists(env, dispute_id) {
        panic_with_error!(env, Error::DisputeNotFound);
    }

    let mut dispute = storage::get_dispute(env, dispute_id);

    if dispute.status == DisputeStatus::Resolved {
        panic_with_error!(env, Error::DisputeAlreadyResolved);
    }
    if dispute.status == DisputeStatus::Escalated {
        panic_with_error!(env, Error::DisputeAlreadyEscalated);
    }

    let now = env.ledger().timestamp();
    if now <= dispute.resolution_deadline {
        panic_with_error!(env, Error::DisputeNotExpired);
    }

    dispute.status = DisputeStatus::Escalated;
    storage::set_dispute(env, &dispute);

    let mut task = storage::get_task(env, dispute.task_id);
    task.status = TaskStatus::Escalated;
    storage::set_task(env, &task);

    events::emit_dispute_escalated(
        env,
        dispute_id,
        dispute.task_id,
        dispute.submission_id,
        &escalated_by,
        dispute.resolution_deadline,
    );
}

/// Returns the dispute record for a given dispute id.
pub fn get_dispute(env: &Env, dispute_id: u64) -> Dispute {
    if !storage::dispute_exists(env, dispute_id) {
        panic_with_error!(env, Error::DisputeNotFound);
    }
    storage::get_dispute(env, dispute_id)
}

/// Returns true if the resolution deadline for the given dispute has elapsed.
pub fn is_dispute_expired(env: &Env, dispute_id: u64) -> bool {
    if !storage::dispute_exists(env, dispute_id) {
        panic_with_error!(env, Error::DisputeNotFound);
    }
    let dispute = storage::get_dispute(env, dispute_id);
    env.ledger().timestamp() > dispute.resolution_deadline
}
