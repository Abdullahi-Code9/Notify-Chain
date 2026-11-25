# Email Provider Adapter - Design Document

## Overview

The Email Provider Adapter system enables delivery of contract event notifications via email through multiple pluggable providers (SMTP, SendGrid, AWS SES). The system decouples email delivery from the notification dispatcher, maintains provider abstraction to support new providers without code changes, and integrates secure credential management, comprehensive retry logic, and full testability without external service dependencies.

### Key Design Principles

1. **Provider Abstraction**: Trait-based design allows new providers without dispatcher changes
2. **Credential Isolation**: All credentials stored outside source control, loaded from environment/secrets
3. **Non-blocking Delivery**: Email failures don't disrupt main event processing pipeline
4. **Secure by Default**: No credentials in logs, constant-time validation where applicable
5. **Testable Without Services**: MockEmailProvider enables full test coverage without API calls
6. **Comprehensive Retry**: Exponential backoff with transient/permanent failure classification
7. **Operator-Friendly**: TOML/JSON config with sensible defaults, clear error messages
8. **Observable Delivery**: Detailed audit logs and health metrics for monitoring

---

## Architecture

### System Components

```
┌─────────────────────────────────────────────────────────────────┐
│                    Email Adapter System                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │         NotificationDispatcher Interface                 │  │
│  │  (receives contract events for email delivery)           │  │
│  └──────────────────┬───────────────────────────────────────┘  │
│                     ▼                                           │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  Event Filter & Router                                   │  │
│  │  - Category/priority filters                             │  │
│  │  - Recipient selection logic                             │  │
│  │  - Suppression list checking                             │  │
│  └──────────────────┬───────────────────────────────────────┘  │
│                     ▼                                           │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  Email Formatter                                         │  │
│  │  - Parse contract event                                  │  │
│  │  - Load and render template                              │  │
│  │  - Generate subject, plain text, HTML body               │  │
│  │  - Validate email structure                              │  │
│  │  - Apply size limits                                     │  │
│  └──────────────────┬───────────────────────────────────────┘  │
│                     ▼                                           │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  Message Batching (optional)                             │  │
│  │  - Group events by category within time window           │  │
│  │  - Aggregate into batch email or send individually       │  │
│  └──────────────────┬───────────────────────────────────────┘  │
│                     ▼                                           │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  Provider Interface (Trait-Based)                        │  │
│  │  - send_email(message, recipient)                        │  │
│  │  - validate_credentials()                                │  │
│  │  - health_check()                                        │  │
│  │  - get_provider_config()                                 │  │
│  └──────────────────┬───────────────────────────────────────┘  │
│                     ├─────────────────────┬──────────────────┐  │
│                     ▼                     ▼                  ▼  │
│  ┌──────────────────┐  ┌─────────────────┐  ┌──────────────┐  │
│  │  SMTP Provider   │  │ SendGrid        │  │  AWS SES     │  │
│  │  Implementation  │  │ Implementation  │  │  Impl        │  │
│  └──────────────────┘  └─────────────────┘  └──────────────┘  │
│  (or MockProvider for testing)                                  │
│                     │                                           │
│                     ▼                                           │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  Retry Queue & Backoff Logic                             │  │
│  │  - Exponential backoff (2s, 4s, 8s, ...)                 │  │
│  │  - Max 5 retries, max 30s backoff                        │  │
│  │  - Classify transient vs permanent failures              │  │
│  │  - Persistent storage (if applicable)                    │  │
│  └──────────────────┬───────────────────────────────────────┘  │
│                     ▼                                           │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  Provider Failover Logic                                 │  │
│  │  - Track primary, secondary, tertiary providers          │  │
│  │  - Attempt failover on provider failure                  │  │
│  │  - Monitor provider health and restore                   │  │
│  └──────────────────┬───────────────────────────────────────┘  │
│                     ▼                                           │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  Credential Manager                                      │  │
│  │  - Load from environment variables                       │  │
│  │  - Load from config files or secrets manager             │  │
│  │  - Validate credentials on initialization                │  │
│  │  - Support credential rotation                           │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  Audit & Metrics                                         │  │
│  │  - Log all delivery attempts with results                │  │
│  │  - Track bounce/complaint events                         │  │
│  │  - Export health metrics                                 │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  Suppression List                                        │  │
│  │  - Track bounced recipients                              │  │
│  │  - Track complained recipients                           │  │
│  │  - Track opt-outs                                        │  │
│  │  - Check before delivery                                 │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Data Flow

```
Contract Event
    │
    ▼
[Event Filter & Router]
    │
    ├─ Excluded by filter? ──→ Drop (skip email)
    │
    ├─ Check suppression list ──→ Recipient suppressed? ──→ Drop
    │
    ▼
[Select Recipients]
    │
    ├─ Static config recipients ──→ Use configured list
    │
    ├─ Dynamic recipient selection ──→ Query database/preferences
    │
    ▼
[Email Formatter]
    │
    ├─ Load template ──→ Template invalid? ──→ Log error, use default
    │
    ├─ Render template with event data
    │
    ├─ Validate subject/body lengths ──→ Truncate if needed
    │
    ├─ Validate email structure ──→ Invalid? ──→ Log error, don't send
    │
    ▼
[Formatted EmailMessage]
    │
    ├─ Batching enabled? ──→ [Batch Queue]
    │   │
    │   └─ Window expired/full/critical? ──→ Aggregate and send
    │
    ├─ Batching disabled? ──→ Send individually
    │
    ▼
[Provider Selection & Delivery]
    │
    ├─ Try primary provider
    │   ├─ Success? ──→ Log success, extract message ID for tracking
    │   │
    │   ├─ Transient error? ──→ Queue for retry (exponential backoff)
    │   │
    │   ├─ Permanent error? ──→ Log failure, don't retry
    │   │
    │   ├─ Rate limited? ──→ Queue for retry with backoff
    │   │
    │   └─ Provider unavailable/degraded? ──→ Try secondary provider
    │
    ├─ Try secondary provider (if primary failed)
    │   └─ [same logic as primary]
    │
    ├─ Try tertiary provider (if secondary failed)
    │   └─ [same logic as secondary]
    │
    ▼
