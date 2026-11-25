# Implementation Plan: Email Provider Adapter

## Overview

Implement a trait-based email provider adapter system that enables delivery of contract event notifications through multiple pluggable email providers (SMTP, SendGrid, AWS SES) without coupling provider-specific logic to the event pipeline. The system includes configuration-driven provider selection, exponential retry backoff, provider failover, secure credential management, comprehensive audit logging, and full testability via MockEmailProvider.

## Tasks

- [ ] 1. Set up email adapter module structure and core interfaces
  - Create `src/adapters/email/` module with submodules: `formatter`, `providers`, `retry`, `config`, `models`
  - Define core traits: `EmailProvider`, `EmailFormatter`, `RetryManager`
  - Define data models: `EmailMessage`, `EmailRecipient`, `DeliveryResult`, `ProviderError`, `HealthStatus`
  - Create error types with provider error classification (transient vs permanent)
  - Set up test utilities module with test fixtures
  - _Requirements: 2, 10, 13_

- [ ] 2. Implement email message data models and validation
  - [ ] 2.1 Create `EmailMessage` struct with all required fields
    - event_id, event_type, event_category, priority, timestamp
    - Recipient fields: to, cc, bcc, reply_to
    - Content fields: subject, body_plain_text, body_html
    - Headers map and unsubscribe_token
    - _Requirements: 1, 10, 23_
  
  - [ ]* 2.2 Write property test for EmailMessage structure
    - **Property 1: Formatted Emails Are Valid**
    - **Validates: Requirements 1.1-1.8**
    - Test that formatted messages have non-empty subject/body, valid email addresses, proper headers
  
  - [ ] 2.3 Create `ProviderError` enum with error classification
    - AuthenticationError, RateLimitError, ProviderUnavailableError
    - InvalidRecipientError, InvalidConfigError, TemplateError, UnknownError
    - Implement `is_transient()` and `is_permanent()` methods
    - _Requirements: 11.1-11.9_
  
  - [ ]* 2.4 Write property test for error classification
    - **Property 2: Error Classification Is Correct**
    - **Validates: Requirements 11.1-11.9**
    - Test that error types are correctly classified as transient or permanent

- [ ] 3. Implement configuration loading and validation
  - [ ] 3.1 Create configuration structs for email integration
    - EmailConfig, ProviderConfig, FormatterConfig, RetryConfig, FilterConfig, RecipientRoutingConfig
    - Support TOML/JSON format with environment variable substitution
    - _Requirements: 7, 21_
  
  - [ ] 3.2 Implement configuration loader with validation
    - Load from file or environment
    - Validate required fields, apply defaults for optional fields
    - Log validation errors without exposing credentials
    - Reject configuration with missing required fields
    - _Requirements: 21.1-21.10_
  
  - [ ] 3.3 Implement credential manager
    - Load credentials from environment variables (with precedence order)
    - Validate credential format (basic checks: not empty, length constraints)
    - Redact credentials in error messages and logs
    - Support credential validation without external calls
    - _Requirements: 9.1-9.10_

- [ ] 4. Implement Email Formatter component
  - [ ] 4.1 Create formatter core with template loading
    - Scan template directory for template files (event_type.txt, event_type.html, event_type.subject)
    - Load default templates for all event categories
    - Handle missing template files gracefully
    - _Requirements: 1.1-1.8, 22_
  
  - [ ] 4.2 Implement template rendering engine
    - Use lightweight template engine (Handlebars or similar)
    - Render subject, plain text body, HTML body
    - Handle missing variables gracefully (skip or default)
    - Validate rendered output doesn't exceed size limits
    - _Requirements: 1.1-1.8, 8, 23_
  
  - [ ] 4.3 Implement email header generation
    - Generate Message-ID, X-Event-ID, X-Contract-ID, X-Notification-Priority headers
    - Generate List-Unsubscribe header with token
    - Set proper Content-Type with UTF-8 encoding
    - _Requirements: 10.1-10.9_
  
  - [ ] 4.4 Implement message composition and validation
    - Validate subject length (max 255 chars), truncate if needed
    - Validate email addresses (RFC 5322 compliance)
    - Enforce message size limits per provider
    - Validate UTF-8 encoding
    - _Requirements: 1.1-1.8, 14, 23_
  
  - [ ]* 4.5 Write property tests for Email Formatter
    - **Property 1: Formatted Emails Are Valid**
    - **Validates: Requirements 1.1-1.8**
    - Test all event categories format successfully with valid structure
    - Test subject/body truncation for size limits
    - Test invalid recipient rejection

