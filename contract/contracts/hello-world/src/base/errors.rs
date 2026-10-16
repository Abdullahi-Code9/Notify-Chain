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
}