[Retry Logic (if transient failure)]
    │
    ├─ Schedule retry: 2s → 4s → 8s → 16s → 30s (max)
    │
    ├─ Attempt <= 5 retries? ──→ Queue for retry
    │
    └─ Max retries exceeded? ──→ Log permanent failure, emit alert
    
Result Logged to Audit Trail
    ├─ Success: timestamp, provider, message ID
    ├─ Failure: timestamp, provider, reason, retry status
    └─ Bounce/Complaint: Add recipient to suppression list
```

---

## Data Models

### EmailMessage Structure

```rust
pub struct EmailMessage {
    // Identifiers and routing
    pub event_id: String,              // Original contract event ID
    pub event_type: String,            // e.g., "NotificationScheduled"
    pub event_category: NotificationCategory,  // Group, Admin, Financial, etc.
    pub priority: NotificationPriority, // Critical, High, Medium, Low
    pub timestamp: SystemTime,         // When event was emitted
    
    // Recipient information
    pub to: Vec<String>,               // Primary recipients
    pub cc: Option<Vec<String>>,       // Carbon copy recipients
    pub bcc: Option<Vec<String>>,      // Blind carbon copy
    pub reply_to: Option<String>,      // Reply-To header
    
    // Email content
    pub subject: String,               // Subject line (max 255 chars)
    pub body_plain_text: String,       // Plain text version
    pub body_html: Option<String>,     // HTML version (optional)
    
    // Headers for tracking and compliance
    pub headers: Map<String, String>,  // Message-ID, X-Event-ID, X-Priority, etc.
    pub unsubscribe_token: Option<String>, // Token for unsubscribe links
    
    // Metadata for delivery
    pub created_at: SystemTime,        // When message was formatted
    pub size_bytes: usize,             // Total message size
    pub is_batch: bool,                // True if aggregated batch email
}

pub struct EmailRecipient {
    pub email: String,                 // RFC 5322 validated email address
    pub recipient_id: Option<String>,  // For preference tracking
    pub name: Option<String>,          // Display name
}
```

### Provider Error Classification

```rust
pub enum ProviderError {
    // Transient - should retry
    ProviderUnavailableError {
        code: String,
        message: String,
        retry_after: Option<Duration>,
    },
    
    // Transient - should retry with backoff
    RateLimitError {
        code: String,
        message: String,
        retry_after: Duration,  // When to retry
    },
    
    // Permanent - don't retry
    AuthenticationError {
        code: String,
        message: String,
    },
    InvalidRecipientError {
        code: String,
        message: String,
        recipient: String,
    },
    InvalidConfigError {
        code: String,
        message: String,
    },
    TemplateError {
        code: String,
        message: String,
    },
    
    // Unknown - classify conservatively as transient
    UnknownError {
        code: String,
        message: String,
    },
}

impl ProviderError {
    pub fn is_transient(&self) -> bool {
        matches!(
            self,
            Self::ProviderUnavailableError { .. }
                | Self::RateLimitError { .. }
                | Self::UnknownError { .. }
        )
    }
    
    pub fn is_permanent(&self) -> bool {
        !self.is_transient()
    }
}
```

### Delivery Result

```rust
pub struct DeliveryResult {
    pub status: DeliveryStatus,
    pub provider_message_id: Option<String>,  // For tracking bounces
    pub timestamp: SystemTime,
    pub attempts: u32,                        // Number of retry attempts
    pub error: Option<ProviderError>,
    pub raw_response: Option<String>,         // For debugging
}

pub enum DeliveryStatus {
    Success,
    TemporaryFailure,     // Retry candidate
    PermanentFailure,     // Don't retry
    RateLimited,          // Retry with backoff
    Suppressed,           // Recipient on suppression list
    FailedAfterRetries,   // All retries exhausted
}
```

### EmailProvider Trait

```rust
#[async_trait]
pub trait EmailProvider: Send + Sync {
    /// Send a formatted email message to a recipient
    /// Returns DeliveryResult indicating success or specific failure type
    async fn send_email(
        &self,
        message: &EmailMessage,
        recipient: &EmailRecipient,
    ) -> Result<DeliveryResult, ProviderError>;
    
    /// Validate provider credentials without sending a test email
    /// Should return quickly without external calls if possible
    async fn validate_credentials(&self) -> Result<(), ProviderError>;
    
    /// Health check returning provider status
    async fn health_check(&self) -> HealthStatus;
    
    /// Get provider name and configuration details
    fn get_provider_name(&self) -> &'static str;
    fn get_provider_config(&self) -> &ProviderConfig;
}

pub struct HealthStatus {
    pub status: HealthCheckStatus,
    pub last_successful_delivery: Option<SystemTime>,
    pub consecutive_failures: u32,
    pub error_message: Option<String>,
    pub provider_name: String,
}

pub enum HealthCheckStatus {
    Healthy,
    Degraded,
    Unhealthy,
}

pub struct ProviderConfig {
    pub provider_type: ProviderType,
    pub timeout_seconds: u32,
    pub max_retries: u32,
    pub initial_backoff_ms: u64,
    pub max_backoff_ms: u64,
}

pub enum ProviderType {
    Smtp,
    SendGrid,
    AwsSes,
}
```

### SMTP Provider Implementation

```rust
pub struct SmtpProvider {
    config: SmtpConfig,
    credentials: SmtpCredentials,
    client_factory: SmtpClientFactory,
}

pub struct SmtpConfig {
    pub host: String,
    pub port: u16,
    pub use_tls: bool,        // true = SMTPS, false = SMTP with STARTTLS
    pub timeout_seconds: u32,
    pub connection_pool_size: Option<usize>,
}

pub struct SmtpCredentials {
    pub username: String,
    pub password: String,     // Should be redacted in logs
    pub from_address: String,
}

