# Design Document

## Overview

This design replaces generic error strings with custom Rust error types in the Soroban smart contract to reduce deployment size and improve gas efficiency.

## Architecture

### Error Type Structure

```rust
#[derive(Debug)]
pub enum NotificationError {
    // Authorization errors
    AdminUnauthorized,
    InvalidAdmin,
    
    // State errors
    ContractPaused,
    AlreadyPaused,
    NotPaused,
    
    // Notification errors
    NotificationNotFound,
    InvalidNotification,
    InvalidRecipient,
    
    // Validation errors
    InvalidTimestamp,
    InvalidEventPayload,
    EmptyRecipientList,
    TooManyRecipients,
    
    // State transition errors
    InvalidStateTransition,
    DuplicateOperation,
}
```

### Implementation Strategy

1. Define comprehensive error enum in `base/errors.rs`
2. Replace all `require!` macro with custom error returns
3. Update error handling in all modules
4. Add error conversion traits if needed
5. Update tests to verify error types

### Integration Points

- **Authorization module**: AdminUnauthorized, InvalidAdmin
- **Pause mechanism**: ContractPaused, AlreadyPaused, NotPaused
- **Event validation**: InvalidEventPayload, InvalidTimestamp
- **Notification creation**: NotificationNotFound, InvalidNotification
- **Recipient validation**: InvalidRecipient, EmptyRecipientList, TooManyRecipients

### Gas Savings

- Custom error enums: ~4 bytes per error vs 30+ bytes for strings
- Estimated reduction: 10-20% of contract size
- Reduced storage reads for error handling