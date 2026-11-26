#![no_std]

//! # TaskBounty - Decentralized Task & Reward Board
//!
//! A Soroban smart contract for trustless task management and bounty payments on Stellar.

mod api_keys;
mod dispute;
mod events;
mod storage;
mod submission;
mod task;
mod types;

#[cfg(test)]
mod test;

use soroban_sdk::{contract, contractimpl, panic_with_error, Address, BytesN, Env, String, Vec};
use types::{Dispute, Submission, Task};

#[contract]
pub struct TaskBountyContract;

#[contractimpl]
impl TaskBountyContract {
    /// Initialize the contract with a dispute resolver address.
    pub fn initialize(env: Env, dispute_resolver: Address, admin: Address) {
        storage::set_dispute_resolver(&env, &dispute_resolver);
        storage::set_admin(&env, &admin);
        storage::set_task_counter(&env, 0);
        storage::set_submission_counter(&env, 0);
    }


    /// Set the dispute resolution period (seconds). Admin only.
    pub fn set_resolution_period(env: Env, admin: Address, period: u64) {
        admin.require_auth();
        let stored_admin = storage::get_admin(&env);
        if admin != stored_admin {
            panic_with_error!(&env, types::Error::Unauthorized);
        }
        if period == 0 {
            panic_with_error!(&env, types::Error::InvalidResolutionPeriod);
        }
        storage::set_resolution_period(&env, period);
    }

    /// Returns the current dispute resolution period in seconds.
    pub fn get_resolution_period(env: Env) -> u64 {
        storage::get_resolution_period(&env)
    }

    // ========================================================================
    // Administrator transfer
    // ========================================================================

    /// Propose a transfer of administrator rights to a new address.
    ///
    /// The transfer is not effective until the proposed address calls
    /// `accept_admin_transfer`. Only the current administrator may call this.
    /// Replaces any previously pending proposal.
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
    pub fn get_pending_admin(env: Env) -> Option<Address> {
        storage::get_pending_admin(&env)
    }

    // ========================================================================
    // Task management
    // ========================================================================

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
        task::create_task(&env, poster, title, description, token, reward, deadline, max_submissions)
    }

    pub fn cancel_task(env: Env, task_id: u64, poster: Address) {
        poster.require_auth();
        task::cancel_task(&env, task_id, poster)
    }

    pub fn get_task(env: Env, task_id: u64) -> Task {
        storage::get_task(&env, task_id)
    }

    pub fn get_total_tasks(env: Env) -> u64 {
        storage::get_task_counter(&env)
    }

    // ========================================================================
    // Submission management
    // ========================================================================

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

    pub fn approve_submission(env: Env, task_id: u64, submission_id: u64, poster: Address) {
        poster.require_auth();
        if storage::is_paused(&env) {
            panic_with_error!(env, types::Error::ContractPaused);
        }

        submission::approve_submission(&env, task_id, submission_id, poster)
    }

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
        submission::reject_submission(&env, task_id, submission_id, poster, reason)
    }

    pub fn get_submission(env: Env, submission_id: u64) -> Submission {
        storage::get_submission(&env, submission_id)
    }

    pub fn get_task_submissions(env: Env, task_id: u64) -> Vec<u64> {
        storage::get_task_submissions(&env, task_id)
    }

    pub fn get_total_submissions(env: Env) -> u64 {
        storage::get_submission_counter(&env)
    }

    pub fn has_submitted(env: Env, task_id: u64, contributor: Address) -> bool {
        storage::has_contributor_submitted(&env, task_id, &contributor)
    }

    // ========================================================================
    // Dispute management
    // ========================================================================

    /// Raise a dispute for a submission. Caller must be the task poster or
    /// the submission contributor.
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

    /// Resolve an open dispute. Only the dispute resolver set during
    /// `initialize` may call this.
    pub fn resolve_dispute(
        env: Env,
        dispute_id: u64,
        resolver: Address,
        ruling: String,
    ) {
        resolver.require_auth();
        dispute::resolve_dispute(&env, dispute_id, resolver, ruling)
    }

    /// Escalate a dispute whose resolution deadline has elapsed.
    /// Anyone may trigger escalation once the deadline has passed.
    pub fn escalate_dispute(env: Env, dispute_id: u64, escalated_by: Address) {
        escalated_by.require_auth();
        dispute::escalate_dispute(&env, dispute_id, escalated_by)
    }

    /// Returns the dispute record for the given dispute id.
    pub fn get_dispute(env: Env, dispute_id: u64) -> Dispute {
        dispute::get_dispute(&env, dispute_id)
    }

    /// Returns true if the resolution deadline for the given dispute has elapsed.
    pub fn is_dispute_expired(env: Env, dispute_id: u64) -> bool {
        dispute::is_dispute_expired(&env, dispute_id)
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