#[async_trait]
impl EmailProvider for SmtpProvider {
    async fn send_email(
        &self,
        message: &EmailMessage,
        recipient: &EmailRecipient,
    ) -> Result<DeliveryResult, ProviderError> {
        // 1. Validate recipient email
        validate_email_address(&recipient.email)?;
        
        // 2. Connect to SMTP server (with TLS if configured)
        let mut connection = self.client_factory
            .create_connection(&self.config, &self.credentials)
            .await
            .map_err(|e| ProviderError::ProviderUnavailableError { ... })?;
        
        // 3. Compose SMTP message
        let smtp_message = self.compose_smtp_message(message, recipient)?;
        
        // 4. Send via SMTP (handle response codes)
        match connection.send(smtp_message).await {
            Ok(response_code) if response_code == 250 => {
                Ok(DeliveryResult {
                    status: DeliveryStatus::Success,
                    provider_message_id: generate_message_id(),
                    timestamp: SystemTime::now(),
                    attempts: 1,
                    error: None,
                    raw_response: Some("250 OK".to_string()),
                })
            }
            Ok(421) => Err(ProviderError::ProviderUnavailableError { ... }),
            Ok(450) => Err(ProviderError::ProviderUnavailableError { ... }),
            Ok(550) => Err(ProviderError::InvalidRecipientError { ... }),
            Ok(code) => Err(ProviderError::UnknownError { ... }),
            Err(e) if e.is_timeout() => Err(ProviderError::ProviderUnavailableError { ... }),
            Err(e) => Err(ProviderError::UnknownError { ... }),
        }
    }
    
    async fn validate_credentials(&self) -> Result<(), ProviderError> {
        // Quick validation: attempt connection and SMTP EHLO
        // Don't send a test email (avoid cluttering mailbox)
        // ...
    }
}
```

### SendGrid Provider Implementation

```rust
pub struct SendGridProvider {
    config: SendGridConfig,
    credentials: SendGridCredentials,
    http_client: HttpClient,
}

pub struct SendGridConfig {
    pub api_endpoint: String,  // Default: https://api.sendgrid.com/v3/mail/send
    pub timeout_seconds: u32,
}

pub struct SendGridCredentials {
    pub api_key: String,       // Should be redacted in logs
}

#[async_trait]
impl EmailProvider for SendGridProvider {
    async fn send_email(
        &self,
        message: &EmailMessage,
        recipient: &EmailRecipient,
    ) -> Result<DeliveryResult, ProviderError> {
        // 1. Validate recipient email
        validate_email_address(&recipient.email)?;
        
        // 2. Construct SendGrid JSON payload
        let payload = self.build_sendgrid_payload(message, recipient)?;
        
        // 3. POST to SendGrid Mail Send endpoint
        let response = self.http_client.post(&self.config.api_endpoint)
            .header("Authorization", format!("Bearer {}", self.credentials.api_key))
            .header("Content-Type", "application/json")
            .body(payload)
            .timeout(Duration::from_secs(self.config.timeout_seconds as u64))
            .send()
            .await
            .map_err(|e| ProviderError::ProviderUnavailableError { ... })?;
        
        // 4. Handle SendGrid response codes
        match response.status() {
            202 => {
                let message_id = extract_message_id_from_headers(&response);
                Ok(DeliveryResult {
                    status: DeliveryStatus::Success,
                    provider_message_id: message_id,
                    timestamp: SystemTime::now(),
                    attempts: 1,
                    error: None,
                    raw_response: Some("202 Accepted".to_string()),
                })
            }
            400 => {
                let body = response.text().await.unwrap_or_default();
                // Parse SendGrid error and determine if it's InvalidRecipient or TemplateError
                Err(ProviderError::InvalidRecipientError { ... })
            }
            401 => Err(ProviderError::AuthenticationError { ... }),
            429 => {
                let retry_after = extract_retry_after(&response);
                Err(ProviderError::RateLimitError {
                    code: "RATE_LIMITED".to_string(),
                    message: "SendGrid rate limit exceeded".to_string(),
                    retry_after,
                })
            }
            503 => Err(ProviderError::ProviderUnavailableError { ... }),
            _ => Err(ProviderError::UnknownError { ... }),
        }
    }
}
```

### AWS SES Provider Implementation

```rust
pub struct AwsSesProvider {
    config: AwsSesConfig,
    credentials: AwsSesCredentials,
    aws_client: SesClient,
}

pub struct AwsSesConfig {
    pub region: String,
    pub timeout_seconds: u32,
}

pub struct AwsSesCredentials {
    pub access_key_id: String,
    pub secret_access_key: String,
    // Or: use IAM roles if running on AWS infrastructure
}

#[async_trait]
impl EmailProvider for AwsSesProvider {
    async fn send_email(
        &self,
        message: &EmailMessage,
        recipient: &EmailRecipient,
    ) -> Result<DeliveryResult, ProviderError> {
        // 1. Validate recipient email
        validate_email_address(&recipient.email)?;
        
        // 2. Construct SES SendEmail request
        let ses_request = self.build_ses_request(message, recipient)?;
        
        // 3. Call SES SendEmail
        match self.aws_client.send_email(ses_request).await {
            Ok(response) => {
                Ok(DeliveryResult {
                    status: DeliveryStatus::Success,
                    provider_message_id: Some(response.message_id),
                    timestamp: SystemTime::now(),
                    attempts: 1,
                    error: None,
                    raw_response: None,
                })
            }
            Err(SesError::InvalidParameterValue { .. }) => {
                Err(ProviderError::InvalidRecipientError { ... })
            }
            Err(SesError::MessageRejected { .. }) => {
                Err(ProviderError::PermanentFailure { ... })
            }
            Err(SesError::ThrottlingException { .. }) => {
                Err(ProviderError::RateLimitError { ... })
            }
            Err(SesError::ServiceUnavailable { .. }) => {
                Err(ProviderError::ProviderUnavailableError { ... })
            }
            Err(e) => Err(ProviderError::UnknownError { ... }),
        }
    }
}
```

### Email Formatter Component

```rust
pub struct EmailFormatter {
    config: FormatterConfig,
    template_registry: TemplateRegistry,
}

pub struct FormatterConfig {
    pub templates_directory: String,
    pub default_from_address: String,
    pub default_reply_to: Option<String>,
    pub organization_domain: String,
    pub max_subject_length: usize,       // 255 typical
    pub max_body_length: usize,          // Provider-specific
    pub unsubscribe_link_template: String, // "https://company.com/unsubscribe?token={{token}}"
}

pub struct TemplateRegistry {
    templates: HashMap<String, EmailTemplate>,
}

pub struct EmailTemplate {
    pub event_type: String,
    pub subject_template: String,        // Template string
    pub body_plain_text_template: String,
    pub body_html_template: Option<String>,
}

