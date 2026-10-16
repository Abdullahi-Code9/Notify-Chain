# Implementation Plan: Expand Payload Validation Tests

## Overview

This implementation plan converts the design's 5-phase approach into actionable coding tasks. The test suite will achieve comprehensive coverage of the `metadata_validation` module through systematic unit tests, property-based tests, and documentation. Each task builds incrementally, with property-based tests integrated near implementation to catch errors early.

## Tasks

- [ ] 1. Phase 1: Test Infrastructure Setup
  - [ ] 1.1 Create test data generator functions
    - Implement `generate_string_at_length(env: &Env, length: u32) -> String`
    - Implement `generate_string_over_length(env: &Env, length: u32) -> String`
    - Implement `generate_custom_fields(env: &Env, count: u32) -> Map<String, String>`
    - Implement `generate_unicode_string(env: &Env) -> String`
    - Implement `generate_control_character_string(env: &Env) -> String`
    - File: `contract/contracts/hello-world/src/tests/payload_validation_test.rs`
    - _Requirements: 9.1, 9.2, 9.3, 10.1_

  - [ ] 1.2 Create test helper and assertion functions
    - Implement `assert_validation_ok(result: Result<(), Error>)`
    - Implement `assert_validation_rejected_with_invalid_input(result: Result<(), Error>)`
    - Implement `metadata_with_title(env: &Env, title: &str) -> NotificationMetadata`
    - Implement `calculate_metadata_size(metadata: &NotificationMetadata) -> u32`
    - File: `contract/contracts/hello-world/src/tests/payload_validation_test.rs`
    - _Requirements: 9.1, 10.1, 10.2_

  - [ ] 1.3 Add module-level documentation and establish test organization structure
    - Write module-level doc comment explaining test organization (6 categories)
    - Write doc comments for test data generators
    - Write doc comments for test helper functions
    - Document coverage approach and test strategy
    - File: `contract/contracts/hello-world/src/tests/payload_validation_test.rs`
    - _Requirements: 10.1, 10.2, 10.4_

  - [ ]* 1.4 Set up coverage measurement baseline
    - Configure `llvm-cov` for test coverage reporting
    - Establish baseline coverage metrics for `metadata_validation.rs`
    - Document coverage configuration
    - File: `contract/contracts/hello-world/` configuration
    - _Requirements: 9.1, 9.5_

- [ ] 2. Phase 2: Core Unit Tests — Required and Optional Fields
  - [ ] 2.1 Implement required field validation tests
    - Implement `test_title_valid_accepted()` — valid non-empty title
    - Implement `test_title_empty_rejected()` — empty title rejection
    - Implement `test_title_null_rejected()` — null title rejection
    - Implement `test_title_whitespace_rejected()` — whitespace-only rejection
    - File: `contract/contracts/hello-world/src/tests/payload_validation_test.rs`
    - _Requirements: 1.1, 1.2, 1.3, 1.4, Property 1_

  - [ ]* 2.2 Write property test for required fields validation
    - **Property 1: Valid non-empty titles are always accepted**
    - **Validates: Requirements 1.3**
    - Implement property-based test with 100+ iterations
    - Generate random non-empty, non-whitespace titles (1-256 bytes)
    - Verify all pass validation
    - File: `contract/contracts/hello-world/src/tests/payload_validation_test.rs`
    - _Requirements: 1.3, Property 1_

  - [ ] 2.3 Implement optional field validation tests
    - Implement `test_description_missing_accepted()` — missing description
    - Implement `test_description_none_accepted()` — None description
    - Implement `test_description_valid_accepted()` — valid description
    - Implement `test_data_uri_missing_accepted()` — missing data_uri
    - Implement `test_data_uri_none_accepted()` — None data_uri
    - Implement `test_data_uri_valid_accepted()` — valid data_uri
    - File: `contract/contracts/hello-world/src/tests/payload_validation_test.rs`
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, Property 4_

  - [ ]* 2.4 Write property test for optional fields validation
    - **Property 4: Optional fields can be absent without rejection**
    - **Validates: Requirements 3.1, 3.2, 3.4, 3.5**
    - Implement property-based test with 100+ iterations
    - Generate payloads with random combinations of absent/present optional fields
    - Verify all with valid titles pass validation
    - File: `contract/contracts/hello-world/src/tests/payload_validation_test.rs`
    - _Requirements: 3.1, 3.2, 3.4, 3.5, Property 4_

  - [ ] 2.5 Checkpoint — Verify Phase 2 tests pass
    - Run all Phase 2 tests: `cargo test payload_validation`
    - Verify all 10 unit tests pass
    - Verify property tests pass with 100+ iterations
    - Check coverage increased from baseline
    - _Requirements: 9.1, 9.5_

