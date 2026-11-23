use soroban_sdk::{contracttype, Address, BytesN, String, Vec};

/// Task status enum
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TaskStatus {
    Open,       // Task is open for submissions
    InProgress, // Work has been submitted
    Completed,  // Task completed and paid
    Cancelled,  // Task cancelled by poster
    Disputed,   // Task is under dispute
}

/// Submission status enum
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SubmissionStatus {
    Pending,  // Awaiting review
    Approved, // Approved and paid
    Rejected, // Rejected by task poster
}

/// Task structure
///
/// # Field ordering (storage optimization)
///
/// Fields are grouped by semantic purpose and serialization width so that
/// related data sits together in XDR-encoded storage entries:
///
/// 1. Identity   — `id` (u64)
/// 2. Ownership  — `poster` (Address)
/// 3. Content    — `title`, `description`, `token` (heap-allocated, variable)
/// 4. Reward     — `reward` (i128, 16 bytes)
/// 5. Timestamps — `deadline`, `created_at` (u64 each, 8 bytes)
/// 6. Counters   — `max_submissions`, `submission_count` (u32 each, 4 bytes)
/// 7. Status     — `status` (enum)
///
/// Grouping the two u64 timestamps together and the two u32 counters together
/// avoids fragmentation in the XDR representation and makes the struct layout
/// easier to reason about for future contributors.
#[contracttype]
#[derive(Clone, Debug)]
pub struct Task {
    /// Unique task identifier, monotonically assigned by the contract.
    pub id: u64,
    /// Address of the task creator / reward poster.
    pub poster: Address,
    /// Human-readable title for the task.
    pub title: String,
    /// Full task description (requirements, acceptance criteria, etc.).
    pub description: String,
    pub token: Address, // Token address for reward
    pub reward: i128,   // Reward amount
    pub deadline: u64,  // Unix timestamp
    pub max_submissions: u32,
    /// Number of submissions received so far.
    pub submission_count: u32,
    /// Current lifecycle state of the task.
    pub status: TaskStatus,
    pub created_at: u64, // Unix timestamp
}

/// Submission structure
///
/// # Field ordering
///
/// Identity → ownership → content (variable-length) → status → timestamp.
/// The single timestamp is placed last so all fixed-width fields are packed
/// together before the heap-allocated `String` fields.
#[contracttype]
#[derive(Clone, Debug)]
pub struct Submission {
    /// Unique submission identifier.
    pub id: u64,
    /// ID of the task this submission belongs to.
    pub task_id: u64,
    /// Address of the contributor who submitted the work.
    pub contributor: Address,
    pub work_url: String, // IPFS, Arweave, GitHub, etc.
    pub description: String,
    pub submitted_at: u64, // Unix timestamp
    pub status: SubmissionStatus,
    /// Unix timestamp (seconds) at which the submission was made.
    pub submitted_at: u64,
}

/// Dispute structure
///
/// # Field ordering
///
/// Identity / foreign keys → ownership → content → timestamp.
#[contracttype]
#[derive(Clone, Debug)]
pub struct Dispute {
    /// Unique dispute identifier.
    pub id: u64,
    /// ID of the task the dispute concerns.
    pub task_id: u64,
    /// ID of the submission that triggered the dispute.
    pub submission_id: u64,
    /// Address of the party that raised the dispute.
    pub raiser: Address,
    /// Human-readable explanation of the dispute.
    pub reason: String,
    /// Unix timestamp (seconds) at which the dispute was created.
    pub created_at: u64,
}

/// API credential record scoped to an organization.
#[contracttype]
#[derive(Clone, Debug)]
pub struct ApiCredential {
    pub id: u64,
    pub organization: Address,
    pub label: String,
    pub fingerprint: BytesN<32>,
    pub created_at: u64,
    pub is_active: bool,
    pub is_primary: bool,
    pub previous_credential_id: u64,
}

/// Rotation audit entry for API credentials.
#[contracttype]
#[derive(Clone, Debug)]
pub struct ApiCredentialRotation {
    pub organization: Address,
    pub old_credential_id: u64,
    pub new_credential_id: u64,
    pub actor: Address,
    pub reason: String,
    pub rotated_at: u64,
}

/// Immutable metadata describing the deployed contract.
///
/// Returned by `get_metadata()` and its component helpers. All fields are
/// compile-time constants embedded in the WASM; none are read from storage.
#[contracttype]
#[derive(Clone, Debug)]
pub struct ContractMetadata {
    /// Semantic version of this contract implementation, e.g. `"1.0.0"`.
    pub version: String,
    /// Human-readable contract name.
    pub name: String,
    /// Short description of the contract's purpose.
    pub description: String,
    /// List of event schema version strings supported by this deployment,
    /// e.g. `["task/v1", "submission/v1"]`. External indexers can use this
    /// to select the correct decoder without inspecting contract code.
    pub event_versions: Vec<String>,
}

/// Error codes
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum Error {
    TaskNotFound = 1,
    SubmissionNotFound = 2,
    Unauthorized = 3,
    TaskExpired = 4,
    InvalidTaskStatus = 5,
    InvalidSubmissionStatus = 6,
    InsufficientReward = 7,
    InvalidDeadline = 8,
    InvalidMaxSubmissions = 9,
    AlreadySubmitted = 10,
    MaxSubmissionsReached = 11,
    PaymentFailed = 12,
    DisputeAlreadyExists = 13,
    ApiKeyNotFound = 14,
    ApiKeyAlreadyExists = 15,
    NoActiveApiKeys = 16,
    InvalidApiKeyRotation = 17,
    ApiKeyRevoked = 18,
    UnauthorizedApiKeyAction = 19,
    NoPendingTransfer = 21,
    TransferAlreadyPending = 22,
}
