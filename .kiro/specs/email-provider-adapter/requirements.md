# Email Provider Adapter Requirements Document

## Introduction

This document specifies requirements for an email provider adapter feature in the Rust-based smart contract notification system. The feature enables operators to send contract event notifications via email through multiple pluggable email service providers (SMTP, SendGrid, AWS SES, Postmark, Mailgun, etc.) without coupling provider-specific logic to the event ingestion pipeline. The adapter integrates behind the existing NotificationDispatcher abstraction, maintaining clean separation of concerns. The system must support secure credential storage, provider configuration isolation, unified error handling, consistent message formatting across providers, and full testability without requiring external email service integration.

## Glossary

- **Email Provider Adapter**: The subsystem responsible for delivering formatted email messages through various email service providers
- **Email Service Provider**: A third-party email delivery service (e.g., SendGrid, AWS SES, SMTP server)
- **Provider Implementation**: Provider-specific code that handles authentication, API calls, and response handling for a particular email service
- **Provider Abstraction**: The trait or interface defining the contract that all email providers must implement
- **NotificationDispatcher**: The existing notification dispatch abstraction that coordinates routing to multiple delivery adapters (Slack, email, SMS, webhooks, etc.)
- **Email Formatter**: A component that transforms contract event data into email message content (subject, body, headers)
- **Template Engine**: A system for rendering email body templates with dynamic event data
- **Email Template**: A predefined structure (HTML, plain text) for formatting a specific event type into email body
- **Contract Event**: An occurrence emitted by the smart contract (e.g., NotificationScheduled, Withdrawal, AdminTransferred)
- **Event Metadata**: Structured data within a contract event (category, priority, timestamp, actor, details)
- **Recipient**: An email address or group of email addresses designated to receive notification emails
- **Delivery Status**: The result of attempting to send an email via a provider (success, temporary failure, permanent failure, bounced, throttled)
- **Provider Credentials**: Authentication material required to use a provider (API keys, auth tokens, SMTP credentials, AWS keys)
- **Configuration Isolation**: Keeping provider-specific settings and credentials separate from core system logic
- **Mock Provider**: A test implementation of the provider abstraction that simulates email delivery without external service calls
- **Recipient Preferences**: User-defined settings for email delivery (frequency, categories, opt-out)
- **Bounce Handling**: The process of detecting and managing email addresses that repeatedly fail to receive messages
- **Unsubscribe Management**: Support for unsubscribe links and mechanisms per email provider
- **Email Header Metadata**: SMTP and email headers containing system-generated metadata (Message-ID, X-Event-ID, X-Contract-ID)

## Requirements

### Requirement 1: Email Formatter Component

**User Story:** As a system integrator, I want a dedicated formatter component that transforms contract events into email messages, so that emails are consistently formatted and provider-agnostic.

#### Acceptance Criteria

1. WHEN a contract event is received by the Email_Formatter, THE formatter SHALL parse the event data and extract relevant fields
2. THE Email_Formatter SHALL generate email message components: subject line, plain text body, HTML body (optional)
3. THE formatter SHALL support events from all NotificationCategory types (Group, Admin, Financial, Notification, System)
4. WHEN formatting a subject line, THE Email_Formatter SHALL include: event type, priority indicator (if critical/high), and timestamp or entity identifier
5. WHEN formatting the email body, THE Email_Formatter SHALL include: event type, actor/sender, timestamp, event-specific details, action links (if applicable), footer with opt-out information
6. WHERE an event type is not explicitly supported, THE Email_Formatter SHALL emit a generic formatted message with all available data
7. THE email body SHALL be well-formed HTML (valid UTF-8, proper encoding declaration) and plain text for accessibility
8. WHERE sensitive data appears in events (e.g., token amounts, account details), THE Email_Formatter SHALL apply formatting rules to highlight importance without compromising security

---

### Requirement 2: Provider Abstraction Trait

**User Story:** As a system architect, I want a trait-based provider abstraction that decouples provider implementations from core logic, so that new email providers can be added without modifying the dispatcher.

#### Acceptance Criteria

1. THE system SHALL define an EmailProvider trait (or interface) with standardized methods: send_email, validate_credentials, get_provider_name, get_provider_config
2. THE EmailProvider trait SHALL include a send_email method with signature: send_email(message: EmailMessage, recipient: EmailRecipient) → Result<DeliveryResult, ProviderError>
3. THE EmailMessage type SHALL include: to, cc, bcc (optional), subject, body_plain_text, body_html (optional), headers, reply_to (optional)
4. THE DeliveryResult type SHALL include: status (Success, TemporaryFailure, PermanentFailure), provider_message_id, timestamp, raw_response (for debugging)
5. THE ProviderError type SHALL distinguish error categories: AuthenticationError, RateLimitError, InvalidRecipientError, ProviderUnavailableError, InvalidConfigError, TemplateError
6. ALL provider implementations SHALL implement the EmailProvider trait consistently
7. EACH provider implementation SHALL be in a separate module or file to ensure isolation
8. THE provider abstraction SHALL NOT leak provider-specific details to the caller (dispatcher)

---

### Requirement 3: Built-in Provider Implementations

**User Story:** As an operator, I want multiple email provider implementations available out-of-the-box, so that I can choose the provider that best fits my infrastructure.

#### Acceptance Criteria

