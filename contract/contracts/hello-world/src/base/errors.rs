use soroban_sdk::contracterror;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    /// Triggered when the input provided is invalid.
    InvalidInput = 1,
    /// Triggered when an entity already exists.
    AlreadyExists = 2,
    /// Triggered when an entity is not found in storage.
    NotFound = 3,
    /// Triggered when the token used is not supported.
    UnsupportedToken = 4,
    /// Triggered when insufficient payment is provided.
    InsufficientPayment = 5,
    /// Triggered when an AutoShare group has no remaining usages.
    NoUsagesRemaining = 6,
    /// Triggered when an invalid usage count is provided (e.g., zero).
    InvalidUsageCount = 7,
    /// Triggered when the caller lacks authorization for an action.
    Unauthorized = 8,
    /// Triggered when a user has insufficient balance.
    InsufficientBalance = 9,
    /// Triggered when an invalid amount is specified.
    InvalidAmount = 10,
    /// Triggered when an action is attempted while the contract is paused.
    ContractPaused = 11,
    /// Triggered when attempting to pause an already paused contract.
    AlreadyPaused = 12,
    /// Triggered when attempting to unpause a contract that isn't paused.
    NotPaused = 13,
    /// Triggered when group member percentages don't sum to exactly 100.
    InvalidTotalPercentage = 14,
    /// Triggered when trying to set an empty member list.
    EmptyMembers = 15,
    /// Triggered when the member list contains duplicate addresses.
    DuplicateMember = 16,
    /// Triggered when interacting with a deactivated group.
    GroupInactive = 17,
    /// Triggered when attempting to activate an already active group.
    GroupAlreadyActive = 18,
    /// Triggered when attempting to deactivate an already inactive group.
    GroupAlreadyInactive = 19,
    /// Triggered when the contract has insufficient balance for a withdrawal.
    InsufficientContractBalance = 20,
    /// Triggered when a name string exceeds the maximum allowed length.
    NameTooLong = 21,
    /// Triggered when the number of members exceeds the maximum allowed.
    TooManyMembers = 22,
    /// Triggered when interacting with a notification that has already expired.
    NotificationExpired = 23,
    /// Triggered when an invalid expiration duration is provided (e.g., zero,
    /// one that overflows the ledger clock, or one that exceeds the maximum
    /// allowed notification lifetime).
    InvalidExpirationDuration = 24,
    /// Triggered when attempting to expire a notification whose lifetime has not
    /// yet elapsed.
    NotificationNotExpired = 25,
    /// Triggered when a batch operation exceeds the maximum allowed size.
    BatchTooLarge = 26,
    /// Triggered when attempting to interact with a revoked notification.
    NotificationRevoked = 27,
    /// Triggered when the caller is not authorized to revoke a notification.
    NotAuthorizedToRevoke = 28,
    /// Triggered when attempting to revoke a notification that is already revoked.
    AlreadyRevoked = 29,
    /// Triggered when a transfer is attempted to the zero address.
    ZeroAddressTransfer = 30,
    /// Triggered when `accept_ownership` is called but no pending transfer is queued.
    NoPendingOwnershipTransfer = 31,
    /// Triggered when a caller other than the pending owner calls `accept_ownership`.
    NotPendingOwner = 32,
    /// Triggered when the caller is not authorized to acknowledge a notification.
    NotAuthorizedToAcknowledge = 33,
    /// Triggered when an invalid limit configuration is provided.
    InvalidLimit = 34,
    /// Triggered when a notification has already been delivered and cannot be recalled.
    NotificationDelivered = 35,
    /// Triggered when a notification category is not registered.
    CategoryNotRegistered = 36,
    /// Triggered when a notification lifetime exceeds the protocol maximum.
    /// See `MAX_NOTIFICATION_LIFETIME_SECONDS` in autoshare_logic.
    NotificationLifetimeTooLong = 37,
    /// Triggered when referencing a template ID that does not exist in the registry.
    TemplateNotFound = 38,
    /// Triggered when a template name exceeds the maximum allowed length.
    TemplateNameTooLong = 39,
    /// Triggered when a template content field is empty.
    TemplateContentEmpty = 40,
    /// Triggered when a duplicate notification delivery request is detected.
    DuplicateDelivery = 41,
    /// Triggered when a nonce has already been consumed (replay attempt) or is
    /// lower than the signer's next expected nonce (stale).
    NonceAlreadyUsed = 42,
    /// Triggered when a nonce is ahead of the expected sequence, or its
    /// freshness window is out of bounds.
    InvalidNonce = 43,
    /// Triggered when a nonce's `valid_until` deadline has already passed.
    NonceExpired = 44,
    /// Triggered when a nonce is bound to a different contract address.
    NonceContractMismatch = 45,
    /// Triggered when a variable-length input exceeds its configured maximum
    /// size (e.g. an over-long collection or string). See
    /// `base::constants` for the per-input bounds.
    InputTooLarge = 46,
    /// Triggered when a notification payload or metadata string exceeds
    /// `MAX_EVENT_PAYLOAD_LEN` / `MAX_TOPIC_LEN`. See `base::constants`.
    PayloadExceedsMaxLength = 47,
    /// Triggered when a paginated enumeration request exceeds the maximum
    /// supported page size (`MAX_ENUMERATION_PAGE_SIZE`).
    PageLimitExceeded = 46,
    /// Triggered when the network identifier supplied during initialization or
    /// validation does not match the expected deployment network.
    NetworkMismatch = 47,
    /// Triggered when the network identifier is an empty string.
    InvalidNetworkId = 48,
    /// Triggered when an operation requires `initialize_admin` to have run first.
    NotInitialized = 46,
    /// Triggered when `initialize_admin` is called more than once.
    AlreadyInitialized = 47,
}