- [ ] 5. Implement Provider Abstraction Trait
  - [ ] 5.1 Define EmailProvider trait with required methods
    - send_email(message, recipient) → Result<DeliveryResult>
    - validate_credentials() → Result<()>
    - health_check() → HealthStatus
    - get_provider_name() → &str
    - get_provider_config() → &ProviderConfig
    - _Requirements: 2.1-2.8, 20_
  
  - [ ] 5.2 Create provider registry and factory
    - Support provider creation by type (smtp, sendgrid, aws_ses)
    - Support multiple provider instances (primary, failover, tertiary)
    - Lazy-load provider implementations
    - _Requirements: 3, 25_

- [ ] 6. Implement SMTP Provider
  - [ ] 6.1 Create SMTP provider implementation
    - Support SMTP and SMTPS (TLS) connections
    - Accept configuration: host, port, use_tls, username, password, from_address
    - Implement connection management with timeout (30s connection, 60s total)
    - _Requirements: 4.1-4.9_
  
  - [ ] 6.2 Implement SMTP message composition and sending
    - Compose SMTP commands and message format (RFC 5321)
    - Handle SMTP response codes: 250 (success), 421, 450 (temporary), 550 (permanent)
    - Map SMTP errors to standardized ProviderError types
    - _Requirements: 4.1-4.9_
  
  - [ ] 6.3 Implement SMTP credential validation
    - Validate username/password non-empty
    - Attempt EHLO to validate connection (without sending test email)
    - _Requirements: 4.3_
  
  - [ ]* 6.4 Write unit tests for SMTP provider (mocked SMTP client)
    - Test successful message delivery
    - Test SMTP error code handling (421, 450, 550, etc.)
    - Test connection timeout and network errors
    - Test invalid recipient handling
    - _Requirements: 4.1-4.9, 13_

