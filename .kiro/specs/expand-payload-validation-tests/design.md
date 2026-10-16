# Design Document: Expand Payload Validation Tests

## Overview

This design expands automated test coverage for the `metadata_validation` module to achieve comprehensive validation of all payload scenarios. The testing strategy targets 95% line coverage and 100% branch coverage through a dual approach of property-based testing and targeted unit tests organized by validation category.

The current implementation validates notification payloads across six dimensions:
1. Required field presence (title must exist and be non-empty)
2. String length constraints (individual fields capped at 256 bytes)
3. Optional field handling (description, data_uri, custom_fields)
4. Custom field structure (up to 20 key-value pairs, each constrained)
5. Total metadata size constraints (4096 byte limit)
6. Type/encoding validation (UTF-8 strings)

The expanded test suite will systematically cover each dimension with both positive and negative cases, boundary values, and edge cases.

## Architecture

### Test Organization Structure

Tests are organized into six logical categories mirroring the validation rules:

```
payload_validation_test.rs
├── Required Fields Tests
│   ├── Valid title acceptance
│   ├── Empty title rejection
│   ├── Null title rejection
│   └── Whitespace-only title rejection
├── Length Constraint Tests
│   ├── Title boundary tests (256, 257 bytes)
│   ├── Description boundary tests
│   ├── Data URI boundary tests
│   └── Custom field key/value boundary tests
├── Optional Field Tests
│   ├── Missing field acceptance
│   ├── None value acceptance
│   └── Valid optional field acceptance
├── Custom Field Structure Tests
│   ├── None custom_fields acceptance
│   ├── Empty map acceptance
│   ├── Maximum field count acceptance
│   ├── Over-maximum rejection
│   └── Duplicate key handling
├── Size Constraint Tests
│   ├── Exact size boundary (4096 bytes)
│   ├── Over-size rejection (4097 bytes)
│   └── Combined maximum-length fields tests
└── Edge Case Tests
    ├── Single-character title
    ├── Unicode and emoji in title
    ├── Control characters in fields
    ├── Empty string keys/values
    └── Complex multi-field scenarios
```

### Test Naming Convention

Test names follow a descriptive pattern: `test_{component}_{scenario}_{boundary|variant}`

Examples:
- `test_title_empty_rejected` — tests empty title rejection
- `test_title_at_max_length_accepted` — tests title at exact boundary
- `test_custom_fields_count_over_max_rejected` — tests field count limit
- `test_metadata_size_at_exact_boundary_accepted` — tests size boundary
- `test_complex_all_fields_maximum_length_accepted` — tests complex scenario

## Components and Interfaces

### Validation Module Interface

The test suite validates against two core functions:

```rust
pub fn validate_metadata(metadata: &NotificationMetadata) -> Result<(), Error>
pub fn validate_metadata_size(metadata: &NotificationMetadata) -> Result<(), Error>
```

**NotificationMetadata Structure:**
```rust
pub struct NotificationMetadata {
    pub title: String,                              // Required, 1-256 bytes
    pub description: Option<String>,                // Optional, 0-256 bytes
    pub data_uri: Option<String>,                   // Optional, 0-256 bytes
    pub custom_fields: Option<Map<String, String>>, // Optional, 0-20 fields, each 0-256 bytes
}
```

**Constants:**
- `MAX_METADATA_STRING_LENGTH = 256` bytes
- `MAX_METADATA_FIELDS = 20`
- `MAX_METADATA_SIZE = 4096` bytes

### Test Data Generators

Custom generators produce boundary-value test data:

```rust
fn generate_string_at_length(env: &Env, length: u32) -> String
fn generate_string_over_length(env: &Env, length: u32) -> String
fn generate_custom_fields(env: &Env, count: u32) -> Map<String, String>
fn generate_metadata_at_size_boundary(env: &Env, target_size: u32) -> NotificationMetadata
fn generate_unicode_string(env: &Env) -> String
fn generate_control_character_string(env: &Env) -> String
```

### Test Utilities and Helpers

Helper functions support test execution and validation:

```rust
// Assertion helpers
fn assert_validation_ok(result: Result<(), Error>)
fn assert_validation_rejected_with_invalid_input(result: Result<(), Error>)

// Metadata builders
fn metadata_with_title(env: &Env, title: &str) -> NotificationMetadata
fn metadata_builder(env: &Env) -> MetadataBuilder

// Size calculations
fn calculate_metadata_size(metadata: &NotificationMetadata) -> u32
```

## Data Models

### Test Data Categories

**1. Required Field Tests**
- Empty strings: `""`
- Null/None values
- Whitespace variations: ` `, `\t`, `\n`
- Valid titles: `"Test"`, `"1"`, `"A"`, unicode strings

**2. Boundary Value Tests**
- Exactly 256 bytes (valid boundary)
- Exactly 257 bytes (invalid boundary)
- For custom fields: 0, 1, 20, 21 fields

**3. Edge Cases**
- Single character: `"A"`
- Unicode: `"🚀"`, `"你好"`
- Control characters: `"\n"`, `"\r"`, `"\t"`
- Mixed multi-byte UTF-8 sequences

**4. Complex Scenarios**
- All three optional fields at max length
- Maximum custom fields with valid content
- Combinations totaling exactly 4096 bytes
- Combinations totaling over 4096 bytes

### Size Estimation

Total metadata size is calculated as the sum of:
- Title length (bytes)
- Description length (bytes) if present
- Data URI length (bytes) if present
- Sum of all custom field key lengths (bytes)
- Sum of all custom field value lengths (bytes)

No serialization overhead is included in the estimation — only raw string lengths.

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system—essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

### Property 1: Valid non-empty titles are always accepted

*For any* notification metadata with a non-empty, non-whitespace title of length 1 to 256 bytes, `validate_metadata()` should return `Ok(())`.

**Validates: Requirements 1.3**

### Property 2: All string fields respect maximum length constraint

*For any* notification metadata where all string fields (title, description, data_uri, and all custom field keys/values) are at most 256 bytes, `validate_metadata()` should return `Ok(())`.

**Validates: Requirements 2.1, 2.3, 2.5, 2.7, 2.9**

### Property 3: Any string field exceeding 256 bytes is rejected

*For any* notification metadata where at least one string field exceeds 256 bytes, `validate_metadata()` should return `Err(Error::InvalidInput)`.

**Validates: Requirements 2.2, 2.4, 2.6, 2.8, 2.10**

### Property 4: Optional fields can be absent without rejection

*For any* notification metadata where description and/or data_uri are `None`, and custom_fields is `None`, `validate_metadata()` should return `Ok(())` if the title is valid.

**Validates: Requirements 3.1, 3.2, 3.4, 3.5, 4.1**

### Property 5: Custom field count respects maximum constraint

*For any* notification metadata with 0 to 20 custom fields where all keys and values are at most 256 bytes, `validate_metadata()` should return `Ok(())`. Conversely, metadata with 21 or more custom fields should return `Err(Error::InvalidInput)`.

**Validates: Requirements 4.2, 4.3, 4.4**

### Property 6: Total metadata size is enforced

*For any* notification metadata where the sum of all field lengths (title + description + data_uri + all custom field keys and values) does not exceed 4096 bytes, `validate_metadata_size()` should return `Ok(())`. When the sum exceeds 4096 bytes, it should return `Err(Error::InvalidInput)`.

**Validates: Requirements 5.1, 5.2, 5.3, 5.4**

### Property 7: UTF-8 encoded strings are validated consistently

*For any* notification metadata composed entirely of valid UTF-8 encoded strings, including unicode characters and multi-byte sequences, validation should succeed if all other constraints are satisfied.

**Validates: Requirements 6.1, 6.2, 6.3, 6.4**

### Property 8: Complex payloads with all fields at maximum valid sizes are accepted

*For any* notification metadata where title, description, data_uri, and custom fields (up to 20) are all populated with valid content such that the total size does not exceed 4096 bytes, both `validate_metadata()` and `validate_metadata_size()` should return `Ok(())`.