- [ ] 3. Phase 3: Core Unit Tests — Length and Size Constraints
  - [ ] 3.1 Implement title length constraint tests
    - Implement `test_title_at_max_length_accepted()` — 256 bytes exactly
    - Implement `test_title_over_max_length_rejected()` — 257 bytes exactly
    - File: `contract/contracts/hello-world/src/tests/payload_validation_test.rs`
    - _Requirements: 2.1, 2.2, Property 2, Property 3_

  - [ ] 3.2 Implement description and data_uri length constraint tests
    - Implement `test_description_at_max_length_accepted()` — 256 bytes exactly
    - Implement `test_description_over_max_length_rejected()` — 257 bytes exactly
    - Implement `test_data_uri_at_max_length_accepted()` — 256 bytes exactly
    - Implement `test_data_uri_over_max_length_rejected()` — 257 bytes exactly
    - File: `contract/contracts/hello-world/src/tests/payload_validation_test.rs`
    - _Requirements: 2.3, 2.4, 2.5, 2.6, Property 2, Property 3_

  - [ ] 3.3 Implement custom field key/value length constraint tests
    - Implement `test_custom_field_key_at_max_length_accepted()` — 256 bytes exactly
    - Implement `test_custom_field_key_over_max_length_rejected()` — 257 bytes exactly
    - Implement `test_custom_field_value_at_max_length_accepted()` — 256 bytes exactly
    - Implement `test_custom_field_value_over_max_length_rejected()` — 257 bytes exactly
    - File: `contract/contracts/hello-world/src/tests/payload_validation_test.rs`
    - _Requirements: 2.7, 2.8, 2.9, 2.10, Property 2, Property 3_

  - [ ]* 3.4 Write property test for string length constraints
    - **Property 2: All string fields respect maximum length constraint**
    - **Validates: Requirements 2.1, 2.3, 2.5, 2.7, 2.9**
    - Implement property-based test with 100+ iterations
    - Generate metadata with all fields at random lengths (0-256 bytes)
    - Verify all pass validation
    - _Requirements: 2.1, 2.3, 2.5, 2.7, 2.9, Property 2_

  - [ ]* 3.5 Write property test for string length rejection
    - **Property 3: Any string field exceeding 256 bytes is rejected**
    - **Validates: Requirements 2.2, 2.4, 2.6, 2.8, 2.10**
    - Implement property-based test with 100+ iterations
    - Generate metadata with at least one field over 256 bytes
    - Verify all fail validation with InvalidInput error
    - _Requirements: 2.2, 2.4, 2.6, 2.8, 2.10, Property 3_

  - [ ] 3.6 Implement metadata total size constraint tests
    - Implement `test_metadata_size_at_exact_boundary_accepted()` — 4096 bytes exactly
    - Implement `test_metadata_size_over_boundary_rejected()` — 4097 bytes exactly
    - Implement `test_metadata_combined_max_fields_within_limit_accepted()` — max fields but within limit
    - Implement `test_metadata_combined_max_fields_over_limit_rejected()` — max fields exceeding limit
    - Implement `test_metadata_many_small_fields_over_limit_rejected()` — many fields exceeding limit
    - Implement `test_metadata_max_title_description_data_uri_within_limit_accepted()` — all optional fields at max
    - File: `contract/contracts/hello-world/src/tests/payload_validation_test.rs`
    - _Requirements: 5.1, 5.2, 5.3, 5.4, Property 6_

  - [ ]* 3.7 Write property test for total metadata size
    - **Property 6: Total metadata size is enforced**
    - **Validates: Requirements 5.1, 5.2, 5.3, 5.4**
    - Implement property-based test with 100+ iterations
    - Generate metadata with total sizes at random values (0-5000 bytes)
    - Verify payloads under 4096 bytes pass, over 4096 bytes fail
    - _Requirements: 5.1, 5.2, 5.3, 5.4, Property 6_

  - [ ] 3.8 Checkpoint — Verify Phase 3 tests pass and coverage metrics
    - Run all Phase 3 tests: `cargo test payload_validation`
    - Verify all 11 unit tests pass (6 length + 5 size)
    - Verify property tests pass with 100+ iterations each
    - Check line coverage for `validate_metadata()` function
    - _Requirements: 9.1, 9.2, 9.5_

