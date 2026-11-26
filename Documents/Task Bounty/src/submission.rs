use crate::events;
use crate::storage;
use crate::types::{Error, Submission, SubmissionStatus, TaskStatus};
use soroban_sdk::{panic_with_error, token, Address, Env, String};

/// Submit work for a task
pub fn submit_work(
    env: &Env,
    task_id: u64,
    contributor: Address,
    work_url: String,
    description: String,
) -> u64 {
    // Get task
    if !storage::task_exists(env, task_id) {
        panic_with_error!(env, Error::TaskNotFound);
    }

    let mut task = storage::get_task(env, task_id);

    // Validate task status
    if task.status != TaskStatus::Open && task.status != TaskStatus::InProgress {
        panic_with_error!(env, Error::InvalidTaskStatus);
    }

    // Check deadline
    if env.ledger().timestamp() > task.deadline {
        panic_with_error!(env, Error::TaskExpired);
    }

    // Check if contributor already submitted
    if storage::has_contributor_submitted(env, task_id, &contributor) {
        panic_with_error!(env, Error::AlreadySubmitted);
    }

    // Check max submissions
    if task.submission_count >= task.max_submissions {
        panic_with_error!(env, Error::MaxSubmissionsReached);
    }

    // Create submission
    let submission_id = storage::increment_submission_counter(env);
    let submission = Submission {
        id: submission_id,
        task_id,
        contributor: contributor.clone(),
        work_url: work_url.clone(),
        description,
        submitted_at: env.ledger().timestamp(),
        status: SubmissionStatus::Pending,
    };

    storage::set_submission(env, &submission);
    storage::add_task_submission(env, task_id, submission_id);
    storage::mark_contributor_submitted(env, task_id, &contributor);

    // Update task
    task.submission_count += 1;
    if task.status == TaskStatus::Open {
        task.status = TaskStatus::InProgress;
    }
    storage::set_task(env, &task);

    // Emit event
    events::emit_work_submitted(env, task_id, submission_id, &contributor, &work_url);

    submission_id
}

/// Approve a submission and release payment
pub fn approve_submission(env: &Env, task_id: u64, submission_id: u64, poster: Address) {
    // Get task
    if !storage::task_exists(env, task_id) {
        panic_with_error!(env, Error::TaskNotFound);
    }

    let mut task = storage::get_task(env, task_id);

    // Verify poster
    if task.poster != poster {
        panic_with_error!(env, Error::Unauthorized);
    }

    // Get submission
    if !storage::submission_exists(env, submission_id) {
        panic_with_error!(env, Error::SubmissionNotFound);
    }

    let mut submission = storage::get_submission(env, submission_id);

    // Verify submission belongs to task
    if submission.task_id != task_id {
        panic_with_error!(env, Error::Unauthorized);
    }

    // Check submission status
    if submission.status != SubmissionStatus::Pending {
        panic_with_error!(env, Error::InvalidSubmissionStatus);
    }

    // Check task status
    if task.status == TaskStatus::Completed || task.status == TaskStatus::Cancelled {
        panic_with_error!(env, Error::InvalidTaskStatus);
    }

    // Check for active disputes
    if storage::has_active_dispute(env, task_id, submission_id) {
        panic_with_error!(env, Error::InvalidSubmissionStatus);
    }

    // Update statuses
    submission.status = SubmissionStatus::Approved;
    task.status = TaskStatus::Completed;

    storage::set_submission(env, &submission);
    storage::set_task(env, &task);

    // Transfer reward to contributor
    let contract_address = env.current_contract_address();
    let token_client = token::Client::new(env, &task.token);
    token_client.transfer(&contract_address, &submission.contributor, &task.reward);

    // Emit event
    events::emit_submission_approved(
        env,
        task_id,
        submission_id,
        &submission.contributor,
        task.reward,
    );
}

/// Reject a submission
pub fn reject_submission(
    env: &Env,
    task_id: u64,
    submission_id: u64,
    poster: Address,
    _reason: String,
) {
    // Get task
    if !storage::task_exists(env, task_id) {
        panic_with_error!(env, Error::TaskNotFound);
    }

    let task = storage::get_task(env, task_id);

    // Verify poster
    if task.poster != poster {
        panic_with_error!(env, Error::Unauthorized);
    }

    // Get submission
    if !storage::submission_exists(env, submission_id) {
        panic_with_error!(env, Error::SubmissionNotFound);
    }

    let mut submission = storage::get_submission(env, submission_id);

    // Verify submission belongs to task
    if submission.task_id != task_id {
        panic_with_error!(env, Error::Unauthorized);
    }

    // Check submission status
    if submission.status != SubmissionStatus::Pending {
        panic_with_error!(env, Error::InvalidSubmissionStatus);
    }

    // Update status
    submission.status = SubmissionStatus::Rejected;
    storage::set_submission(env, &submission);

    // Emit event
    events::emit_submission_rejected(env, task_id, submission_id, &submission.contributor);
}