**Validates: Requirements 8.1, 8.3, 8.4**

## Error Handling

### Validation Errors

The validation module returns a single error type for all validation failures:

```rust
Error::InvalidInput
```

Error conditions:
- Empty or null title
- Any string field exceeds 256 bytes
- Custom field count exceeds 20
- Total metadata size exceeds 4096 bytes
- Whitespace-only title (treated as invalid)

### Test Error Assertions

Each test case asserts either:
1. `assert!(result.is_ok())` — validation passed
2. `assert!(result.is_err())` — validation rejected with error

No error message inspection is required; all validation failures produce the same error type.

## Testing Strategy

### Dual Testing Approach

The test suite employs two complementary testing techniques:

**Unit Tests (Targeted Examples)**
- Specific boundary values (256, 257, 0, 1, 20, 21)
- Concrete invalid cases (empty strings, over-max fields)
- Edge cases (single character, unicode, control characters)
- Complex scenarios (all fields at maximum)
- Approximately 40-50 individual unit tests

**Property-Based Tests (Universal Quantification)**
- Random valid payloads always pass validation
- Random invalid payloads always fail validation
- Randomly generated strings preserve validation semantics
- Custom field combinations respect count and size constraints
- Approximately 8 property-based tests, each running 100+ iterations

### Unit Test Coverage by Category

1. **Required Fields (8 tests)**
   - Valid non-empty titles
   - Empty title rejection
   - Null title handling
   - Whitespace-only rejection

2. **Length Constraints (16 tests)**
   - Title at/over boundary (4 tests)
   - Description at/over boundary (4 tests)
   - Data URI at/over boundary (4 tests)
   - Custom field key/value at/over boundary (4 tests)

3. **Optional Fields (6 tests)**
   - Missing description
   - None description
   - Valid description
   - Missing data_uri
   - None data_uri
   - Valid data_uri

4. **Custom Field Structure (8 tests)**
   - None custom_fields
   - Empty custom_fields
   - Exactly 20 fields
   - 21 fields (over limit)
   - Duplicate keys with valid values
   - Empty string key/value handling

5. **Size Constraints (6 tests)**
   - Exactly 4096 bytes (accept)
   - 4097 bytes (reject)
   - Max title + description + data_uri within limit
   - Max title + 20 custom fields within limit
   - Multiple small fields exceeding limit

6. **Edge Cases (8 tests)**
   - Single character title
   - Unicode characters (emoji)
   - Control characters
   - Numeric-only title
   - Complex: all fields maximum and within size

7. **Property Tests (8 tests)**
   - Valid payloads always pass
   - Invalid single-field violations always fail
   - String length distribution over random values
   - Custom field count distribution
   - Size accumulation across fields
   - UTF-8 character handling
   - Boundary condition robustness

### Coverage Reporting

**Line Coverage Goals:**
- `metadata_validation.rs`: 95% minimum
- `validate_metadata()` function: 100%
- `validate_metadata_size()` function: 100%
- Helper functions: 95%+

**Branch Coverage Goals:**
- `validate_metadata()`: 100% (all if/else branches)
- `validate_metadata_size()`: 100% (both pass/fail paths)

**Coverage Tools:**
- Use `llvm-cov` for Rust test coverage reporting
- Generate coverage reports after each test run
- Coverage must be verified before merging

**Coverage Mapping:**
Each test includes a comment documenting which requirements it validates:
```rust
// Validates: Requirement 2.1 - Title exactly at MAX_METADATA_STRING_LENGTH
#[test]
fn test_title_at_max_length_accepted() { ... }
```

A mapping document tracks test-to-requirement associations:
```
Title Boundary Tests:
  - test_title_at_max_length_accepted → Requirement 2.1, Property 2
  - test_title_over_max_length_rejected → Requirement 2.2, Property 3
  - test_title_empty_rejected → Requirement 1.1, Property 1
  ...
```

## Test Case Documentation Strategy

### Module-Level Documentation

Each test file includes comprehensive module documentation:

```rust
//! Payload Validation Tests
//!
//! This module validates the metadata_validation module through a systematic
//! approach organized by validation rule category.
//!
//! ## Test Organization
//!
//! Tests are organized into six categories:
//! 1. **Required Fields** — Validate that required fields (title) are present and non-empty
//! 2. **Length Constraints** — Validate that all string fields respect MAX_METADATA_STRING_LENGTH (256 bytes)
//! 3. **Optional Fields** — Validate that optional fields (description, data_uri, custom_fields) can be absent
//! 4. **Custom Field Structure** — Validate custom_fields map constraints (count, key/value lengths)
//! 5. **Size Constraints** — Validate total metadata size does not exceed 4096 bytes
//! 6. **Edge Cases** — Validate handling of boundary values, unicode, control characters
//!
//! ## Coverage Approach
//!
//! The suite combines unit tests for specific scenarios with property-based tests for universal properties.
//! Combined coverage targets: 95% line coverage, 100% branch coverage for core validation functions.
//!
//! ## Test Data Generation
//!
//! Boundary values and edge cases are generated using dedicated helper functions to ensure
//! consistency and reproducibility across test categories.
```

### Individual Test Documentation

Each test case includes clear documentation:

```rust
/// Tests that a title exactly at MAX_METADATA_STRING_LENGTH (256 bytes) is accepted.
///
/// This validates Requirement 2.1: "WHEN a payload has a title exactly at
/// MAX_METADATA_STRING_LENGTH (256 bytes), THE Payload_Validator SHALL accept it"
///
/// Validates: Requirement 2.1, Property 2: All string fields respect maximum length constraint
/// Category: Length Constraints — Boundary Values
#[test]
fn test_title_at_max_length_accepted() {
    // implementation
}
```

### Documentation Coverage Mapping

A generated table documents coverage:

```
| Requirement | Test Case | Test Type | Property Covered | Status |
|-------------|-----------|-----------|------------------|--------|
| 1.1 | test_title_empty_rejected | Unit | Property 1 | ✓ |
| 1.2 | test_title_null_rejected | Unit | Property 1 | ✓ |
| 1.3 | test_title_valid_accepted | Unit | Property 1 | ✓ |
| 1.4 | test_title_whitespace_rejected | Edge | Property 1 | ✓ |
| 2.1 | test_title_at_max_length_accepted | Unit | Property 2 | ✓ |
...
```

### Helper Function Documentation

Each test helper includes inline documentation:

```rust
/// Generates a string of exactly `length` bytes of valid UTF-8 content.
/// 
/// Used for boundary value testing at MAX_METADATA_STRING_LENGTH and size limits.
fn generate_string_at_length(env: &Env, length: u32) -> String {
    // implementation
}

/// Generates a map with exactly `count` custom fields, each with valid 256-byte
/// key and value strings.
///
/// Used for testing custom field count boundaries (0, 20, 21 fields).
fn generate_custom_fields(env: &Env, count: u32) -> Map<String, String> {
    // implementation
}
```

## Implementation Approach

### Phase 1: Test Infrastructure (Week 1)
1. Create test data generators for boundary values
2. Implement test helper functions
3. Set up test environment and utilities
4. Establish coverage measurement baseline

### Phase 2: Core Unit Tests (Week 2)
1. Implement required field tests (8 tests)
2. Implement length constraint tests (16 tests)
3. Implement optional field tests (6 tests)
4. Run coverage analysis and identify gaps

### Phase 3: Complex Tests (Week 3)
1. Implement custom field structure tests (8 tests)
2. Implement size constraint tests (6 tests)
3. Implement edge case tests (8 tests)
4. Verify coverage reaches 95% line and 100% branch

### Phase 4: Property-Based Tests (Week 4)
1. Implement property-based test framework
2. Create 8 property-based tests with 100+ iterations each
3. Integrate coverage reporting
4. Finalize documentation and coverage mapping

### Phase 5: Documentation (Week 5)
1. Complete inline test documentation
2. Generate coverage reports
3. Create requirement-to-test mapping
4. Verify all requirements are covered