- [ ] 4. Phase 4: Complex Tests — Custom Fields and Edge Cases
  - [ ] 4.1 Implement custom field structure validation tests
    - Implement `test_custom_fields_none_accepted()` — None custom_fields
    - Implement `test_custom_fields_empty_map_accepted()` — empty map
    - Implement `test_custom_fields_at_max_count_accepted()` — exactly 20 fields
    - Implement `test_custom_fields_over_max_count_rejected()` — 21 fields
    - Implement `test_custom_fields_duplicate_keys_valid_values_accepted()` — duplicate keys
    - Implement `test_custom_fields_empty_key_accepted()` — empty string key
    - Implement `test_custom_fields_empty_value_accepted()` — empty string value
    - File: `contract/contracts/hello-world/src/tests/payload_validation_test.rs`
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, Property 5_

  - [ ]* 4.2 Write property test for custom field count constraints
    - **Property 5: Custom field count respects maximum constraint**
    - **Validates: Requirements 4.2, 4.3, 4.4**
    - Implement property-based test with 100+ iterations
    - Generate metadata with random custom field counts (0-25 fields)
    - Verify counts 0-20 pass, 21+ fail with InvalidInput
    - _Requirements: 4.2, 4.3, 4.4, Property 5_

  - [ ] 4.3 Implement edge case tests — boundary values and special characters
    - Implement `test_title_single_character_accepted()` — single character title
    - Implement `test_title_unicode_emoji_accepted()` — emoji in title
    - Implement `test_title_unicode_characters_accepted()` — unicode characters
    - Implement `test_title_numeric_only_accepted()` — numeric-only title
    - Implement `test_field_control_characters_accepted()` — newlines, tabs
    - File: `contract/contracts/hello-world/src/tests/payload_validation_test.rs`
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 7.1, 7.2, 7.3, 7.4, Property 7_

  - [ ]* 4.4 Write property test for UTF-8 string validation
    - **Property 7: UTF-8 encoded strings are validated consistently**
    - **Validates: Requirements 6.1, 6.2, 6.3, 6.4**
    - Implement property-based test with 100+ iterations
    - Generate metadata with random UTF-8 strings (unicode, emoji, multi-byte sequences)
    - Verify all valid UTF-8 within length constraints pass validation
    - _Requirements: 6.1, 6.2, 6.3, 6.4, Property 7_

  - [ ] 4.5 Implement complex multi-field scenario tests
    - Implement `test_complex_all_fields_maximum_length_accepted()` — all fields at max within size limit
    - Implement `test_complex_max_title_max_description_max_uri_within_limit_accepted()` — all 3 optional fields max
    - Implement `test_complex_max_title_max_custom_fields_accepted()` — title + 20 custom fields
    - Implement `test_complex_all_optional_fields_populated_at_max_accepted()` — complete maximal payload
    - File: `contract/contracts/hello-world/src/tests/payload_validation_test.rs`
    - _Requirements: 8.1, 8.2, 8.3, 8.4, Property 8_

  - [ ]* 4.6 Write property test for complex payload validation
    - **Property 8: Complex payloads with all fields at maximum valid sizes are accepted**
    - **Validates: Requirements 8.1, 8.3, 8.4**
    - Implement property-based test with 100+ iterations
    - Generate complex metadata with multiple fields populated at various sizes
    - Verify all valid combinations pass validation
    - _Requirements: 8.1, 8.3, 8.4, Property 8_

  - [ ] 4.7 Checkpoint — Verify Phase 4 tests pass and coverage targets
    - Run all Phase 4 tests: `cargo test payload_validation`
    - Verify all 11 unit tests pass (7 custom field + 4 edge + 4 complex)
    - Verify property tests pass with 100+ iterations each
    - Check that line coverage reaches 95% target for `metadata_validation.rs`
    - Check that branch coverage reaches 100% for `validate_metadata()` and `validate_metadata_size()`
    - _Requirements: 9.1, 9.2, 9.3, 9.5_

- [ ] 5. Phase 5: Documentation and Coverage Reporting
  - [ ] 5.1 Add comprehensive inline documentation to all test functions
    - Add doc comment to each test with scenario description
    - Add requirement references to each test (e.g., `Validates: Requirement 2.1, Property 2`)
    - Add category labels (Required Fields, Length Constraints, etc.)
    - Update all helper function documentation with usage examples
    - File: `contract/contracts/hello-world/src/tests/payload_validation_test.rs`
    - _Requirements: 10.1, 10.2, 10.3, 10.4_

  - [ ] 5.2 Generate coverage report and verify targets met
    - Run `cargo test payload_validation` with coverage instrumentation
    - Generate coverage report for `metadata_validation.rs`
    - Verify 95% line coverage achieved
    - Verify 100% branch coverage for `validate_metadata()` achieved
    - Verify 100% branch coverage for `validate_metadata_size()` achieved
    - Document coverage results in comment block within test file
    - File: `contract/contracts/hello-world/src/tests/payload_validation_test.rs`
    - _Requirements: 9.1, 9.2, 9.3, 9.5_

  - [ ] 5.3 Create test-to-requirement mapping documentation
    - Create mapping table showing each requirement mapped to its test case(s)
    - Include test type (Unit, Property, Edge)
    - Include property covered for each test
    - Format as code comment block or separate documentation file
    - File: `contract/contracts/hello-world/src/tests/payload_validation_test.rs` or `.kiro/specs/expand-payload-validation-tests/test-coverage-map.md`
    - _Requirements: 9.4, 10.1, 10.2_

  - [ ] 5.4 Final checkpoint — All tests pass and documentation complete
    - Run full test suite: `cargo test payload_validation`
    - Verify all 45+ unit tests pass
    - Verify all 8 property-based tests pass with 100+ iterations
    - Verify coverage report shows 95% line + 100% branch targets met
    - Verify test-to-requirement mapping is complete and accurate
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 10.1, 10.2, 10.3, 10.4_

## Notes

- Tasks marked with `*` are optional and represent property-based tests that can be skipped for MVP
- Each task references specific requirements and properties for full traceability
- Core implementation tasks build incrementally, with property tests integrated near implementation
- Checkpoints ensure validation at reasonable breaks and allow early problem detection
- Property-based tests use 100+ iterations to ensure comprehensive random value coverage
- Coverage verification happens in phases to catch gaps early
- All 8 properties from design map directly to property-based test sub-tasks