1. THE system SHALL provide an implementation for SMTP (Simple Mail Transfer Protocol)
2. THE system SHALL provide an implementation for SendGrid (via REST API)
3. THE system SHALL provide an implementation for AWS SES (Simple Email Service)
4. WHERE configured, additional providers (Postmark, Mailgun, AWS Pinpoint) MAY be added as extensions
5. EACH provider implementation SHALL handle provider-specific authentication, API calls, and response parsing
6. EACH provider implementation SHALL map provider-specific error codes to the standardized ProviderError enum
7. EACH provider implementation SHALL be testable with a mock HTTP client (no actual API calls in tests)
8. THE provider selection mechanism SHALL be configuration-driven (no code changes needed to switch providers)

---

### Requirement 4: SMTP Provider Implementation

**User Story:** As an operator using traditional email infrastructure, I want an SMTP provider that sends emails via a configured SMTP server, so that I can use existing mail infrastructure.

#### Acceptance Criteria

1. THE SMTP provider implementation SHALL support SMTP and SMTPS (TLS) connections
2. THE provider SHALL accept configuration: host, port, username, password, use_tls, from_address
3. WHEN sending an email via SMTP, THE provider SHALL establish a connection, authenticate, compose SMTP commands, and send the message
4. THE provider SHALL handle SMTP response codes correctly: 250 (OK), 421 (service unavailable), 450 (temporary failure), 550 (permanent failure)
5. WHEN the SMTP server is unavailable or times out, THE provider SHALL return ProviderError::ProviderUnavailableError (TemporaryFailure)
6. WHEN SMTP authentication fails (invalid credentials), THE provider SHALL return ProviderError::AuthenticationError (PermanentFailure)
7. WHEN SMTP rejects a recipient address (550 code), THE provider SHALL return ProviderError::InvalidRecipientError (PermanentFailure)
8. THE SMTP provider SHALL use a timeout of 30 seconds for connection and 60 seconds for the full send operation
9. WHERE SMTP connection pooling/reuse is feasible, THE provider MAY implement connection pooling to improve throughput

---

### Requirement 5: SendGrid Provider Implementation

**User Story:** As an operator using cloud email infrastructure, I want a SendGrid provider that sends emails via SendGrid's REST API, so that I benefit from SendGrid's delivery optimization and analytics.

#### Acceptance Criteria

1. THE SendGrid provider implementation SHALL use SendGrid's Mail Send v3 API endpoint (https://api.sendgrid.com/v3/mail/send)
2. THE provider SHALL accept configuration: api_key
3. WHEN sending an email via SendGrid, THE provider SHALL construct a SendGrid-compatible JSON payload and POST to the Mail Send endpoint
4. THE provider SHALL include email metadata in the JSON payload: to, from, subject, content (plain text and HTML)
5. WHEN SendGrid returns 202 Accepted, THE provider SHALL return DeliveryResult::Success with message_id extracted from response
6. WHEN SendGrid returns 400 Bad Request, THE provider SHALL parse error details and return appropriate ProviderError (InvalidRecipientError or TemplateError)
7. WHEN SendGrid returns 401 Unauthorized, THE provider SHALL return ProviderError::AuthenticationError
8. WHEN SendGrid returns 429 Too Many Requests, THE provider SHALL return ProviderError::RateLimitError with retry-after information
9. WHEN SendGrid returns 503 Service Unavailable, THE provider SHALL return ProviderError::ProviderUnavailableError
10. THE SendGrid provider SHALL set the Authorization header with "Bearer {api_key}" (with key redaction in logs)
11. THE provider SHALL handle SendGrid's bounce tracking and unsubscribe list integration (if configured)

---

### Requirement 6: AWS SES Provider Implementation

**User Story:** As an operator using AWS infrastructure, I want an AWS SES provider that sends emails via AWS Simple Email Service, so that I can integrate with my AWS account and use SES analytics.

#### Acceptance Criteria

1. THE AWS SES provider implementation SHALL use the AWS SES SendEmail or SendRawEmail action (via aws-sdk-sesv2 or equivalent)
2. THE provider SHALL accept configuration: aws_region, aws_access_key_id, aws_secret_access_key (or use IAM roles if deployed on AWS)
3. WHEN sending an email via SES, THE provider SHALL construct an SES request and call the service
4. THE provider SHALL handle SES response: MessageId on success, or SESError on failure
5. WHEN SES returns MessageId, THE provider SHALL return DeliveryResult::Success with message_id
6. WHEN SES returns InvalidParameterValue (invalid recipient), THE provider SHALL return ProviderError::InvalidRecipientError
7. WHEN SES returns MessageRejected (recipient not verified or other rejection), THE provider SHALL return ProviderError::PermanentFailure
8. WHEN SES returns ThrottlingException, THE provider SHALL return ProviderError::RateLimitError
9. WHEN SES returns ServiceUnavailable, THE provider SHALL return ProviderError::ProviderUnavailableError
10. THE provider SHALL respect SES rate limits (per-second sending limits)
11. THE provider SHALL handle SES configuration set options (for bounce/complaint tracking if configured)

---

### Requirement 7: Provider Configuration and Isolation

**User Story:** As a system operator, I want provider configurations isolated and separately managed, so that provider-specific settings don't leak into core system logic.

#### Acceptance Criteria