impl EmailFormatter {
    pub fn format_event(
        &self,
        event: &ContractEvent,
        recipients: &[EmailRecipient],
    ) -> Result<EmailMessage, FormattingError> {
        // 1. Look up template for event type
        let template = self.template_registry
            .get(&event.event_type)
            .unwrap_or_else(|| self.get_default_template());
        
        // 2. Render subject line
        let subject = self.render_template(&template.subject_template, event)?;
        let subject = if subject.len() > self.config.max_subject_length {
            format!("{}...", &subject[..self.config.max_subject_length - 3])
        } else {
            subject
        };
        
        // 3. Render plain text body
        let body_plain_text = self.render_template(
            &template.body_plain_text_template,
            event,
        )?;
        
        // 4. Render HTML body (if available)
        let body_html = if let Some(html_template) = &template.body_html_template {
            Some(self.render_template(html_template, event)?)
        } else {
            None
        };
        
        // 5. Validate total size
        let total_size = subject.len() + body_plain_text.len()
            + body_html.as_ref().map(|h| h.len()).unwrap_or(0);
        if total_size > self.config.max_body_length {
            return Err(FormattingError::MessageTooLarge);
        }
        
        // 6. Generate email headers
        let unsubscribe_token = generate_secure_token();
        let headers = self.generate_headers(
            event,
            &unsubscribe_token,
        );
        
        // 7. Build EmailMessage
        Ok(EmailMessage {
            event_id: event.id.clone(),
            event_type: event.event_type.clone(),
            event_category: event.category.clone(),
            priority: event.priority.clone(),
            timestamp: event.timestamp,
            to: recipients.iter().map(|r| r.email.clone()).collect(),
            cc: None,
            bcc: None,
            reply_to: self.config.default_reply_to.clone(),
            subject,
            body_plain_text,
            body_html,
            headers,
            unsubscribe_token: Some(unsubscribe_token),
            created_at: SystemTime::now(),
            size_bytes: total_size,
            is_batch: false,
        })
    }
    
    fn render_template(
        &self,
        template: &str,
        event: &ContractEvent,
    ) -> Result<String, FormattingError> {
        // Use lightweight template engine (e.g., Handlebars, Liquid)
        // Handle missing variables gracefully (skip or use default)
        // ...
    }
    
    fn generate_headers(
        &self,
        event: &ContractEvent,
        unsubscribe_token: &str,
    ) -> Map<String, String> {
        let mut headers = Map::new();
        
        // Standard email headers
        headers.insert("Message-ID".to_string(), generate_message_id());
        headers.insert("Content-Type".to_string(), "multipart/alternative; charset=UTF-8".to_string());
        
        // Custom tracking headers
        headers.insert("X-Event-ID".to_string(), event.id.clone());
        headers.insert("X-Contract-ID".to_string(), event.contract_id.clone());
        headers.insert("X-Notification-Priority".to_string(), format!("{:?}", event.priority));
        
        // RFC 2369 List-Unsubscribe
        let unsubscribe_url = self.config.unsubscribe_link_template
            .replace("{{token}}", unsubscribe_token);
        headers.insert("List-Unsubscribe".to_string(), format!("<{}>", unsubscribe_url));
        
        headers
    }
}
```

### Retry and Failover Logic

```rust
pub struct RetryManager {
    config: RetryConfig,
    retry_queue: Arc<Mutex<VecDeque<PendingMessage>>>,
}

pub struct RetryConfig {
    pub max_retries: u32,
    pub initial_backoff_ms: u64,
    pub max_backoff_ms: u64,
    pub backoff_multiplier: f64,  // Typically 2.0 for exponential backoff
}

pub struct PendingMessage {
    pub message: EmailMessage,
    pub recipient: EmailRecipient,
    pub attempt_count: u32,
    pub next_retry_time: SystemTime,
    pub error_history: Vec<(SystemTime, String)>,
}

impl RetryManager {
    pub async fn retry_message(
        &self,
        pending: &PendingMessage,
        providers: &[Box<dyn EmailProvider>],
    ) -> Result<DeliveryResult, RetryError> {
        // Calculate backoff delay for this attempt
        let backoff_ms = self.calculate_backoff(pending.attempt_count);
        
        // Wait for backoff
        tokio::time::sleep(Duration::from_millis(backoff_ms)).await;
        
        // Try each provider in failover order
        for (provider_idx, provider) in providers.iter().enumerate() {
            match provider.send_email(&pending.message, &pending.recipient).await {
                Ok(result) if result.status == DeliveryStatus::Success => {
                    return Ok(result);
                }
                Err(err) if err.is_transient() && provider_idx + 1 < providers.len() => {
                    // Try next provider
                    continue;
                }
                Err(err) if err.is_transient() => {
                    // Last provider, schedule next retry
                    return Err(RetryError::TemporaryFailure);
                }
                Err(err) => {
                    // Permanent failure
                    return Err(RetryError::PermanentFailure(err));
                }
                _ => continue,
            }
        }
        
        Err(RetryError::AllProvidersFailed)
    }
    
    fn calculate_backoff(&self, attempt_count: u32) -> u64 {
        let base_backoff = self.config.initial_backoff_ms as f64;
        let exponent = (attempt_count - 1) as f64;
        let backoff = base_backoff * self.config.backoff_multiplier.powf(exponent);
        
        // Cap at max_backoff_ms
        (backoff.min(self.config.max_backoff_ms as f64)) as u64
    }
}

pub struct ProviderFailoverManager {
    providers: Vec<(Box<dyn EmailProvider>, ProviderHealth)>,
}

pub struct ProviderHealth {
    pub consecutive_failures: u32,
    pub last_failure_time: Option<SystemTime>,
    pub is_degraded: bool,
}

