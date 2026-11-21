#![no_std]

//! # TaskBounty - Decentralized Task & Reward Board
//!
//! A Soroban smart contract for trustless task management and bounty payments on Stellar.
//!
//! ## Features
//! - Task creation with escrowed rewards
//! - Work submission with IPFS/Arweave links
//! - Approval/rejection system
//! - Automatic payouts
//! - Dispute resolution
//! - Multi-token support (XLM and SAC tokens)

mod dispute;
mod events;
mod api_keys;
mod storage;
mod submission;
mod task;
mod types;

#[cfg(test)]
mod test;

use soroban_sdk::{contract, contractimpl, Address, BytesN, Env, String, Vec};
use types::{Task, Submission, TaskStatus, SubmissionStatus};
use soroban_sdk::{contract, contractimpl, Address, Env, String, Vec};
use types::{Submission, SubmissionStatus, Task, TaskStatus};

#[contract]
pub struct TaskBountyContract;

#[contractimpl]
impl TaskBountyContract {
    /// Initialize the contract with a dispute resolver address
    ///
    /// # Arguments
    /// * `dispute_resolver` - Address of the dispute resolver contract
    /// * `admin` - Address of the contract administrator
    pub fn initialize(env: Env, dispute_resolver: Address, admin: Address) {
        storage::set_dispute_resolver(&env, &dispute_resolver);
        storage::set_admin(&env, &admin);
        storage::set_task_counter(&env, 0);
        storage::set_submission_counter(&env, 0);
    }

    /// Emergency pause: suspends all state-mutating operations.
    /// Only the admin may call this.
    ///
    /// # Arguments
    /// * `admin` - Address of the contract administrator
    pub fn pause_contract(env: Env, admin: Address) {
        admin.require_auth();
        let stored_admin = storage::get_admin(&env);
        if admin != stored_admin {
            panic_with_error!(env, types::Error::Unauthorized);
        }
        storage::set_paused(&env, true);
        events::emit_contract_paused(&env, &admin);
    }

    /// Resume a paused contract, re-enabling state-mutating operations.
    /// Only the admin may call this.
    ///
    /// # Arguments
    /// * `admin` - Address of the contract administrator
    pub fn resume_contract(env: Env, admin: Address) {
        admin.require_auth();
        let stored_admin = storage::get_admin(&env);
        if admin != stored_admin {
            panic_with_error!(env, types::Error::Unauthorized);
        }
        storage::set_paused(&env, false);
        events::emit_contract_resumed(&env, &admin);
    }

    /// Returns true if the contract is currently paused.
    pub fn is_paused(env: Env) -> bool {
        storage::is_paused(&env)
    }

    /// Create a new task with escrowed reward
    ///
    /// # Arguments
    /// * `poster` - Address of the task poster
    /// * `title` - Task title
    /// * `description` - Detailed task description
    /// * `token` - Token address for reward (XLM or SAC token)
    /// * `reward` - Reward amount in token's smallest unit
    /// * `deadline` - Unix timestamp for task deadline
    /// * `max_submissions` - Maximum number of submissions allowed
    ///
    /// # Returns
    /// Task ID
    pub fn create_task(
        env: Env,
        poster: Address,
        title: String,
        description: String,
        token: Address,
        reward: i128,
        deadline: u64,
        max_submissions: u32,
    ) -> u64 {
        poster.require_auth();
        if storage::is_paused(&env) {
            panic_with_error!(env, types::Error::ContractPaused);
        }

        task::create_task(
            &env,
            poster,
            title,
            description,
            token,
            reward,
            deadline,
            max_submissions,
        )
    }

    /// Submit work for a task
    ///
    /// # Arguments
    /// * `task_id` - ID of the task
    /// * `contributor` - Address of the contributor
    /// * `work_url` - URL to the work (IPFS, Arweave, GitHub, etc.)
    /// * `description` - Description of the work done
    ///
    /// # Returns
    /// Submission ID
    pub fn submit_work(
        env: Env,
        task_id: u64,
        contributor: Address,
        work_url: String,
        description: String,
    ) -> u64 {
        contributor.require_auth();
        if storage::is_paused(&env) {
            panic_with_error!(env, types::Error::ContractPaused);
        }

        submission::submit_work(&env, task_id, contributor, work_url, description)
    }

    /// Approve a submission and release payment
    ///
    /// # Arguments
    /// * `task_id` - ID of the task
    /// * `submission_id` - ID of the submission to approve
    /// * `poster` - Address of the task poster (for auth)
    pub fn approve_submission(env: Env, task_id: u64, submission_id: u64, poster: Address) {
        poster.require_auth();
        if storage::is_paused(&env) {
            panic_with_error!(env, types::Error::ContractPaused);
        }

        submission::approve_submission(&env, task_id, submission_id, poster)
    }