- [ ] 7. Implement SendGrid Provider
  - [ ] 7.1 Create SendGrid provider implementation
    - Configure API endpoint (default: https://api.sendgrid.com/v3/mail/send)
    - Load API key from credentials
    - _Requirements: 5.1-5.11_
  
  - [ ] 7.2 Implement SendGrid API message composition
    - Construct SendGrid-compatible JSON payload
    - Include email metadata: to, from, subject, content (plain text + HTML)
    - Set Authorization header with Bearer token (redacted in logs)
    - _Requirements: 5.3-5.5_
  
  - [ ] 7.3 Implement SendGrid HTTP response handling
    - Handle 202 Accepted (success) - extract message ID
    - Handle 400 Bad Request - map to InvalidRecipientError or TemplateError
    - Handle 401 Unauthorized - AuthenticationError
    - Handle 429 Too Many Requests - RateLimitError with retry-after
    - Handle 503 Service Unavailable - ProviderUnavailableError
    - _Requirements: 5.5-5.9_
  
  - [ ]* 7.4 Write unit tests for SendGrid provider (mocked HTTP client)
    - Test successful delivery (202 response)
    - Test error responses (400, 401, 429, 503)
    - Test message ID extraction
    - Test rate limit handling with retry-after
    - _Requirements: 5.1-5.11, 13_

- [ ] 8. Implement AWS SES Provider
  - [ ] 8.1 Create AWS SES provider implementation
    - Configure AWS region
    - Load credentials (access key ID, secret key) from environment
    - Use aws-sdk-ses or similar
    - _Requirements: 6.1-6.11_
  
  - [ ] 8.2 Implement SES SendEmail request composition
    - Construct SES request with to, from, subject, body (plain + HTML)
    - Set up configuration set for bounce/complaint tracking (if configured)
    - _Requirements: 6.3-6.4_
  
  - [ ] 8.3 Implement SES response handling
    - Handle success: extract MessageId
    - Handle InvalidParameterValue - InvalidRecipientError
    - Handle MessageRejected - PermanentFailure
    - Handle ThrottlingException - RateLimitError
    - Handle ServiceUnavailable - ProviderUnavailableError
    - _Requirements: 6.5-6.9_
  
  - [ ]* 8.4 Write unit tests for AWS SES provider (mocked AWS client)
    - Test successful delivery with MessageId extraction
    - Test error handling (InvalidParameterValue, MessageRejected, etc.)
    - Test rate limiting
    - Test configuration set integration
    - _Requirements: 6.1-6.11, 13_

- [ ] 9. Implement Retry Manager with exponential backoff
  - [ ] 9.1 Create retry queue and backoff calculation
    - Implement exponential backoff formula: initial * multiplier^(attempt-1), capped at max
    - Store pending messages in retry queue
    - Track attempt count and retry history
    - _Requirements: 12.2-12.10_
  
  - [ ] 9.2 Implement retry processor
    - Wait for calculated backoff duration
    - Attempt delivery with provider failover
    - Classify errors and schedule retry only for transient failures
    - Log all retry attempts
    - _Requirements: 12.1-12.10_
  
  - [ ] 9.3 Implement retry queue persistence (optional but recommended)
    - Serialize pending messages to durable storage
    - Restore queue on system restart
    - _Requirements: 12.9_
  
  - [ ]* 9.4 Write property test for exponential backoff
    - **Property 3: Exponential Backoff Respects Limits**
    - **Validates: Requirements 12.2-12.10**
    - Test backoff calculation for all attempt counts
    - Test max_backoff_ms cap is respected
    - Test permanent failures are not retried

- [ ] 10. Implement Provider Failover and Health Tracking
  - [ ] 10.1 Create provider failover manager
    - Maintain list of providers in priority order
    - Track health: consecutive_failures, last_failure_time, degraded flag
    - Skip degraded primary provider (try secondary instead)
    - _Requirements: 25.1-25.10_
  
  - [ ] 10.2 Implement failover logic with provider recovery
    - Attempt primary, then secondary, then tertiary
    - Mark provider as degraded after 3 consecutive failures
    - Mark provider as recovered on successful delivery
    - Log all failover attempts
    - _Requirements: 25.2-25.8_
  
  - [ ]* 10.3 Write unit tests for provider failover
    - Test failover to secondary provider on primary failure
    - Test provider health tracking and recovery
    - Test all providers fail (fallback to retry logic)
    - _Requirements: 25.1-25.10_

- [ ] 11. Implement Event Filtering and Recipient Selection
  - [ ] 11.1 Create event filter logic
    - Filter by category: included_categories, excluded_categories
    - Filter by priority: included_priorities, excluded_priorities
    - Apply filters consistently
    - _Requirements: 16.1-16.10_
  
  - [ ] 11.2 Implement recipient routing
    - Load static recipient routing from configuration
    - Select recipients based on event category
    - Fall back to default recipients if no category match
    - Support dynamic recipient selection (query database if applicable)
    - _Requirements: 14, 16_
  
  - [ ]* 11.3 Write unit tests for filtering and routing
    - Test event inclusion/exclusion by category and priority
    - Test recipient selection for each category
    - Test default recipient fallback
    - _Requirements: 16.1-16.10_

- [ ] 12. Implement Bounce/Complaint Handling and Suppression List
  - [ ] 12.1 Create suppression list data structure
    - Track hard bounces (permanent suppression)
    - Track soft bounces (temporary suppression with time window)
    - Track complaints and opt-outs
    - Support in-memory storage (with file backup) and database storage
    - _Requirements: 19.1-19.10, 24.1-24.10_
  
  - [ ] 12.2 Implement bounce and complaint event processing
    - Process hard bounce events (mark permanently suppressed)
    - Process soft bounce events (suppress for configured window, e.g., 24 hours)
    - Process complaint events (mark suppressed)
    - Process opt-out/unsubscribe requests
    - _Requirements: 19.1-19.10_
  
  - [ ] 12.3 Implement suppression list checking before delivery
    - Check suppression list before formatting
    - Return Suppressed status if recipient is suppressed
    - Log suppressed deliveries
    - _Requirements: 12, 19.8_
  
  - [ ]* 12.4 Write unit tests for suppression list
    - Test hard bounce suppression (permanent)
    - Test soft bounce suppression with expiration
    - Test complaint suppression
    - Test opt-out/unsubscribe
    - Test suppression list prevents delivery
    - _Requirements: 19.1-19.10, 24.1-24.10_

- [ ] 13. Implement Audit Logging and Delivery Tracking
  - [ ] 13.1 Create audit log data model and storage
    - Log: timestamp, recipient, event_id, event_type, subject, delivery_status, provider, message_id, error_details
    - Support structured logging (JSON format)
    - Redact credentials and sensitive data
    - _Requirements: 18.1-18.10_
  
  - [ ] 13.2 Implement audit log writing
    - Log on every delivery attempt (success and failure)
    - Log on retry attempts
    - Log on bounce/complaint events
    - Log on suppression list additions
    - _Requirements: 18_
  
  - [ ] 13.3 Implement log querying and reporting
    - Query logs by date range, recipient, event_id, status, provider
    - Generate delivery summary reports
    - _Requirements: 18.5, 18.9_

- [ ] 14. Implement Health Check and Status Reporting
  - [ ] 14.1 Create health check logic
    - Report overall adapter status: healthy, degraded, unhealthy
    - Include last successful delivery timestamp
    - Include consecutive failure count
    - Include current provider health details
    - _Requirements: 20.1-20.6_
  
  - [ ] 14.2 Implement metrics collection and export
    - Track: total_events, total_emails_sent, send_attempts, successes, failures, temp_failures, permanent_failures
    - Track per-provider: emails_sent, success_rate, average_response_time
    - Track per-recipient: emails_sent, bounces, complaints, opt_outs
    - Export metrics in Prometheus or project's monitoring format
    - _Requirements: 20.7-20.10_

- [ ] 15. Implement MockEmailProvider for testing
  - [ ] 15.1 Create mock provider implementation
    - Implement EmailProvider trait
    - Track delivered messages in memory
    - Support injecting failures for retry testing
    - _Requirements: 13.1-13.10_
  
  - [ ] 15.2 Implement mock provider utilities
    - inject_failure() to simulate provider errors
    - get_delivered_messages() to verify deliveries in tests
    - assert_delivered_to() helper for test assertions
    - Support simulating rate limiting, transient errors, permanent errors
    - _Requirements: 13_
  
  - [ ]* 15.3 Write unit tests for MockEmailProvider
    - Test successful delivery tracking
    - Test failure injection
    - Test transient failure retry simulation
    - _Requirements: 13_

- [ ] 16. Implement Message Batching (optional enhancement)
  - [ ] 16.1 Create batch queue and aggregation logic
    - Group events by category within time window
    - Aggregate into single email or send individually (config-driven)
    - Respect max events per batch
    - _Requirements: 17.1-17.10_
  
  - [ ] 16.2 Implement batch flushing
    - Flush on window expiration
    - Flush on batch full
    - Flush immediately on critical priority event
    - _Requirements: 17.3-17.7_
  
  - [ ]* 16.3 Write unit tests for batching
    - Test batch aggregation within window
    - Test batch flushing on expiration
    - Test immediate flush on critical event
    - _Requirements: 17.1-17.10_

- [ ] 17. Implement Unsubscribe and Preference Management
  - [ ] 17.1 Generate secure unsubscribe tokens
    - Create cryptographically secure tokens
    - Associate token with recipient and event category
    - _Requirements: 24.6_
  
  - [ ] 17.2 Implement unsubscribe link generation
    - Generate List-Unsubscribe header (RFC 2369)
    - Generate unsubscribe URL from template
    - Include unsubscribe mechanism in email body
    - _Requirements: 24.1-24.3_
  
  - [ ] 17.3 Implement unsubscribe request processing
    - Validate unsubscribe token
    - Add recipient to suppression list
    - Log opt-out event
    - Support re-opt-in mechanism
    - _Requirements: 24.3-24.10_

- [ ] 18. Create comprehensive integration tests with NotificationDispatcher
  - [ ] 18.1 Implement EmailAdapter integration with NotificationDispatcher
    - Implement NotificationAdapter trait
    - Integrate with existing dispatcher interface
    - Non-blocking delivery (failures don't halt dispatcher)
    - _Requirements: 15.1-15.10_
  
  - [ ] 18.2 Write integration tests: end-to-end event flow
    - Test event → filter → format → deliver → audit log
    - Test with multiple recipients
    - Test with multiple providers
    - Test retry behavior on failure
    - _Requirements: 15_
  
  - [ ] 18.3 Write integration tests: failover scenarios
    - Test primary provider fails, secondary succeeds
    - Test all providers fail, retry queue processes
    - _Requirements: 25_
  
  - [ ] 18.4 Write integration tests: error scenarios
    - Test invalid recipient handling
    - Test provider rate limiting
    - Test provider authentication failure
    - Test network timeouts
    - _Requirements: 11, 15_
  
  - [ ]* 18.5 Write property tests for end-to-end delivery
    - **Property 6: All Recipients Receive Email or Explicit Failure**
    - **Validates: Requirements 15.1-15.10**
    - Test all recipients get delivered or logged as failed
    - Test no message loss in retry loop

- [ ] 19. Implement delivery status tracking and reporting
  - [ ] 19.1 Track delivery status for each message and recipient
    - Success, TemporaryFailure, PermanentFailure, RateLimited, Suppressed
    - Return detailed delivery results to dispatcher
    - _Requirements: 15.4-15.8_
  
  - [ ] 19.2 Generate and export delivery reports
    - Daily/weekly delivery summaries
    - Success/failure breakdowns by provider
    - Common failure reasons

- [ ] 20. Write performance and reliability tests
  - [ ] 20.1 Write performance benchmarks
    - Formatter latency: target <100ms per event
    - Delivery latency: target <10s per message
    - Throughput: target 500+ emails/second
    - _Non-Functional Requirements: Performance_
  
  - [ ]* 20.2 Write reliability tests (high-volume, concurrent delivery)
    - Test 1000+ concurrent message delivery
    - Test retry logic under high load
    - Test memory usage stability
    - Verify no message loss under stress
  
  - [ ]* 20.3 Write security tests for credential redaction
    - **Property 4: No Credentials in Logs**
    - **Validates: Non-Functional Requirements: Security**
    - Test that API keys, passwords never appear in logs
    - Test that error messages are sanitized
    - Test that credentials are redacted in audit trails

- [ ] 21. Implement comprehensive error handling and logging
  - [ ] 21.1 Implement error handling throughout stack
    - Validation errors with clear messages
    - Configuration errors with remediation suggestions
    - Delivery errors with retry guidance
    - _Requirements: 11_
  
  - [ ] 21.2 Implement structured logging
    - Use JSON format for machine-readable logs
    - Include context: request ID, provider, recipient, timestamp
    - Separate levels: info (normal operations), warn (config issues), error (failures)
    - _Requirements: 18_

- [ ] 22. Implement template system and discovery
  - [ ] 22.1 Create template loader
    - Scan designated template directory
    - Load templates matching naming convention (event_type.txt, event_type.html, event_type.subject)
    - Support hot reload (optional)
    - _Requirements: 22_
  
  - [ ] 22.2 Create default templates for all event categories
    - Define templates for: Group, Admin, Financial, Notification, System categories
    - Create HTML and plain text versions
    - Create subject line templates
    - _Requirements: 8, 22_
  
  - [ ] 22.3 Implement template validation
    - Validate syntax on load
    - Validate required variables are available
    - Fall back to default on error
    - _Requirements: 22.9_

- [ ] 23. Create comprehensive documentation
  - [ ] 23.1 Document configuration file format and options
    - Document all TOML/JSON config fields
    - Provide example configurations (minimal, advanced, multi-provider)
    - Document credential management
    - _Requirements: 21_
  
  - [ ] 23.2 Document template syntax and customization
    - Document template variables available per event type
    - Provide template examples
    - Document template discovery and loading
    - _Requirements: 8, 22_
  
  - [ ] 23.3 Document provider setup and credential storage
    - Setup instructions for each provider (SMTP, SendGrid, AWS SES)
    - Credential management best practices
    - Troubleshooting guide
    - _Requirements: 7, 9_

- [ ] 24. Checkpoint - Ensure all tests pass
  - Run all unit tests (formatter, providers, retry, filtering, bounce handling, mock provider)
  - Run all integration tests (end-to-end, failover, error scenarios)
  - Run all property-based tests (validate all properties pass)
  - Verify unit test coverage >95% for formatter and retry logic, >90% for each provider
  - Ensure performance benchmarks meet targets
  - Ask the user if questions arise.

- [ ] 25. Final verification and polishing
  - [ ] 25.1 Verify all requirements addressed
    - Cross-check implementation against all 25 requirements
    - Verify all acceptance criteria implemented
    - _Requirements: All_
  
  - [ ] 25.2 Verify all non-functional requirements met
    - Performance: formatter <100ms, delivery <10s, 500+ emails/sec throughput
    - Security: no credentials in logs, TLS for all provider connections, secure tokens
    - Reliability: 99%+ delivery success rate, exponential retry, graceful error handling
    - Maintainability: >95% test coverage critical paths, clean code structure
    - _Non-Functional Requirements: All_
  
  - [ ] 25.3 Code cleanup and documentation
    - Remove temporary test code and debug logging
    - Verify all public APIs are documented
    - Add examples for common usage patterns
    - Ensure code follows project conventions and idioms

- [ ] 26. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass (unit, integration, property-based, performance)
  - Ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP delivery (but recommended for production)
- Each task references specific requirements for traceability
- Property tests validate universal correctness properties across all inputs
- Unit tests validate specific examples and edge cases
- Integration tests validate end-to-end flows with real component interactions
- Performance tests validate non-functional requirements
- Checkpoints ensure incremental validation and catch issues early
- Implementation prioritizes: core formatter → SMTP/SendGrid/SES providers → retry logic → failover → advanced features (batching, bounce handling)
- All provider implementations use mocked clients in tests (no external service calls)
- Configuration examples provided in TOML format (adapt to JSON if project standard)