impl ProviderFailoverManager {
    pub async fn deliver_with_failover(
        &mut self,
        message: &EmailMessage,
        recipient: &EmailRecipient,
    ) -> DeliveryResult {
        for (provider_idx, (provider, health)) in self.providers.iter_mut().enumerate() {
            // Skip degraded providers (but try if primary failed)
            if health.is_degraded && provider_idx == 0 {
                // Skip only if this is the primary provider
                continue;
            }
            
            match provider.send_email(message, recipient).await {
                Ok(result) if result.status == DeliveryStatus::Success => {
                    // Mark provider as recovered
                    health.consecutive_failures = 0;
                    health.is_degraded = false;
                    return result;
                }
                Ok(result) => {
                    health.consecutive_failures += 1;
                    if health.consecutive_failures >= 3 {
                        health.is_degraded = true;
                    }
                    // If this isn't the last provider, try next
                    continue;
                }
                Err(err) => {
                    health.consecutive_failures += 1;
                    if health.consecutive_failures >= 3 {
                        health.is_degraded = true;
                    }
                    // Try next provider
                    continue;
                }
            }
        }
        
        // All providers failed
        DeliveryResult {
            status: DeliveryStatus::FailedAfterRetries,
            provider_message_id: None,
            timestamp: SystemTime::now(),
            attempts: self.providers.len() as u32,
            error: Some(ProviderError::UnknownError { ... }),
            raw_response: None,
        }
    }
}
```

### Configuration Schema

```toml
[email_integration]
enabled = true
description = "Send contract events via email through multiple providers"

# Email provider configuration (primary)
[email_integration.provider]
provider_type = "sendgrid"  # Options: smtp, sendgrid, aws_ses
# Provider-specific configuration below

[email_integration.provider.sendgrid]
api_key_env = "SENDGRID_API_KEY"  # Load from environment variable
api_endpoint = "https://api.sendgrid.com/v3/mail/send"
timeout_seconds = 10

# Alternative: SMTP provider
# [email_integration.provider.smtp]
# host = "smtp.company.com"
# port = 587
# use_tls = true
# username_env = "SMTP_USERNAME"
# password_env = "SMTP_PASSWORD"
# from_address = "notifications@company.com"
# connection_pool_size = 10

# Alternative: AWS SES provider
# [email_integration.provider.aws_ses]
# region = "us-east-1"
# access_key_id_env = "AWS_ACCESS_KEY_ID"
# secret_access_key_env = "AWS_SECRET_ACCESS_KEY"
# timeout_seconds = 10

# Failover provider (optional)
[email_integration.failover_provider]
enabled = false
provider_type = "smtp"
# [email_integration.failover_provider.smtp]
# host = "backup-smtp.company.com"
# port = 587
# ...

# Email formatter configuration
[email_integration.formatter]
templates_directory = "./templates/emails"
default_from_address = "notifications@company.com"
default_reply_to = "support@company.com"
organization_domain = "company.com"
max_subject_length = 255
max_body_length = 102400  # 100KB typical
unsubscribe_link_template = "https://company.com/unsubscribe?token={{token}}"

# Event filtering
[email_integration.filters]
enabled = true
included_categories = ["Admin", "Financial", "System"]
excluded_categories = []
included_priorities = ["High", "Critical"]
excluded_priorities = ["Low"]

# Recipient routing
[email_integration.recipients]
# Static recipients per category
[email_integration.recipients.routing]
"Admin" = ["admin@company.com", "ops@company.com"]
"Financial" = ["finance@company.com"]
"System" = ["ops@company.com"]
default_recipients = ["notifications@company.com"]

# Retry strategy
[email_integration.retry]
max_retries = 5
initial_backoff_ms = 2000
max_backoff_ms = 30000
backoff_multiplier = 2.0

# Message batching (optional)
[email_integration.batching]
enabled = false
batch_window_ms = 30000
max_events_per_batch = 20
flush_on_critical = true

# Bounce and complaint handling
[email_integration.bounce_handling]
enabled = true
hard_bounce_suppression = true
soft_bounce_window_hours = 24
complaint_tracking = true
suppression_list_storage = "file"  # Options: file, database

# Audit logging
[email_integration.audit]
log_deliveries = true
log_level = "info"
redact_credentials = true
redact_recipients = false  # May be needed for debugging
retention_days = 90

# Health check and metrics
[email_integration.monitoring]
enable_health_check = true
emit_metrics = true
metrics_export_format = "prometheus"  # or "cloudwatch"
```

---

## Template Format and Examples

### Template File Naming

```
templates/emails/
  ├─ notification_scheduled.txt           # Plain text version
  ├─ notification_scheduled.html          # HTML version
  ├─ notification_scheduled.subject       # Subject line template
  ├─ admin_transferred.txt
  ├─ admin_transferred.html
  ├─ admin_transferred.subject
  └─ _default.txt                         # Fallback for unknown events
```

### Template Syntax (Handlebars/Liquid-like)

**Subject Template** (`notification_scheduled.subject`):
```
Notification Scheduled: {{event_type}} - {{timestamp | date: "%Y-%m-%d"}}
```

**Plain Text Template** (`notification_scheduled.txt`):
```
Your notification has been scheduled.

Event Type: {{event_type}}
ID: {{event_id}}
Timestamp: {{timestamp | date: "%Y-%m-%d %H:%M:%S"}}
Category: {{category}}
Priority: {{priority}}