/// Stable numeric code transmitted to off-chain callers on failure.
pub fn code(error: Error) -> u32 {
    error as u32
}

/// Maps a numeric contract error code back to its centralized definition.
/// Unknown codes return `None`, allowing consumers to recognize future codes
/// without misclassifying them as an existing failure mode.
pub fn from_code(code: u32) -> Option<Error> {
    match code {
        1 => Some(Error::InvalidInput),
        2 => Some(Error::AlreadyExists),
        3 => Some(Error::NotFound),
        4 => Some(Error::UnsupportedToken),
        5 => Some(Error::InsufficientPayment),
        6 => Some(Error::NoUsagesRemaining),
        7 => Some(Error::InvalidUsageCount),
        8 => Some(Error::Unauthorized),
        9 => Some(Error::InsufficientBalance),
        10 => Some(Error::InvalidAmount),
        11 => Some(Error::ContractPaused),
        12 => Some(Error::AlreadyPaused),
        13 => Some(Error::NotPaused),
        14 => Some(Error::InvalidTotalPercentage),
        15 => Some(Error::EmptyMembers),
        16 => Some(Error::DuplicateMember),
        17 => Some(Error::GroupInactive),
        18 => Some(Error::GroupAlreadyActive),
        19 => Some(Error::GroupAlreadyInactive),
        20 => Some(Error::InsufficientContractBalance),
        21 => Some(Error::NameTooLong),
        22 => Some(Error::TooManyMembers),
        23 => Some(Error::NotificationExpired),
        24 => Some(Error::InvalidExpirationDuration),
        25 => Some(Error::NotificationNotExpired),
        26 => Some(Error::BatchTooLarge),
        27 => Some(Error::NotificationRevoked),
        28 => Some(Error::NotAuthorizedToRevoke),
        29 => Some(Error::AlreadyRevoked),
        30 => Some(Error::ZeroAddressTransfer),
        31 => Some(Error::NoPendingOwnershipTransfer),
        32 => Some(Error::NotPendingOwner),
        33 => Some(Error::NotAuthorizedToAcknowledge),
        34 => Some(Error::InvalidLimit),
        35 => Some(Error::NotificationDelivered),
        36 => Some(Error::CategoryNotRegistered),
        37 => Some(Error::NotificationLifetimeTooLong),
        38 => Some(Error::TemplateNotFound),
        39 => Some(Error::TemplateNameTooLong),
        40 => Some(Error::TemplateContentEmpty),
        41 => Some(Error::DuplicateDelivery),
        42 => Some(Error::NonceAlreadyUsed),
        43 => Some(Error::InvalidNonce),
        44 => Some(Error::NonceExpired),
        45 => Some(Error::NonceContractMismatch),
        46 => Some(Error::NotInitialized),
        47 => Some(Error::AlreadyInitialized),
        _ => None,
    }
}
