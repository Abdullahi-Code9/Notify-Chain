# Implementation Plan: custom-error-types

## Overview

This implementation plan replaces generic error strings with custom error types throughout the Soroban contract to reduce deployment size and improve gas efficiency.

## Tasks

- [ ] 1. Define custom error enum
  - [ ] 1.1 Create comprehensive error enum in base/errors.rs
    - Add all error variants needed across contract
    - Add documentation for each variant
    - Include AdminUnauthorized, ContractPaused, InvalidNotification, etc.
    - _Requirements: 1.1, 1.2, 2.1, 2.2_

  - [ ] 1.2 Implement error traits
    - Implement Display trait for human-readable errors
    - Implement From traits for error conversion if needed
    - _Requirements: 2.1, 2.2_

- [ ] 2. Replace authorization error strings
  - [ ] 2.1 Update require_admin() function
    - Replace string-based errors with AdminUnauthorized variant
    - Update all panic messages to use custom error
    - _Requirements: 1.1, 1.2_

  - [ ] 2.2 Update authorization checks
    - Replace all authorization error strings in contract
    - Use consistent error types across all auth points
    - _Requirements: 1.1, 1.2_

- [ ] 3. Replace pause mechanism error strings
  - [ ] 3.1 Update pause() function errors
    - Replace AlreadyPaused error strings with custom type
    - Replace AdminUnauthorized strings with custom type
    - _Requirements: 1.1, 1.2_

  - [ ] 3.2 Update unpause() function errors
    - Replace NotPaused error strings with custom type
    - Replace AdminUnauthorized strings with custom type
    - _Requirements: 1.1, 1.2_

  - [ ] 3.3 Update check_not_paused() guard
    - Replace ContractPaused error strings with custom type
    - Apply throughout notification operations
    - _Requirements: 1.1, 1.2_

- [ ] 4. Replace notification creation error strings
  - [ ] 4.1 Update create_notification() errors
    - Replace InvalidNotification strings with custom type
    - Replace InvalidRecipient strings with custom type
    - Replace EmptyRecipientList strings with custom type
    - _Requirements: 1.1, 1.2_

  - [ ] 4.2 Update recipient validation errors
    - Replace TooManyRecipients strings with custom type
    - Replace InvalidRecipient strings with custom type
    - _Requirements: 1.1, 1.2_

- [ ] 5. Replace event validation error strings
  - [ ] 5.1 Update validateEventPayload() errors
    - Replace InvalidEventPayload strings with custom type
    - Replace InvalidTimestamp strings with custom type
    - _Requirements: 1.1, 1.2_

  - [ ] 5.2 Update topic validation errors
    - Replace validation error strings with custom types
    - _Requirements: 1.1, 1.2_

- [ ] 6. Replace state transition error strings
  - [ ] 6.1 Update state validation errors
    - Replace InvalidStateTransition strings with custom type
    - Replace DuplicateOperation strings with custom type
    - _Requirements: 1.1, 1.2_

- [ ] 7. Add unit tests for error types
  - [ ] 7.1 Create error handling tests
    - Test that operations return expected error types
    - Test error messages are descriptive
    - Test error types match documented behavior
    - _Requirements: 3.1, 3.2, 3.3_

  - [ ] 7.2 Test authorization errors
    - Verify AdminUnauthorized returned for non-admin calls
    - Verify InvalidAdmin returned for invalid admin addresses
    - _Requirements: 3.1, 3.2, 3.3_

  - [ ] 7.3 Test pause mechanism errors
    - Verify ContractPaused returned when operations blocked
    - Verify AlreadyPaused returned for duplicate pause
    - Verify NotPaused returned for unpause when not paused
    - _Requirements: 3.1, 3.2, 3.3_

  - [ ] 7.4 Test notification creation errors
    - Verify InvalidNotification returned for invalid notifications
    - Verify InvalidRecipient returned for bad recipients
    - Verify EmptyRecipientList returned for no recipients
    - Verify TooManyRecipients returned for oversized batch
    - _Requirements: 3.1, 3.2, 3.3_

  - [ ] 7.5 Test event validation errors
    - Verify InvalidEventPayload returned for malformed events
    - Verify InvalidTimestamp returned for bad timestamps
    - _Requirements: 3.1, 3.2, 3.3_

- [ ] 8. Add integration tests
  - [ ] 8.1 Test error propagation
    - Verify errors propagate correctly through call stacks
    - Verify callers receive expected error types
    - _Requirements: 3.4_

  - [ ] 8.2 Test error recovery
    - Verify system can recover after error conditions
    - Verify state is consistent after errors
    - _Requirements: 3.5_

- [ ] 9. Verify deployment size reduction
  - [ ] 9.1 Compare contract sizes
    - Measure before and after deployment sizes
    - Document size reduction percentage
    - _Requirements: 1.1, 1.2_

  - [ ] 9.2 Verify gas efficiency
    - Benchmark error handling gas costs before/after
    - Document gas usage improvements
    - _Requirements: 1.1_

- [ ] 10. Update documentation
  - [ ] 10.1 Document error types
    - Add error reference documentation
    - Include when each error occurs
    - Include error recovery steps
    - _Requirements: 2.1, 2.2, 2.3_

  - [ ] 10.2 Update contract documentation
    - Update error handling guide
    - Add error handling examples
    - Document custom error usage patterns
    - _Requirements: 2.1, 2.2, 2.3_

## Notes

- Custom error enums are more efficient than string errors
- Each error variant should have a descriptive name
- Error types should be organized by category
- Tests must verify correct error type for each condition
- Documentation should help integrators understand errors