{{#if details}}
Details:
{{details}}
{{/if}}

---
Manage your preferences: https://company.com/preferences?recipient={{recipient_id}}
Unsubscribe: https://company.com/unsubscribe?token={{unsubscribe_token}}
```

**HTML Template** (`notification_scheduled.html`):
```html
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>{{subject}}</title>
</head>
<body style="font-family: Arial, sans-serif; color: #333;">
    <div style="max-width: 600px; margin: 0 auto;">
        <h1>Notification Scheduled</h1>
        
        <table style="width: 100%; border-collapse: collapse;">
            <tr>
                <td style="padding: 8px; border: 1px solid #ddd;"><strong>Event Type</strong></td>
                <td style="padding: 8px; border: 1px solid #ddd;">{{event_type}}</td>
            </tr>
            <tr>
                <td style="padding: 8px; border: 1px solid #ddd;"><strong>ID</strong></td>
                <td style="padding: 8px; border: 1px solid #ddd;">{{event_id}}</td>
            </tr>
            <tr>
                <td style="padding: 8px; border: 1px solid #ddd;"><strong>Timestamp</strong></td>
                <td style="padding: 8px; border: 1px solid #ddd;">{{timestamp | date: "%Y-%m-%d %H:%M:%S"}}</td>
            </tr>
            {{#if details}}
            <tr>
                <td style="padding: 8px; border: 1px solid #ddd;"><strong>Details</strong></td>
                <td style="padding: 8px; border: 1px solid #ddd;">{{details}}</td>
            </tr>
            {{/if}}
        </table>
        
        <p style="margin-top: 20px; font-size: 12px; color: #666;">
            <a href="https://company.com/preferences?recipient={{recipient_id}}">Manage Preferences</a> | 
            <a href="https://company.com/unsubscribe?token={{unsubscribe_token}}">Unsubscribe</a>
        </p>
    </div>
</body>
</html>
```

---

## Credential Management Strategy

### Loading Precedence

```
1. Environment variables (highest priority)
   Example: export SENDGRID_API_KEY="sg-xxx"
   
2. Configuration file with env var substitution
   Example: api_key = "${SENDGRID_API_KEY}"
   
3. Secrets manager (if configured)
   Example: vault://sendgrid/api_key
   
4. Default values (lowest priority, if applicable)
```

### Secrets Storage Best Practices

```bash
# For SMTP credentials in a file (not version controlled):
# .env.local or config/secrets/email.toml
# File permissions: chmod 600

# Example .env.local:
SENDGRID_API_KEY=SG.xxxxxxxxxxxxxxxxxxxxxxxxxxxxx
SMTP_USERNAME=notification_user
SMTP_PASSWORD=xxxxxxxxxxxxxxxxxxxxx
AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE
AWS_SECRET_ACCESS_KEY=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# Load into config:
[email_integration.provider.sendgrid]
api_key_env = "SENDGRID_API_KEY"
```

### Credential Validation

```rust
pub struct CredentialValidator;

impl CredentialValidator {
    pub async fn validate_sendgrid(api_key: &str) -> Result<(), ValidationError> {
        // Check format: should start with "SG."
        if !api_key.starts_with("SG.") {
            return Err(ValidationError::InvalidFormat);
        }
        
        // Check length (SendGrid keys are typically 70+ chars)
        if api_key.len() < 50 {
            return Err(ValidationError::TooShort);
        }
        
        Ok(())
    }
    
    pub async fn validate_smtp(username: &str, password: &str) -> Result<(), ValidationError> {
        // Quick checks (full validation happens on connection)
        if username.is_empty() || password.is_empty() {
            return Err(ValidationError::EmptyCredentials);
        }
        
        Ok(())
    }
    
    pub async fn validate_aws(
        access_key: &str,
        secret_key: &str,
    ) -> Result<(), ValidationError> {
        // Check format: access_key should start with AKIA or ASIA
        if !access_key.starts_with("AKIA") && !access_key.starts_with("ASIA") {
            return Err(ValidationError::InvalidFormat);
        }
        
        if secret_key.is_empty() || secret_key.len() < 20 {
            return Err(ValidationError::TooShort);
        }
        
        Ok(())
    }
}
```

---

## Testing Infrastructure

### MockEmailProvider

```rust
pub struct MockEmailProvider {
    pub delivered_messages: Arc<Mutex<Vec<DeliveredMessage>>>,
    pub next_response: Arc<Mutex<Option<ProviderError>>>,
    pub failure_count: Arc<Mutex<u32>>,
}

pub struct DeliveredMessage {
    pub message: EmailMessage,
    pub recipient: EmailRecipient,
    pub timestamp: SystemTime,
    pub attempt_number: u32,
}

#[async_trait]
impl EmailProvider for MockEmailProvider {
    async fn send_email(
        &self,
        message: &EmailMessage,
        recipient: &EmailRecipient,
    ) -> Result<DeliveryResult, ProviderError> {
        // Check if we should inject a failure
        let mut failures = self.failure_count.lock().unwrap();
        if *failures > 0 {
            *failures -= 1;
            let next_error = self.next_response.lock().unwrap();
            if let Some(err) = next_error.as_ref() {
                return Err(err.clone());
            }
        }
        
        // Record delivery
        let mut messages = self.delivered_messages.lock().unwrap();
        messages.push(DeliveredMessage {
            message: message.clone(),
            recipient: recipient.clone(),
            timestamp: SystemTime::now(),
            attempt_number: 1,
        });
        
        Ok(DeliveryResult {
            status: DeliveryStatus::Success,
            provider_message_id: Some(format!("mock-{}", Uuid::new_v4())),
            timestamp: SystemTime::now(),
            attempts: 1,
            error: None,
            raw_response: Some("Mock success".to_string()),
        })
    }
    
    async fn validate_credentials(&self) -> Result<(), ProviderError> {
        Ok(())
    }
    
    async fn health_check(&self) -> HealthStatus {
        HealthStatus {
            status: HealthCheckStatus::Healthy,
            last_successful_delivery: Some(SystemTime::now()),
            consecutive_failures: 0,
            error_message: None,
            provider_name: "MockEmailProvider".to_string(),
        }
    }
}

impl MockEmailProvider {
    pub fn new() -> Self {
        Self {
            delivered_messages: Arc::new(Mutex::new(Vec::new())),
            next_response: Arc::new(Mutex::new(None)),
            failure_count: Arc::new(Mutex::new(0)),
        }
    }
    
    pub fn inject_failure(&self, error: ProviderError, count: u32) {
        *self.next_response.lock().unwrap() = Some(error);
        *self.failure_count.lock().unwrap() = count;
    }
    
    pub fn get_delivered_messages(&self) -> Vec<DeliveredMessage> {
        self.delivered_messages.lock().unwrap().clone()
    }
    
    pub fn assert_delivered_to(&self, recipient: &str) -> bool {
        self.delivered_messages
            .lock()
            .unwrap()
            .iter()
            .any(|m| m.recipient.email == recipient)
    }
}
```

### Test Scenarios

```rust
#[tokio::test]
async fn test_format_event_generates_valid_email() {
    let formatter = create_test_formatter();
    let event = create_test_event("NotificationScheduled");
    let recipients = vec![create_test_recipient("test@example.com")];
    
    let message = formatter.format_event(&event, &recipients).unwrap();
    
    assert_eq!(message.event_id, event.id);
    assert_eq!(message.to, vec!["test@example.com"]);
    assert!(!message.subject.is_empty());
    assert!(!message.body_plain_text.is_empty());
    assert!(message.headers.contains_key("Message-ID"));
    assert!(message.headers.contains_key("X-Event-ID"));
}

#[tokio::test]
async fn test_smtp_provider_sends_successfully() {
    let mock_client = MockSmtpClient::new();
    let provider = SmtpProvider::with_client(create_smtp_config(), mock_client);
    
    let message = create_test_message();
    let recipient = create_test_recipient("test@example.com");
    
    let result = provider.send_email(&message, &recipient).await.unwrap();
    
    assert_eq!(result.status, DeliveryStatus::Success);
    assert!(result.provider_message_id.is_some());
}

#[tokio::test]
async fn test_retry_logic_exponential_backoff() {
    let config = RetryConfig {
        max_retries: 5,
        initial_backoff_ms: 100,
        max_backoff_ms: 3200,
        backoff_multiplier: 2.0,
    };
    let manager = RetryManager::new(config);
    
    // Verify backoff calculation
    assert_eq!(manager.calculate_backoff(1), 100);   // 100ms
    assert_eq!(manager.calculate_backoff(2), 200);   // 100 * 2
    assert_eq!(manager.calculate_backoff(3), 400);   // 100 * 4
    assert_eq!(manager.calculate_backoff(4), 800);   // 100 * 8
    assert_eq!(manager.calculate_backoff(5), 1600);  // 100 * 16
    assert_eq!(manager.calculate_backoff(6), 3200);  // capped at max
}

#[tokio::test]
async fn test_failover_to_secondary_provider() {
    let mock_provider1 = MockEmailProvider::new();
    mock_provider1.inject_failure(
        ProviderError::ProviderUnavailableError { ... },
        1,
    );
    
    let mock_provider2 = MockEmailProvider::new();
    
    let mut manager = ProviderFailoverManager::new(vec![
        Box::new(mock_provider1),
        Box::new(mock_provider2.clone()),
    ]);
    
    let message = create_test_message();
    let recipient = create_test_recipient("test@example.com");
    
    let result = manager.deliver_with_failover(&message, &recipient).await;
    
    // Should succeed on secondary provider
    assert_eq!(result.status, DeliveryStatus::Success);
    assert!(mock_provider2.assert_delivered_to("test@example.com"));
}

#[tokio::test]
async fn test_bounce_handling_suppresses_recipient() {
    let suppression_list = SuppressionList::new();
    
    // Record hard bounce for recipient
    suppression_list.add_hard_bounce("invalid@example.com").await;
    
    // Verify recipient is suppressed
    assert!(suppression_list.is_suppressed("invalid@example.com").await);
    
    // Soft bounce should suppress temporarily
    suppression_list.add_soft_bounce("busy@example.com", Duration::from_secs(3600)).await;
    assert!(suppression_list.is_suppressed("busy@example.com").await);
    
    // After expiry, should not be suppressed
    tokio::time::sleep(Duration::from_secs(3600)).await;
    assert!(!suppression_list.is_suppressed("busy@example.com").await);
}
```

---

## Correctness Properties

### Property 1: Formatted Emails Are Valid

**For all** contract events and recipients, the formatted EmailMessage SHALL have:
- Non-empty subject line (max 255 characters)
- Non-empty body_plain_text
- Valid email addresses in `to` field (RFC 5322 compliant)
- Proper headers (Message-ID, X-Event-ID, Content-Type)

**Implementation**: EmailFormatter validates all fields before returning; unit tests verify structure for all event categories.

### Property 2: Error Classification Is Correct

**For all** provider errors, the system SHALL correctly classify as transient (retry candidate) or permanent (don't retry):
- Network timeouts → Transient
- HTTP 5xx → Transient
- HTTP 4xx (except 429) → Permanent
- Provider API auth failures → Permanent
- Rate limits (HTTP 429) → Transient with retry-after

**Implementation**: ProviderError enum with `is_transient()` method; tests verify classification for all error codes.

### Property 3: Exponential Backoff Respects Limits

**For all** retry attempts, the backoff delay SHALL follow: `initial * multiplier^(attempt-1)` capped at `max_backoff_ms`.

**Implementation**: RetryManager::calculate_backoff verifies formula; unit tests validate delays for all attempt counts.

### Property 4: No Credentials in Logs

**For all** audit logs, error messages, and debug output, credentials (API keys, passwords, auth tokens) SHALL be redacted (replaced with "***").

**Implementation**: Credential filtering in logging module; audit trail redaction; tests verify redaction in real logs.

### Property 5: Delivery Results Are Deterministic

**For all** identical (message, recipient, provider) tuples with same provider state, sending SHALL have consistent outcome (success, specific error type).

**Implementation**: No random failures in provider implementations; MockEmailProvider enables deterministic testing.

### Property 6: All Recipients Receive Email or Explicit Failure

**For all** recipients in an EmailMessage, the system SHALL either:
- Deliver successfully, OR
- Exhaust all retries and log permanent failure, OR
- Suppress due to suppression list and log suppression

**Implementation**: RetryManager ensures all messages get final outcome; audit logs track all deliveries.

### Property 7: Failover Preserves Message Content

**For all** failover attempts (primary provider fails, secondary attempted), the EmailMessage content SHALL remain identical (same subject, body, headers).

**Implementation**: No modification to message during failover; tests verify content preservation across provider attempts.

### Property 8: Recipient Validation Prevents Invalid Sends

**For all** EmailRecipient objects, invalid email addresses (non-RFC 5322 compliant) SHALL be rejected with clear error before any provider attempt.

**Implementation**: validate_email_address function called before send_email; tests verify rejection for malformed addresses.

### Property 9: Templates Degrade Gracefully

**For all** template rendering operations, missing variables or template errors SHALL result in:
- Fallback to default template, OR
- Omit missing fields and use available data, OR
- Return formatted error message to recipient

**Implementation**: Template engine with error handling; unit tests verify graceful degradation for malformed templates.

### Property 10: Provider Health Tracking Is Accurate

**For all** providers, the health status SHALL accurately reflect:
- Consecutive failures count
- Degraded flag set after 3+ consecutive failures
- Recovery after successful delivery

**Implementation**: ProviderHealth structure incremented on each attempt; tests verify state transitions.

### Property 11: Rate Limiting Respects Provider Limits

**For all** SendGrid/SES deliveries when rate-limited (HTTP 429), the system SHALL respect `Retry-After` header and delay retry accordingly.

**Implementation**: ProviderError::RateLimitError includes retry_after Duration; RetryManager extracts and uses it.

### Property 12: Suppression List Prevents Invalid Deliveries

**For all** recipients on the suppression list (bounce, complaint, opt-out), email delivery SHALL be skipped with DeliveryStatus::Suppressed.

**Implementation**: EventFilter checks suppression list before formatting; tests verify skipped deliveries for suppressed recipients.

---

## Integration Points

### With NotificationDispatcher

```rust
#[async_trait]
pub trait NotificationAdapter: Send + Sync {
    /// Process event and return delivery status
    async fn send_notification(
        &self,
        event: &ContractEvent,
    ) -> Result<NotificationResult, AdapterError>;
    
    /// Health check
    async fn health_check(&self) -> HealthStatus;
}

pub struct EmailAdapter {
    formatter: EmailFormatter,
    providers: Vec<Box<dyn EmailProvider>>,
    retry_manager: RetryManager,
    suppression_list: SuppressionList,
}

#[async_trait]
impl NotificationAdapter for EmailAdapter {
    async fn send_notification(
        &self,
        event: &ContractEvent,
    ) -> Result<NotificationResult, AdapterError> {
        // 1. Check filters
        if !self.should_deliver(event)? {
            return Ok(NotificationResult::Skipped);
        }
        
        // 2. Select recipients
        let recipients = self.select_recipients(event)?;
        
        // 3. Format email
        let message = self.formatter.format_event(event, &recipients)?;
        
        // 4. Deliver with failover
        let mut results = Vec::new();
        for recipient in recipients {
            // Check suppression list
            if self.suppression_list.is_suppressed(&recipient.email).await {
                results.push(DeliveryResult {
                    status: DeliveryStatus::Suppressed,
                    ..Default::default()
                });
                continue;
            }
            
            // Deliver via providers with failover
            let result = self.deliver_with_failover(&message, &recipient).await;
            results.push(result);
        }
        
        Ok(NotificationResult {
            adapter_name: "EmailAdapter",
            delivery_results: results,
            status: determine_overall_status(&results),
        })
    }
}
```

---

## Error Handling Strategy

### Provider Error → Delivery Action Mapping

```
ProviderError::AuthenticationError
  → DeliveryStatus::PermanentFailure
  → Log immediately
  → Don't retry
  → Alert operator (credential issue)

ProviderError::RateLimitError
  → DeliveryStatus::TemporaryFailure
  → Queue for retry
  → Use Retry-After duration if provided
  → Eventually succeed or fail after max retries

ProviderError::ProviderUnavailableError
  → DeliveryStatus::TemporaryFailure
  → Try next provider (if available)
  → Queue for retry with exponential backoff
  → Eventually succeed or fail after max retries

ProviderError::InvalidRecipientError
  → DeliveryStatus::PermanentFailure
  → Don't retry for this recipient
  → Log recipient as permanently invalid
  → Add to bounce suppression list (optional)

ProviderError::InvalidConfigError
  → Log critical error on startup
  → Disable email adapter
  → Don't attempt any deliveries

ProviderError::TemplateError
  → Log warning
  → Fall back to default template
  → Attempt delivery with default
```

---

## Configuration Examples

### Minimal Setup (SendGrid)

```toml
[email_integration]
enabled = true

[email_integration.provider]
provider_type = "sendgrid"

[email_integration.provider.sendgrid]
api_key_env = "SENDGRID_API_KEY"

[email_integration.formatter]
templates_directory = "./templates/emails"
default_from_address = "notify@company.com"

[email_integration.recipients]
[email_integration.recipients.routing]
default_recipients = ["notifications@company.com"]
```

### Advanced Setup (Failover, Batching, Custom Routing)

```toml
[email_integration]
enabled = true

# Primary SendGrid provider
[email_integration.provider]
provider_type = "sendgrid"

[email_integration.provider.sendgrid]
api_key_env = "SENDGRID_API_KEY"
timeout_seconds = 10

# Fallback SMTP provider
[email_integration.failover_provider]
enabled = true
provider_type = "smtp"

[email_integration.failover_provider.smtp]
host = "backup-smtp.company.com"
port = 587
use_tls = true
username_env = "BACKUP_SMTP_USER"
password_env = "BACKUP_SMTP_PASS"
from_address = "notify@company.com"

# Formatter
[email_integration.formatter]
templates_directory = "./templates/emails"
default_from_address = "notify@company.com"
organization_domain = "company.com"
max_body_length = 102400

# Event filtering
[email_integration.filters]
included_categories = ["Admin", "Financial"]
included_priorities = ["High", "Critical"]

# Recipient routing
[email_integration.recipients.routing]
"Admin" = ["admin@company.com"]
"Financial" = ["finance@company.com", "cfo@company.com"]
default_recipients = ["ops@company.com"]

# Batching
[email_integration.batching]
enabled = true
batch_window_ms = 30000
max_events_per_batch = 20
flush_on_critical = true

# Retry and reliability
[email_integration.retry]
max_retries = 5
initial_backoff_ms = 2000

# Monitoring
[email_integration.monitoring]
emit_metrics = true
```

---

## Performance Targets

- Formatting: <100ms per event
- Provider delivery: <10s per message (including connection)
- Throughput: 500+ emails/second
- End-to-end latency: <50ms overhead to event pipeline
- Memory usage: Linear with queue depth (not message count)

---

## Success Criteria

✓ All 5 built-in providers (SMTP, SendGrid, AWS SES, Postmark, Mailgun) successfully send emails
✓ Email formatting creates valid RFC 5322 messages (subject, body, headers)
✓ Retry logic implements exponential backoff with 99%+ eventual delivery
✓ Zero credential leakage in logs or error messages
✓ MockEmailProvider enables full testing without external services
✓ >95% code coverage for formatter and retry logic
✓ >90% code coverage for each provider implementation
✓ Configuration is clear with sensible defaults
✓ Failover works correctly when primary provider fails
✓ Bounce/complaint handling maintains suppression list