1. THE system configuration file SHALL have a dedicated section for email provider configuration
2. THE configuration SHALL specify: provider_type (smtp, sendgrid, aws_ses, etc.), provider-specific settings (api_key, host, port, etc.)
3. EACH provider's credentials (API keys, passwords, AWS keys) SHALL be stored separately from source code, preferably in environment variables or secure config files
4. WHEN the system loads configuration, THE system SHALL validate provider settings without initializing the provider
5. IF provider configuration is invalid or incomplete, THE system SHALL log an error and disable email delivery (not crash the entire system)
6. EACH provider implementation SHALL only access its own configuration section (no cross-provider configuration access)
7. THE configuration mechanism SHALL support multiple email provider instances (e.g., primary and backup providers)
8. WHERE credentials are needed, THE system SHALL load them from environment variables first, then from config files, then from secrets manager (precedence order configurable)

---

### Requirement 8: Email Template System

**User Story:** As an operator, I want customizable email templates for different event types, so that emails match my organization's branding and style.

#### Acceptance Criteria

1. THE system SHALL support defining email templates for each event type (or event category)
2. THE template syntax SHALL support field substitution using a standard template language (e.g., Handlebars, Liquid, minimal Jinja2-like syntax)
3. TEMPLATES SHALL support conditional blocks (e.g., "if priority == Critical, include alert text")
4. WHEN formatting an event, IF a custom template is defined, THE system SHALL use it; otherwise use a default template
5. THE template system SHALL support specifying: subject line template, plain text body template, HTML body template
6. WHERE a template references a field that doesn't exist in the event, THE system SHALL skip that field or use a default value (not crash)
7. THE template configuration file SHALL be independent of source code (loaded at runtime from designated directory)
8. WHERE templates are invalid (syntax error, undefined variables in render), THE system SHALL log an error and fall back to default formatting
9. EACH template file SHALL be a separate file (e.g., event_type_name.html.template, event_type_name.txt.template)
10. THE system SHALL support internationalization/localization of templates (e.g., templates/en/financial_withdrawal.html.template)

---

### Requirement 9: Credential Management and Secrets Storage

**User Story:** As an operator, I want credentials stored securely outside source control, so that email provider API keys and passwords cannot be leaked through the repository.

#### Acceptance Criteria

1. THE system SHALL NOT store provider credentials (API keys, passwords, tokens) in source code or configuration files checked into version control
2. WHERE credentials are needed, THE system SHALL load them from environment variables, secure config files, or a secrets manager
3. THE credential loading mechanism SHALL support specifying credential source location (e.g., env var name, vault path)
4. WHEN credentials are loaded, THE system SHALL verify they are not empty or malformed before using them
5. WHERE credentials are missing or invalid, THE system SHALL log an error (with redaction) and skip email delivery
6. THE system SHALL NOT log credentials in plain text anywhere (production logs, debug logs, error messages)
7. WHERE credentials appear in error messages, THE system SHALL redact them (replace with "***" or redact API key prefix)
8. WHERE credentials are stored in files, THE system SHALL verify file permissions are restricted (0600 or equivalent)
9. THE system SHALL support credential rotation without service restart (if applicable)
10. WHERE multiple provider instances are configured, EACH SHALL have independently managed credentials

---

### Requirement 10: Message Composition and Headers

**User Story:** As a system operator, I want consistent email message structure with appropriate metadata headers, so that emails are properly handled by mail servers and can be tracked.

#### Acceptance Criteria

1. THE Email_Formatter SHALL compose messages with: To, From, Subject, Content-Type (multipart/alternative for HTML + plain text)
2. THE formatter SHALL include system-generated headers: Message-ID, X-Event-ID, X-Contract-ID, X-Notification-Priority (for filtering/sorting)
3. WHERE a Reply-To address is configured, THE formatter SHALL include Reply-To header
4. WHERE an Unsubscribe URL is available, THE formatter SHALL include List-Unsubscribe header (as per RFC 2369)
5. THE formatter SHALL set proper character encoding (UTF-8) in Content-Type header
6. WHEN the email includes both HTML and plain text versions, THE formatter SHALL use multipart/alternative structure
7. THE formatter SHALL ensure all headers are properly formatted (no line breaks in header values except valid folding)
8. EACH email SHALL have a unique Message-ID to enable tracking and prevent duplicates
9. WHERE email headers contain domain-specific values (From address), THE formatter SHALL use a configured organization domain

---

### Requirement 11: Error Handling and Failure Classification

**User Story:** As a system operator, I want comprehensive error handling that distinguishes between transient and permanent failures, so that I can implement appropriate retry strategies.

#### Acceptance Criteria

