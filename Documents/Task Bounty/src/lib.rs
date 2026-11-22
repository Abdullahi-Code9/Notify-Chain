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

    // ========================================================================
    // Administrator transfer
    // ========================================================================

    /// Propose a transfer of administrator rights to a new address.
    ///
    /// The transfer is not effective until the proposed address calls
    /// `accept_admin_transfer`. Only the current administrator may call this.
    /// Replaces any previously pending proposal.
    ///
    /// # Arguments
    /// * `admin` - Current administrator address
    /// * `proposed` - Address being nominated as the next administrator
    pub fn propose_admin_transfer(env: Env, admin: Address, proposed: Address) {
        admin.require_auth();
        let stored_admin = storage::get_admin(&env);
        if admin != stored_admin {
            panic_with_error!(env, types::Error::Unauthorized);
        }
        storage::set_pending_admin(&env, &proposed);
        events::emit_admin_transfer_proposed(&env, &admin, &proposed);
    }

    /// Accept a pending administrator transfer.
    ///
    /// Only the address nominated by the current administrator via
    /// `propose_admin_transfer` may call this. On success the caller
    /// becomes the new administrator and the pending proposal is cleared.
    ///
    /// # Arguments
    /// * `proposed` - The nominated address accepting the role
    pub fn accept_admin_transfer(env: Env, proposed: Address) {
        proposed.require_auth();
        let pending = storage::get_pending_admin(&env);
        match pending {
            None => panic_with_error!(env, types::Error::NoPendingTransfer),
            Some(ref p) => {
                if *p != proposed {
                    panic_with_error!(env, types::Error::Unauthorized);
                }
            }
        }
        storage::set_admin(&env, &proposed);
        storage::clear_pending_admin(&env);
        events::emit_admin_transfer_accepted(&env, &proposed);
    }

    /// Cancel a pending administrator transfer.
    ///
    /// Only the current administrator may call this. The pending proposal
    /// is cleared; the existing administrator remains unchanged.
    ///
    /// # Arguments
    /// * `admin` - Current administrator address
    pub fn cancel_admin_transfer(env: Env, admin: Address) {
        admin.require_auth();
        let stored_admin = storage::get_admin(&env);
        if admin != stored_admin {
            panic_with_error!(env, types::Error::Unauthorized);
        }
        if storage::get_pending_admin(&env).is_none() {
            panic_with_error!(env, types::Error::NoPendingTransfer);
        }
        storage::clear_pending_admin(&env);
        events::emit_admin_transfer_cancelled(&env, &admin);
    }

    /// Return the currently pending administrator address, if any.
    ///
    /// Returns `None` when no transfer has been proposed. This function
    /// does not modify contract state.
    pub fn get_pending_admin(env: Env) -> Option<Address> {
        storage::get_pending_admin(&env)
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

        submission::reject_submission(&env, task_id, submission_id, poster, reason)
    }

    /// Cancel a task and refund the poster
    ///
    /// # Arguments
    /// * `task_id` - ID of the task to cancel
    /// * `poster` - Address of the task poster (for auth)
    pub fn cancel_task(env: Env, task_id: u64, poster: Address) {
        poster.require_auth();

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
    // Contract version and metadata queries
    // ========================================================================

    /// Return the semantic version string of this contract implementation.
    ///
    /// This value is a compile-time constant embedded in the WASM binary and
    /// does not read from or write to contract storage.
    ///
    /// # Returns
    /// Version string, e.g. `"1.0.0"`
    pub fn get_version(env: Env) -> soroban_sdk::String {
        soroban_sdk::String::from_str(&env, "1.0.0")
    }

    /// Return the list of event schema versions emitted by this deployment.
    ///
    /// External indexers and SDK consumers should inspect this list to
    /// select the correct event decoder before processing contract events.
    /// Each entry follows the pattern `"<namespace>/v<n>"`.
    ///
    /// This function does not read from or write to contract storage.
    ///
    /// # Returns
    /// Vector of event schema version strings
    pub fn get_supported_event_versions(env: Env) -> Vec<soroban_sdk::String> {
        let mut versions = Vec::new(&env);
        versions.push_back(soroban_sdk::String::from_str(&env, "task/v1"));
        versions.push_back(soroban_sdk::String::from_str(&env, "submission/v1"));
        versions.push_back(soroban_sdk::String::from_str(&env, "dispute/v1"));
        versions.push_back(soroban_sdk::String::from_str(&env, "api/v1"));
        versions.push_back(soroban_sdk::String::from_str(&env, "contract/v1"));
        versions
    }

    /// Return immutable metadata describing this contract deployment.
    ///
    /// Combines `get_version` and `get_supported_event_versions` into a
    /// single call for external applications that need a full capability
    /// snapshot. All fields are compile-time constants; this function does
    /// not read from or write to contract storage.
    ///
    /// # Returns
    /// `ContractMetadata` struct containing version, name, description, and
    /// supported event schema versions
    pub fn get_metadata(env: Env) -> types::ContractMetadata {
        types::ContractMetadata {
            version: soroban_sdk::String::from_str(&env, "1.0.0"),
            name: soroban_sdk::String::from_str(&env, "TaskBounty"),
            description: soroban_sdk::String::from_str(
                &env,
                "Decentralized task and bounty board on Stellar",
            ),
            event_versions: Self::get_supported_event_versions(env.clone()),
        }
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