    /// Reject a submission
    ///
    /// # Arguments
    /// * `task_id` - ID of the task
    /// * `submission_id` - ID of the submission to reject
    /// * `poster` - Address of the task poster (for auth)
    /// * `reason` - Reason for rejection
    pub fn reject_submission(
        env: Env,
        task_id: u64,
        submission_id: u64,
        poster: Address,
        reason: String,
    ) {
        poster.require_auth();
        if storage::is_paused(&env) {
            panic_with_error!(env, types::Error::ContractPaused);
        }

        submission::reject_submission(&env, task_id, submission_id, poster, reason)
    }

    /// Cancel a task and refund the poster
    ///
    /// # Arguments
    /// * `task_id` - ID of the task to cancel
    /// * `poster` - Address of the task poster (for auth)
    pub fn cancel_task(env: Env, task_id: u64, poster: Address) {
        poster.require_auth();
        if storage::is_paused(&env) {
            panic_with_error!(env, types::Error::ContractPaused);
        }

        task::cancel_task(&env, task_id, poster)
    }

    /// Raise a dispute for a submission
    ///
    /// # Arguments
    /// * `task_id` - ID of the task
    /// * `submission_id` - ID of the submission
    /// * `raiser` - Address raising the dispute
    /// * `reason` - Reason for the dispute
    pub fn raise_dispute(
        env: Env,
        task_id: u64,
        submission_id: u64,
        raiser: Address,
        reason: String,
    ) {
        raiser.require_auth();
        if storage::is_paused(&env) {
            panic_with_error!(env, types::Error::ContractPaused);
        }

        dispute::raise_dispute(&env, task_id, submission_id, raiser, reason)
    }

    /// Get task details
    ///
    /// # Arguments
    /// * `task_id` - ID of the task
    ///
    /// # Returns
    /// Task struct
    pub fn get_task(env: Env, task_id: u64) -> Task {
        storage::get_task(&env, task_id)
    }

    /// Get submission details
    ///
    /// # Arguments
    /// * `submission_id` - ID of the submission
    ///
    /// # Returns
    /// Submission struct
    pub fn get_submission(env: Env, submission_id: u64) -> Submission {
        storage::get_submission(&env, submission_id)
    }

    /// Get all submission IDs for a task
    ///
    /// # Arguments
    /// * `task_id` - ID of the task
    ///
    /// # Returns
    /// Vector of submission IDs
    pub fn get_task_submissions(env: Env, task_id: u64) -> Vec<u64> {
        storage::get_task_submissions(&env, task_id)
    }

    /// Get total number of tasks created
    ///
    /// # Returns
    /// Total task count
    pub fn get_total_tasks(env: Env) -> u64 {
        storage::get_task_counter(&env)
    }

    /// Get total number of submissions
    ///
    /// # Returns
    /// Total submission count
    pub fn get_total_submissions(env: Env) -> u64 {
        storage::get_submission_counter(&env)
    }

    /// Check if a contributor has submitted for a task
    ///
    /// # Arguments
    /// * `task_id` - ID of the task
    /// * `contributor` - Address of the contributor
    ///
    /// # Returns
    /// True if contributor has submitted
    pub fn has_submitted(env: Env, task_id: u64, contributor: Address) -> bool {
        storage::has_contributor_submitted(&env, task_id, &contributor)
    }

    // ========================================================================
    // API Credential Management
    // ========================================================================

    pub fn register_api_key(
        env: Env,
        organization: Address,
        label: String,
        fingerprint: BytesN<32>,
    ) -> u64 {
        if storage::is_paused(&env) {
            panic_with_error!(env, types::Error::ContractPaused);
        }
        api_keys::register_api_key(env, organization, label, fingerprint).unwrap()
    }

    pub fn rotate_api_key(
        env: Env,
        organization: Address,
        current_credential_id: u64,
        new_label: String,
        new_fingerprint: BytesN<32>,
        reason: String,
    ) -> u64 {
        if storage::is_paused(&env) {
            panic_with_error!(env, types::Error::ContractPaused);
        }
        api_keys::rotate_api_key(
            env,
            organization,
            current_credential_id,
            new_label,
            new_fingerprint,
            reason,
        )
        .unwrap()
    }

    pub fn revoke_api_key(env: Env, organization: Address, credential_id: u64) {
        if storage::is_paused(&env) {
            panic_with_error!(env, types::Error::ContractPaused);
        }
        api_keys::revoke_api_key(env, organization, credential_id).unwrap();
    }

    pub fn get_active_api_keys(env: Env, organization: Address) -> Vec<types::ApiCredential> {
        api_keys::get_active_api_keys(env, organization)
    }

    pub fn get_api_key_rotation_history(
        env: Env,
        organization: Address,
    ) -> Vec<types::ApiCredentialRotation> {
        api_keys::get_api_key_rotation_history(env, organization)
    }

    pub fn is_api_key_active(env: Env, organization: Address, fingerprint: BytesN<32>) -> bool {
        api_keys::is_api_key_active(env, organization, fingerprint)
    }
}