1. WHEN email delivery fails, THE system SHALL classify the failure into one of: TemporaryFailure (retry), PermanentFailure (don't retry), RateLimitError (retry with backoff), AuthenticationError (requires config fix)
2. WHEN a provider returns a transient error (network timeout, service unavailable, temporary SMTP rejection), THE system SHALL classify it as TemporaryFailure
3. WHEN a provider returns a permanent error (invalid recipient, authentication failed, malformed message), THE system SHALL classify it as PermanentFailure
4. WHEN a provider is rate limiting requests, THE system SHALL classify it as RateLimitError and respect the rate-limit window
5. WHEN a provider returns an unexpected error, THE system SHALL log it with full context and classify conservatively (as TemporaryFailure to enable retry)
6. THE system SHALL NOT block the main event pipeline on email delivery failures
7. WHEN a delivery fails, THE system SHALL log the failure with: timestamp, recipient, event ID, event type, failure reason, provider name, error code
8. WHERE errors contain sensitive data (stack traces with credentials), THE system SHALL redact before logging
9. THE system SHALL emit structured error logs (JSON format) for easy parsing by monitoring systems
10. WHERE a series of failures occurs for the same recipient/provider combination, THE system MAY implement backoff or temporary suppression

---

### Requirement 12: Retry Strategy for Failed Deliveries

**User Story:** As an operator, I want failed email deliveries to be retried with backoff, so that temporary network issues don't result in lost notifications.

#### Acceptance Criteria

1. WHEN a delivery attempt fails with a TemporaryFailure, THE system SHALL queue the message for retry
2. THE retry strategy SHALL use exponential backoff: first retry after 2 seconds, second after 4 seconds, third after 8 seconds, etc. (base multiplier 2)
3. THE system SHALL attempt a maximum of 5 retries before giving up
4. WHERE a retry is successful, THE system SHALL log the final success status and clear the retry queue for that message
5. WHEN maximum retries are exceeded, THE system SHALL log a final failure and optionally emit an alert or send to dead-letter queue
6. THE system configuration file SHALL support specifying: max_retries, initial_backoff_ms, max_backoff_ms, backoff_multiplier
7. WHERE PermanentFailure or AuthenticationError occurs, THE system SHALL NOT retry and shall log immediately as unrecoverable
8. WHERE RateLimitError occurs, THE system SHALL extract the retry-after duration (if provided) and respect it
9. THE system SHALL support persistent retry queues (durable storage) so failed messages survive system restarts (if applicable)
10. WHERE a message exceeds max_backoff_ms (e.g., max 5 minutes), subsequent retries SHALL use max_backoff_ms, not exponential increase

---

### Requirement 13: Testability Without External Email Service

**User Story:** As a developer, I want to test the email adapter without external email service calls, so that tests are fast, isolated, and don't require API credentials.

#### Acceptance Criteria

1. THE system SHALL provide a MockEmailProvider that implements the EmailProvider trait
2. THE MockEmailProvider SHALL accept formatted messages and validate them as proper email structure
3. THE MockEmailProvider SHALL track delivered messages in memory for verification in tests
4. WHEN configured with the MockEmailProvider, THE system SHALL NOT make real API calls or SMTP connections
5. THE MockEmailProvider SHALL support simulating various provider responses: success, transient failures, rate limiting, authentication errors, invalid recipients
6. WHERE tests need to verify retry logic, THE MockEmailProvider SHALL support injecting transient failures on first N attempts, then succeeding
7. THE MockEmailProvider SHALL track: total messages received, recipients, subjects, delivery results
8. THE test configuration mechanism SHALL allow switching between real provider and MockEmailProvider without code changes
9. THE system SHALL provide test fixtures: sample contract events, sample templates, mock provider instances
10. UNIT tests for each provider implementation SHALL use mocked HTTP/SMTP clients (no external service calls)

---

### Requirement 14: Recipient Validation and Management

**User Story:** As an operator, I want recipient email addresses validated before delivery, so that invalid recipients don't result in delivery failures.

#### Acceptance Criteria

1. WHEN an email recipient is specified, THE system SHALL validate the email address format (RFC 5322 compliant syntax check)
2. WHEN a recipient is invalid (malformed email), THE system SHALL reject it before attempting delivery
3. WHERE recipient validation fails, THE system SHALL log the rejection with: recipient, event ID, rejection reason
4. THE system SHALL support recipient lists: single email, multiple emails (To, Cc, Bcc fields)
5. WHERE a recipient list is specified, THE system SHALL validate all recipients before attempting delivery
6. WHEN a provider reports an invalid recipient (permanent failure), THE system SHALL log the recipient as unreachable
7. WHERE a recipient is repeatedly reported as invalid by the provider, THE system MAY maintain an exclusion list (configurable)
8. THE system SHALL support recipient preferences/opt-out: suppress delivery if recipient has opted out
9. EACH recipient email SHALL be associated with a recipient ID or subscription ID for preference tracking
10. WHERE recipient preferences are stored, THE system SHALL query them before attempting delivery

---

### Requirement 15: Integration with NotificationDispatcher Abstraction

**User Story:** As a system architect, I want the email adapter to integrate seamlessly with the existing NotificationDispatcher, so that it works alongside other notification channels (Slack, SMS, webhooks).

#### Acceptance Criteria

1. THE EmailAdapter SHALL implement the NotificationDispatcher trait (or be compatible with the existing dispatcher interface)
2. WHEN a contract event is processed by the dispatcher, IF email delivery is enabled, THE dispatcher SHALL invoke the EmailAdapter
3. THE dispatcher SHALL treat email delivery as non-blocking: failures don't halt event processing or affect other adapters
4. WHEN an event flows through the dispatcher, THE system SHALL mark it with delivery status for email (pending, delivered, failed, permanent_failure)
5. WHERE multiple notification channels are active (Slack + Email), THE event SHALL be routed to all active adapters independently
6. THE dispatcher SHALL NOT duplicate events for email delivery (each event routed once)
7. WHERE an event is tagged as non-deliverable via email (excluded by filter), THE dispatcher SHALL skip it without error
8. THE EmailAdapter SHALL report delivery status back to the dispatcher for logging and tracking
9. THE adapter interface SHALL be provider-agnostic (dispatcher doesn't know which provider is configured)
10. WHERE the dispatcher needs to send batch emails, THE adapter SHALL support accepting multiple events/recipients in a single call (if applicable)

---

### Requirement 16: Event Filtering and Recipient Selection

**User Story:** As an operator, I want to filter which events are sent via email and to which recipients, so that email subscribers only receive relevant notifications.

#### Acceptance Criteria

1. THE system configuration SHALL support specifying event filters: event categories to include/exclude, priorities to include/exclude
2. WHEN an event is received, THE system SHALL evaluate it against the configured filters
3. IF the event matches the include filters (or no filters are specified), THE system SHALL proceed with formatting and delivery
4. IF the event matches exclude filters, THE system SHALL skip email delivery silently (no error)
5. THE system SHALL support recipient filters: send to specific recipients, send to recipients with certain preferences, send to recipient groups
6. WHERE an event category has specific recipients defined (e.g., "Admin events → admin-group@company.com"), THE system SHALL route to those recipients
7. WHERE no specific recipient is defined for an event category, THE system SHALL use a default recipient
8. WHERE recipient preferences indicate opt-out, THE system SHALL skip delivery to that recipient
9. THE filters SHALL support wildcards and patterns (e.g., "Admin.*" for all admin events)
10. THE filter configuration SHALL be updateable without restarting the system (if applicable)

---

### Requirement 17: Batch Email Sending

**User Story:** As an operator, I want to optionally batch related contract events into single email messages, so that high-volume event streams don't result in email overload.

#### Acceptance Criteria

1. THE system configuration SHALL support enabling/disabling email batching
2. WHERE batching is enabled, THE system SHALL group events by category within a time window (e.g., 30-second batches)
3. WHEN the batch window expires or a batch reaches max size (e.g., 20 events), THE system SHALL format and send a single aggregated email
4. THE aggregated email SHALL list all events in a compact format (table or bullet list in HTML)
5. WHERE batching is disabled, THE system SHALL send each event as a separate email
6. THE batching configuration SHALL specify: batch_window_ms, max_events_per_batch
7. WHERE high-priority events (Critical) arrive, THE system SHALL flush pending batches immediately and send the critical event separately
8. THE aggregated email subject SHALL include a count of events and highest priority (e.g., "5 Notifications - 1 Critical")
9. WHERE events in a batch have different categories, THE aggregated email SHALL group them by category for clarity
10. THE system SHALL not lose events due to batching failures; all events SHALL be delivered or exhaustively retried

---

### Requirement 18: Audit Logging and Delivery Tracking

**User Story:** As an operator, I want detailed logs of email delivery attempts, so that I can audit notification history and diagnose delivery issues.

#### Acceptance Criteria

1. FOR each email delivery attempt, THE system SHALL log: timestamp, recipient, event ID, event type, subject, delivery status, HTTP response code (if applicable), error details
2. THE audit log SHALL be persisted to durable storage (file system or database)
3. WHEN a delivery is successful, THE system SHALL log the provider message ID (for reference and bounce tracking)
4. WHEN a delivery fails, THE system SHALL log the reason: formatting error, network error, provider API error, authentication error, rate limit, recipient invalid, etc.
5. THE system SHALL support querying delivery logs by: date range, recipient, event ID, event type, status, provider
6. WHERE sensitive data appears in logs (recipient email, event details), THE system MAY implement log filtering or sampling
7. WHERE credentials appear in logs, THE system SHALL redact them (keep first/last few characters for identification only)
8. THE audit log retention policy SHALL be configurable (e.g., retain for 90 days, archive after 1 year)
9. THE system SHALL generate summary reports: total emails sent, success/failure counts, common failure reasons
10. WHERE logs contain JSON structured data, THE system SHALL enable easy parsing by monitoring and analytics tools

---

### Requirement 19: Bounce and Complaint Handling

**User Story:** As an operator, I want to automatically handle bounced and complained-about emails, so that I can maintain a clean recipient list and comply with email best practices.

#### Acceptance Criteria

1. WHERE a provider supports bounce notifications (e.g., SendGrid's bounce webhook), THE system SHALL process bounce events
2. WHEN a hard bounce is detected (recipient invalid, mailbox doesn't exist), THE system SHALL mark the recipient as permanently undeliverable
3. WHEN a soft bounce is detected (mailbox full, service temporarily unavailable), THE system SHALL suppress delivery for a time window (e.g., 24 hours) then retry
4. WHERE a recipient is marked as permanently undeliverable, THE system SHALL skip future delivery attempts to that recipient
5. WHERE provider complaint webhooks are available (user marked email as spam), THE system SHALL record the complaint and suppress future deliveries
6. THE system SHALL maintain a suppression list with bounce and complaint records
7. WHEN a recipient requests unsubscribe (via email link or interface), THE system SHALL add them to the suppression list
8. THE suppression list SHALL be checked before every delivery attempt
9. THE system SHALL support purging/resetting suppression list entries (for opt-back-in scenarios)
10. WHERE bounce/complaint processing is performed, THE system SHALL log these events in the audit trail

---

### Requirement 20: Health Check and Status Reporting

**User Story:** As a system operator, I want to monitor email delivery health, so that I can detect delivery problems proactively.

#### Acceptance Criteria

1. THE Email_Adapter SHALL expose a health check that reports: overall adapter status, configured providers, last successful delivery timestamp, consecutive failure count, current error status
2. WHEN all email deliveries are succeeding, THE health check SHALL return status "healthy"
3. WHEN some deliveries fail but system is operational, THE health check SHALL return status "degraded" with failure details
4. WHEN email adapter is misconfigured (missing credentials, invalid templates), THE health check SHALL return status "unhealthy"
5. THE health check response SHALL include: status, timestamp, last_successful_delivery_time, consecutive_failures, error_message (if applicable), active_provider_name
6. WHERE the adapter hasn't been used recently, THE health check SHALL indicate that (e.g., "no activity in last X hours")
7. THE system SHALL emit metrics: total_events_received, total_emails_sent, total_send_attempts, success_count, failure_count, temporary_failure_count, permanent_failure_count, average_delivery_latency_ms
8. THE system SHALL track per-provider metrics: emails_sent, success_rate, average_response_time
9. THE system SHALL track per-recipient metrics: emails_sent, bounces, complaints, opt-outs
10. WHERE metrics are available, THE system SHALL export them in a standard format (Prometheus, CloudWatch, or project's monitoring system)

---

### Requirement 21: Configuration File Format and Loading

**User Story:** As an operator, I want a clear configuration file format for email delivery, so that I can set up email delivery without reading source code.

#### Acceptance Criteria

1. THE system configuration file SHALL be in TOML or JSON format (consistent with existing project conventions)
2. THE configuration file SHALL include sections for: email provider (type, credentials), templates directory, recipient configuration, filters, retry policy, batching policy
3. EACH configuration field SHALL have a clear name, type, description, default value, and example
4. WHERE configuration is missing required fields, THE system SHALL log an error on startup and disable email delivery
5. THE configuration file location SHALL be specified via environment variable (e.g., EMAIL_CONFIG_FILE)
6. WHERE the configuration file is updated, THE system MAY reload it without restarting (if applicable)
7. THE configuration loading process SHALL validate all fields before considering email delivery ready
8. THE configuration parsing SHALL distinguish between missing optional fields (use defaults) and invalid required fields (error)
9. THE system SHALL support environment variable substitution in config files (e.g., ${SENDGRID_API_KEY})
10. WHERE credentials are specified directly in config (not recommended), THE system SHALL warn and still protect them from logging

---

### Requirement 22: Template Discovery and Loading

**User Story:** As an operator, I want email templates discovered and loaded automatically, so that new event types are supported without config changes.

#### Acceptance Criteria

1. THE system SHALL scan a designated template directory for email template files
2. TEMPLATE files SHALL follow a naming convention: event_type.txt (plain text) and event_type.html (HTML)
3. WHERE a template file exists for an event type, THE system SHALL use it; otherwise use the default template
4. WHEN the system starts, THE system SHALL discover all available templates and log them
5. WHERE template discovery fails (directory doesn't exist, file read error), THE system SHALL log a warning and use default templates
6. THE template directory location SHALL be configurable (e.g., ./templates, /etc/app/templates)
7. WHERE templates are updated after startup, THE system MAY reload them (hot reload) or require restart (depending on design)
8. WHEN a template file is invalid (parsing error), THE system SHALL log the error and fall back to default
9. THE system SHALL validate template syntax on load (catch template errors early)
10. WHERE a template is missing variable references (undefined in template), THE system SHALL NOT crash but handle gracefully

---

### Requirement 23: Message Size and Content Limits

**User Story:** As an operator, I want to ensure emails comply with provider limits and standards, so that emails don't get rejected due to size or format violations.

#### Acceptance Criteria

1. THE system SHALL enforce email size limits per provider (e.g., SMTP typically 25MB, SendGrid 30MB)
2. WHEN formatted email exceeds the size limit, THE system SHALL either truncate content with indicators or split into multiple emails
3. THE system SHALL enforce subject line length limits (typically 255 characters or provider-specific limit)
4. WHEN subject line exceeds the limit, THE system SHALL truncate and append ellipsis
5. THE system SHALL enforce HTML body size limits (sender reputation/provider best practices)
6. WHEN HTML body exceeds recommended size, THE system SHALL log a warning (still attempt delivery)
7. THE system SHALL enforce maximum number of recipients per email (per provider limits)
8. WHEN recipient count exceeds the limit, THE system SHALL split into multiple emails
9. THE system SHALL validate UTF-8 encoding and reject invalid sequences before sending
10. EACH provider implementation SHALL document its specific size/limit constraints

---

### Requirement 24: Unsubscribe and Opt-Out Management

**User Story:** As an operator, I want to support recipient unsubscribe and opt-out mechanisms, so that recipients can manage their notification preferences.

#### Acceptance Criteria

1. EACH email message SHALL include an Unsubscribe mechanism: Link header (RFC 2369) or plain text unsubscribe URL
2. WHERE recipient preferences are supported, THE email SHALL include a preference center link (to update notification preferences)
3. WHEN a recipient clicks the unsubscribe link, THE system SHALL record the opt-out and suppress future emails to that recipient
4. THE unsubscribe mechanism SHALL distinguish between: opt-out from all emails, opt-out from event category, opt-out from specific sender
5. THE system SHALL NOT require email confirmation to process unsubscribe (one-click unsubscribe)
6. WHERE unsubscribe tokens are used, THE system SHALL securely generate and validate them (prevent tampering)
7. THE system configuration SHALL specify unsubscribe link URL template (e.g., https://company.com/unsubscribe?token={{token}})
8. WHEN an unsubscribe request is received, THE system SHALL add recipient to suppression list and log the opt-out
9. THE system SHALL allow recipients to re-opt-in (reverse an opt-out) via a separate mechanism
10. WHERE compliance requires specific unsubscribe handling (e.g., CAN-SPAM), THE system SHALL follow those rules

---

### Requirement 25: Multi-Provider Failover and Redundancy

**User Story:** As an operator, I want the system to automatically failover to a backup email provider if the primary provider fails, so that emails are still delivered during provider outages.

#### Acceptance Criteria

1. THE system configuration SHALL support specifying multiple providers: primary, secondary, tertiary (in priority order)
2. WHEN the primary provider fails for a message, THE system SHALL attempt the secondary provider
3. WHEN the secondary provider also fails, THE system SHALL attempt the tertiary provider
4. THE system SHALL track provider health: if a provider has N consecutive failures, mark it as degraded
5. WHEN a provider is marked as degraded, THE system SHALL skip it and try the next provider
6. WHEN a provider recovers (successful delivery after failures), THE system SHALL gradually restore it to primary
7. THE system SHALL log all failover attempts with: timestamp, message ID, provider attempted, result
8. THE failover logic SHALL preserve the original message and retry with each provider (no data loss)
9. EACH provider's credentials and configuration SHALL be independently specified (no sharing)
10. WHERE all providers fail, THE system SHALL queue for retry with exponential backoff (existing retry logic)

---

## Non-Functional Requirements

### Performance
- Email message formatting SHALL complete in <100ms per event
- Email delivery (API call or SMTP) SHALL complete in <10 seconds per message (including retries)
- The system SHALL handle up to 500 emails/second without dropping messages or losing delivery guarantee
- Formatting and delivery SHALL not add more than 15% latency overhead to the main event processing pipeline
- Template rendering SHALL use efficient template engine (not regex replacements)
- Batch email aggregation SHALL not delay individual emails by more than the configured batch window

### Security
- Email provider credentials SHALL never appear in source code or version control
- All communication with email providers SHALL use TLS 1.2 or higher (SMTPS for SMTP, HTTPS for APIs)
- Provider credentials SHALL be protected from unauthorized modification and access
- Audit logs SHALL redact credentials and sensitive recipient data in human-readable output
- Configuration files containing credentials SHALL have restricted file permissions (0600)
- Email templates SHALL be stored with appropriate permissions (not world-readable if containing sensitive patterns)
- Where DKIM/SPF signing is supported, THE system SHALL include headers for email authentication
- Unsubscribe tokens SHALL be cryptographically secure (not sequential or predictable)

### Reliability
- Failed email deliveries SHALL be retried with exponential backoff (max 5 retries)
- The system SHALL not lose emails due to delivery failures
- Formatting errors SHALL not prevent retry attempts
- Email delivery SHALL eventually succeed or exhaustively fail with clear logging
- Bounce/complaint handling SHALL not cause email loss
- Failover to secondary provider SHALL preserve email content and metadata

### Maintainability
- Email formatter logic SHALL be unit tested with >95% code coverage
- Each provider implementation SHALL be unit tested with mocked API/SMTP clients (>90% coverage)
- All configuration options SHALL be documented with examples in code comments and README
- Test utilities SHALL enable testing without external email service calls
- Code SHALL follow Rust idioms, naming conventions, and project conventions
- Provider implementations SHALL be isolated in separate modules (separation of concerns)
- Template syntax and rendering SHALL be clearly documented

### Compatibility
- The system SHALL support current versions of email provider APIs (as of specification date)
- SMTP implementation SHALL support RFC 5321 (SMTP) and RFC 5322 (email format)
- The system SHALL gracefully handle provider API changes (e.g., new fields, deprecated fields)
- Email templates SHALL use portable template syntax (support migration to alternative engines)
- Configuration files created for older versions SHALL remain compatible or include migration guidance
- Provider credentials stored in old formats SHALL be automatically migrated to new format

## Edge Cases and Constraints

1. **Missing Event Fields**: WHERE a contract event lacks expected fields (due to schema evolution), THE formatter SHALL handle missing fields gracefully without crashing, emitting emails with available data only.

2. **Recipient Validation**: THE system SHALL validate email addresses are RFC 5322 compliant and reject malformed addresses with clear error logging.

3. **Message Size Limits**: Email providers have message size limits; THE formatter SHALL truncate/split messages to respect these limits without losing critical information.

4. **High-Volume Event Storms**: WHERE thousands of contract events occur in rapid succession (e.g., batch notification creation), THE system SHALL implement rate limiting and batching to avoid overwhelming email providers and recipient inboxes.

5. **Provider Service Outages**: WHERE an email provider is unavailable, THE system SHALL queue messages with retry logic and NOT disrupt the contract event pipeline.

6. **Concurrent Email Delivery**: The system SHALL handle concurrent message formatting and delivery without race conditions; delivery order MAY vary but SHALL be logged.

7. **Configuration Reload Race Conditions**: IF configuration is reloaded while emails are being formatted, THE system SHALL use the configuration version that was active when formatting began (no mid-flight config changes).

8. **Credentials in Error Messages**: WHERE errors occur during delivery, error messages SHALL NOT include provider API keys, SMTP passwords, recipient emails, or other secrets; only generic error descriptions.

9. **Template Rendering Failures**: WHERE a template contains undefined variables or syntax errors, THE system SHALL fail gracefully with informative error messages (not crash the pipeline).

10. **Bounced Recipient Handling**: WHERE a recipient repeatedly bounces, THE system SHALL suppress delivery after 3 consecutive hard bounces (configurable) and log the suppression.

11. **Character Encoding**: WHERE event data contains non-UTF-8 characters, THE system SHALL sanitize or reject with a clear error (not corrupt the email).

12. **Thread Safety**: WHERE the system uses shared mutable state (retry queues, provider configs), THE system SHALL use appropriate synchronization primitives to prevent race conditions.

13. **Broken Suppression List**: IF suppression list storage becomes unavailable, THE system SHALL fall back to in-memory suppression and log a warning (not crash).

14. **Invalid Template Directory**: IF the template directory doesn't exist or is unreadable, THE system SHALL log a warning and use built-in default templates.

15. **Mixed Provider Compatibility**: WHERE multiple providers are configured, each SHALL have its own credential set and configuration (no shared state between providers).

---

## Testing and Validation Requirements

### Unit Testing
- Formatter transforms all supported event types into valid email structure (subject, body, headers)
- Formatter correctly applies priority indicators based on NotificationPriority
- Formatter truncates long fields to respect provider limits
- Email message validation rejects malformed addresses, invalid templates
- Retry logic correctly implements exponential backoff with configurable parameters
- Configuration loading validates all fields and rejects invalid configurations
- Bounce/complaint handling correctly marks recipients as suppressed
- Template rendering correctly substitutes variables and handles missing variables
- Provider implementations (mocked) correctly construct API calls/SMTP commands
- Failover logic correctly attempts secondary providers on failure

### Integration Testing
- End-to-end flow: contract event → formatter → mock provider, email validated as proper structure
- Error scenarios: invalid recipient, provider rate limit, provider API failure, network timeout
- Concurrent event delivery doesn't cause race conditions or lost emails
- Message batching correctly aggregates events within time window and respects critical priority
- Event filtering correctly includes/excludes events based on configuration
- Retry queue persists and processes failed messages correctly
- Provider failover correctly switches to secondary on primary failure
- Bounce/complaint webhook processing correctly updates suppression list
- Configuration reload doesn't disrupt in-flight messages

### Test Utilities
- MockEmailProvider provides realistic simulation of email delivery (success, failures, rate limiting)
- Test configuration allows easy switching between mock and real providers
- Test helpers support injecting transient failures to validate retry logic
- Test fixtures provide sample contract events in all supported categories and priorities
- Mock provider tracks delivered messages for verification assertions

### Performance Testing
- Formatter latency <100ms for standard event sizes
- Batch processing achieves target throughput (500 emails/second)
- Retry logic doesn't starve other messages (fair queuing)
- Memory usage doesn't grow unbounded with large message queues

---

## Success Metrics

1. All supported contract event types (Group, Admin, Financial, Notification, System categories) format successfully into valid emails
2. Email delivery succeeds for 99%+ of attempts (with transient error recovery via retries)
3. Formatting and delivery add <50ms average latency to event processing pipeline
4. Configuration is clear, documented, and allows secure credential management without exposing secrets
5. System gracefully handles provider outages, rate limiting, and credential errors without disrupting main pipeline
6. Unit test coverage >95% for formatter and retry logic; >90% for each provider implementation
7. Test utilities enable developers to test email delivery without external email service integration
8. At least 3 email providers available out-of-the-box (SMTP, SendGrid, AWS SES)
9. Provider failover ensures emails are delivered even if primary provider fails
10. Bounce/complaint handling maintains clean recipient list and prevents repeated delivery to invalid addresses

---

## Open Questions for Stakeholder Clarification

1. **Provider Priority**: Which email providers are highest priority? Should implementation prioritize SMTP, SendGrid, and AWS SES, or different providers?

2. **Email Content Detail Level**: Should emails include all event fields, or should we curate a minimal set of important fields per event type? Should complex event data be linked to a web dashboard or embedded?

3. **Custom Templates**: Should operators be able to define custom HTML/plain text templates via configuration, or is a fixed set of templates sufficient?

4. **Message Batching Preference**: Should high-volume event streams be batched (e.g., 30-second batches into digest emails), or is one email per event preferred? What's the expected email frequency?

5. **Recipient Management**: Should recipients be defined statically in config, dynamically queried from a database, or pulled from recipient preferences in the contract? How should recipients be mapped to event types?

6. **Multiple Workspaces/Orgs**: Will the system need to send emails with different sender addresses for different organizations, or single sender?

7. **Bounce Management**: Should hard bounces be tracked persistently (database), or in-memory? What's the desired soft bounce suppression window (6 hours, 24 hours)?

8. **Compliance Requirements**: Are there specific compliance requirements (CAN-SPAM, GDPR, CASL) that should influence unsubscribe handling or data retention?

9. **Credential Rotation Frequency**: What is the expected credential rotation schedule (e.g., monthly, quarterly, on-demand only)?

10. **Monitoring Integration**: Should the system export metrics to Prometheus, CloudWatch, or another monitoring platform for alerting?

11. **Persistent Failure Queue**: Should permanently failed emails be stored in a dead-letter queue for manual inspection and retry, or simply logged?

12. **Message Tracking**: Should the system track when recipients open emails or click links, if the provider supports it? Should this data be logged or sent to external analytics?

