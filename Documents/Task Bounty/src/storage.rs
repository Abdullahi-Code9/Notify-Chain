use crate::types::{ApiCredential, ApiCredentialRotation, Dispute, Submission, Task};
use crate::types::{Dispute, Submission, Task};
use soroban_sdk::{Address, Env, Vec};

// Storage keys
const TASK_COUNTER: &str = "TASK_CNT";
const SUBMISSION_COUNTER: &str = "SUB_CNT";
const DISPUTE_COUNTER: &str = "DISP_CNT";
const API_KEY_COUNTER: &str = "API_KEY_CNT";
const DISPUTE_RESOLVER: &str = "DISP_RES";
const ADMIN: &str = "ADMIN";

// Task storage
pub fn get_task(env: &Env, task_id: u64) -> Task {
    let key = (b"TASK", task_id);
    env.storage().persistent().get(&key).unwrap()
}

pub fn set_task(env: &Env, task: &Task) {
    let key = (b"TASK", task.id);
    env.storage().persistent().set(&key, task);
}

pub fn task_exists(env: &Env, task_id: u64) -> bool {
    let key = (b"TASK", task_id);
    env.storage().persistent().has(&key)
}

// Submission storage
pub fn get_submission(env: &Env, submission_id: u64) -> Submission {
    let key = (b"SUB", submission_id);
    env.storage().persistent().get(&key).unwrap()
}

pub fn set_submission(env: &Env, submission: &Submission) {
    let key = (b"SUB", submission.id);
    env.storage().persistent().set(&key, submission);
}

pub fn submission_exists(env: &Env, submission_id: u64) -> bool {
    let key = (b"SUB", submission_id);
    env.storage().persistent().has(&key)
}

// Task submissions mapping
pub fn get_task_submissions(env: &Env, task_id: u64) -> Vec<u64> {
    let key = (b"TASK_SUBS", task_id);
    env.storage()
        .persistent()
        .get(&key)
        .unwrap_or(Vec::new(env))
}

pub fn add_task_submission(env: &Env, task_id: u64, submission_id: u64) {
    let key = (b"TASK_SUBS", task_id);
    let mut submissions = get_task_submissions(env, task_id);
    submissions.push_back(submission_id);
    env.storage().persistent().set(&key, &submissions);
}

// Contributor submission tracking
pub fn has_contributor_submitted(env: &Env, task_id: u64, contributor: &Address) -> bool {
    let key = (b"HAS_SUB", task_id, contributor);
    env.storage().persistent().has(&key)
}

pub fn mark_contributor_submitted(env: &Env, task_id: u64, contributor: &Address) {
    let key = (b"HAS_SUB", task_id, contributor);
    env.storage().persistent().set(&key, &true);
}

// Dispute storage
pub fn get_dispute(env: &Env, dispute_id: u64) -> Dispute {
    let key = (b"DISP", dispute_id);
    env.storage().persistent().get(&key).unwrap()
}

pub fn set_dispute(env: &Env, dispute: &Dispute) {
    let key = (b"DISP", dispute.id);
    env.storage().persistent().set(&key, dispute);
}

pub fn has_active_dispute(env: &Env, task_id: u64, submission_id: u64) -> bool {
    let key = (b"DISP_ACT", task_id, submission_id);
    env.storage().persistent().has(&key)
}

pub fn set_active_dispute(env: &Env, task_id: u64, submission_id: u64, dispute_id: u64) {
    let key = (b"DISP_ACT", task_id, submission_id);
    env.storage().persistent().set(&key, &dispute_id);
}

// Counters
pub fn get_task_counter(env: &Env) -> u64 {
    env.storage().instance().get(&TASK_COUNTER).unwrap_or(0)
}

pub fn set_task_counter(env: &Env, count: u64) {
    env.storage().instance().set(&TASK_COUNTER, &count);
}

pub fn increment_task_counter(env: &Env) -> u64 {
    let count = get_task_counter(env) + 1;
    set_task_counter(env, count);
    count
}

pub fn get_submission_counter(env: &Env) -> u64 {
    env.storage()
        .instance()
        .get(&SUBMISSION_COUNTER)
        .unwrap_or(0)
}

pub fn set_submission_counter(env: &Env, count: u64) {
    env.storage().instance().set(&SUBMISSION_COUNTER, &count);
}

pub fn increment_submission_counter(env: &Env) -> u64 {
    let count = get_submission_counter(env) + 1;
    set_submission_counter(env, count);
    count
}

pub fn get_dispute_counter(env: &Env) -> u64 {
    env.storage().instance().get(&DISPUTE_COUNTER).unwrap_or(0)
}

pub fn increment_dispute_counter(env: &Env) -> u64 {
    let count = get_dispute_counter(env) + 1;
    env.storage().instance().set(&DISPUTE_COUNTER, &count);
    count
}

// Config
pub fn get_dispute_resolver(env: &Env) -> Address {
    env.storage().instance().get(&DISPUTE_RESOLVER).unwrap()
}

pub fn set_dispute_resolver(env: &Env, address: &Address) {
    env.storage().instance().set(&DISPUTE_RESOLVER, address);
}

pub fn get_admin(env: &Env) -> Address {
    env.storage().instance().get(&ADMIN).unwrap()
}

pub fn set_admin(env: &Env, address: &Address) {
    env.storage().instance().set(&ADMIN, address);
}

// Pending admin transfer
pub fn get_pending_admin(env: &Env) -> Option<Address> {
    env.storage().instance().get(&"PENDING_ADMIN")
}

pub fn set_pending_admin(env: &Env, address: &Address) {
    env.storage().instance().set(&"PENDING_ADMIN", address);
}

pub fn clear_pending_admin(env: &Env) {
    env.storage().instance().remove(&"PENDING_ADMIN");
}

// API credential storage
pub fn get_api_credentials(env: &Env, organization: &Address) -> Vec<ApiCredential> {
    let key = (b"API_KEYS", organization);
    env.storage()
        .persistent()
        .get(&key)
        .unwrap_or(Vec::new(env))
}

pub fn set_api_credentials(env: &Env, organization: &Address, credentials: &Vec<ApiCredential>) {
    let key = (b"API_KEYS", organization);
    env.storage().persistent().set(&key, credentials);
}

pub fn get_api_rotation_history(env: &Env, organization: &Address) -> Vec<ApiCredentialRotation> {
    let key = (b"API_ROT", organization);
    env.storage()
        .persistent()
        .get(&key)
        .unwrap_or(Vec::new(env))
}

pub fn set_api_rotation_history(
    env: &Env,
    organization: &Address,
    history: &Vec<ApiCredentialRotation>,
) {
    let key = (b"API_ROT", organization);
    env.storage().persistent().set(&key, history);
}

pub fn increment_api_key_counter(env: &Env) -> u64 {
    let count = get_api_key_counter(env) + 1;
    env.storage().instance().set(&API_KEY_COUNTER, &count);
    count
}

pub fn get_api_key_counter(env: &Env) -> u64 {
    env.storage()
        .instance()
        .get(&API_KEY_COUNTER)
        .unwrap_or(0)
}
