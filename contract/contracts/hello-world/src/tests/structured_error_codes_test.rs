//! Structured, stable contract error codes (issue #1130).
//!
//! `base::errors` is the single source of truth for codes exposed to
//! off-chain consumers. Codes must never change silently.

use crate::base::errors::{code, from_code, Error};

#[test]
fn error_codes_are_stable_and_round_trip() {
    let all = [
        Error::InvalidInput,
        Error::AlreadyExists,
        Error::NotFound,
        Error::UnsupportedToken,
        Error::InsufficientPayment,
        Error::NoUsagesRemaining,
        Error::InvalidUsageCount,
        Error::Unauthorized,
        Error::InsufficientBalance,
        Error::InvalidAmount,
        Error::ContractPaused,
        Error::AlreadyPaused,
        Error::NotPaused,
        Error::InvalidTotalPercentage,
        Error::EmptyMembers,
        Error::DuplicateMember,
        Error::GroupInactive,
        Error::GroupAlreadyActive,
        Error::GroupAlreadyInactive,
        Error::InsufficientContractBalance,
        Error::NameTooLong,
        Error::TooManyMembers,
        Error::NotificationExpired,
        Error::InvalidExpirationDuration,
        Error::NotificationNotExpired,
        Error::BatchTooLarge,
        Error::NotificationRevoked,
        Error::NotAuthorizedToRevoke,
        Error::AlreadyRevoked,
        Error::ZeroAddressTransfer,
        Error::NoPendingOwnershipTransfer,
        Error::NotPendingOwner,
        Error::NotAuthorizedToAcknowledge,
        Error::InvalidLimit,
        Error::NotificationDelivered,
        Error::CategoryNotRegistered,
        Error::NotificationLifetimeTooLong,
        Error::TemplateNotFound,
        Error::TemplateNameTooLong,
        Error::TemplateContentEmpty,
        Error::DuplicateDelivery,
        Error::NonceAlreadyUsed,
        Error::InvalidNonce,
        Error::NonceExpired,
        Error::NonceContractMismatch,
        Error::NotInitialized,
        Error::AlreadyInitialized,
    ];

    for (index, error) in all.iter().enumerate() {
        let expected_code = (index + 1) as u32;
        assert_eq!(code(*error), expected_code);
        assert_eq!(from_code(expected_code), Some(*error));
    }

    assert_eq!(code(Error::Unauthorized), 8);
    assert_eq!(code(Error::NotInitialized), 46);
    assert_eq!(code(Error::AlreadyInitialized), 47);
    assert_eq!(from_code(0), None);
    assert_eq!(from_code(48), None);
}
