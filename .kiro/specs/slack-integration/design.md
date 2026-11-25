# Slack Integration - Design Document

## Overview

The Slack integration system enables real-time delivery of contract event notifications to Slack channels. The system consists of two main components: a **Slack Formatter** that transforms contract events into Slack Block Kit messages, and a **Delivery Adapter** that manages HTTP delivery through webhooks with credential management, retry logic, and rate limiting.

### Key Design Principles

1. **Separation of Concerns**: Formatting logic independent from delivery mechanisms
2. **Secure Credential Management**: Secrets stored outside source control, never logged
3. **Graceful Degradation**: Slack delivery failures don't disrupt contract event processing
4. **Testability**: Complete mock adapter enables testing without real Slack workspace
5. **Reliability**: Exponential backoff retry strategy with configurable limits
6. **Performance**: Sub-100ms formatting, <5s delivery per message, rate limiting to prevent API abuse

---

## Architecture

### System Components

```
┌─────────────────────────────────────────────────────────────────┐
│                    Slack Integration System                     │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │         Contract Event Processing Pipeline                │  │
│  │  (routes events to Slack integration if enabled)         │  │
│  └──────────────────┬───────────────────────────────────────┘  │
│                     ▼                                           │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  Event Filter & Router                                   │  │
│  │  - Filter by category, priority                          │  │
│  │  - Route to appropriate channels                         │  │
│  │  - Handle included/excluded event types                  │  │
│  └──────────────────┬───────────────────────────────────────┘  │
│                     ▼                                           │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  Slack Message Formatter                                 │  │
│  │  - Parse contract event                                  │  │
│  │  - Apply formatting rules per category                   │  │
│  │  - Generate Block Kit JSON                               │  │
│  │  - Apply color/priority indicators                       │  │
│  │  - Validate against Slack schema                         │  │
│  └──────────────────┬───────────────────────────────────────┘  │
│                     ▼                                           │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  Message Batching & Aggregation (optional)               │  │
│  │  - Group events within time window                       │  │
│  │  - Flush on batch full or critical event                 │  │
│  └──────────────────┬───────────────────────────────────────┘  │
│                     ▼                                           │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  Delivery Adapter Interface                              │  │
│  │  ├─ Real Slack Delivery Adapter                          │  │
│  │  │  - HTTPS POST to webhook                              │  │
│  │  │  - Exponential backoff retry                          │  │
│  │  │  - Rate limiting                                      │  │
│  │  └─ Test Mock Adapter                                    │  │
│  │     - In-memory message tracking                         │  │
│  │     - Simulated responses                                │  │
│  └──────────────────┬───────────────────────────────────────┘  │
│                     ▼                                           │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  Credential Manager                                      │  │
│  │  - Load from env vars / secrets manager                  │  │
│  │  - Validate before use                                   │  │
│  │  - Support credential rotation                           │  │
│  └──────────────────┬───────────────────────────────────────┘  │
│                     ▼                                           │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  Audit Logging & Metrics                                 │  │
│  │  - Track delivery attempts                               │  │
│  │  - Redact sensitive data                                 │  │
│  │  - Emit integration health metrics                       │  │
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
    ├─ Excluded by filter? ──→ Drop (skip Slack)
    │
    ▼
[Slack Formatter]
    │
    ├─ Invalid format? ──→ Log error, emit generic message
    │
    ▼
[Formatted Message]
    │
    ├─ Batching enabled? ──→ [Batch Queue] ──→ (on flush)
    │                             │
    │                             └─ Batch timeout/full? ──→ Flush
    │
    ▼
[Delivery Adapter]
    │
    ├─ Send via HTTPS POST
    │
    ├─ HTTP 200? ──→ Log success ──→ Done
    │
    ├─ Transient error (5xx, timeout)? ──→ Queue for retry (exponential backoff)
    │
    └─ Permanent error (4xx auth)? ──→ Log error, skip retries
```

---

## Data Models

### SlackFormatter Component

```rust
pub struct SlackFormatter {
    config: FormatterConfig,
    templates: TemplateRegistry,
}

pub struct FormatterConfig {
    /// Enable message validation
    validate_block_kit: bool,
    /// Maximum characters per text field (Slack limit: 3000)
    max_field_chars: usize,
    /// Maximum blocks per message (Slack limit: 150)
    max_blocks_per_message: usize,
    /// Enable emoji indicators for priority
    use_priority_emoji: bool,
}

pub struct SlackMessage {
    /// Slack Block Kit blocks array
    blocks: Vec<SlackBlock>,
    /// Optional thread timestamp for grouping
    thread_ts: Option<String>,
    /// Destination channel
    channel: String,
}

pub enum SlackBlock {
    Header { text: String },
    Section { 
        text: String, 
        fields: Option<Vec<SlackField>>,
    },
    Divider,
    Context { elements: Vec<String> },
    Actions { elements: Vec<SlackButton> },
}

pub struct SlackField {
    label: String,
    value: String,
    is_short: bool,
}

pub struct SlackButton {
    label: String,
    action_id: String,
    style: Option<ButtonStyle>,
}

pub enum ButtonStyle {
    Primary,
    Danger,
}
```

### DeliveryAdapter Component

```rust
pub trait DeliveryAdapter: Send + Sync {
    /// Send formatted message to Slack
    async fn deliver(&self, message: &SlackMessage) -> DeliveryResult;
    
    /// Health check
    async fn health_check(&self) -> HealthStatus;
}

pub struct DeliveryResult {
    pub status: DeliveryStatus,
    pub slack_ts: Option<String>,  // Message timestamp if successful
    pub error: Option<DeliveryError>,
    pub retry_after: Option<Duration>,
    pub http_code: Option<u16>,
}

pub enum DeliveryStatus {
    Success,
    TransientError,  // Retry candidate
    PermanentError,  // Don't retry
    RateLimited,
}

pub struct DeliveryError {
    pub code: String,  // e.g., "AUTH_FAILED", "INVALID_BLOCK", "RATE_LIMITED"
    pub message: String,
    pub details: Option<String>,
}

pub struct HealthStatus {
    pub status: HealthCheckStatus,
    pub last_successful_delivery: Option<Instant>,
    pub consecutive_failures: u32,
    pub error_message: Option<String>,
}

pub enum HealthCheckStatus {
    Healthy,
    Degraded,
    Unhealthy,
}
```

### CredentialManager Component

```rust
pub struct CredentialManager {
    webhooks: Vec<WebhookCredential>,
    primary_index: usize,
}

pub struct WebhookCredential {
    pub url: String,
    pub workspace_id: String,
    pub enabled: bool,
    pub created_at: SystemTime,
    pub rotated_at: Option<SystemTime>,
}

impl CredentialManager {
    /// Load credentials from environment or config
    pub fn from_config() -> Result<Self>;
    
    /// Get current active webhook URL
    pub fn get_active_webhook(&self) -> Result<&str>;
    
    /// Mark webhook as failed, try next one
    pub fn rotate_on_failure(&mut self) -> Result<&str>;
    
    /// Check if any webhooks remain active
    pub fn has_active_webhooks(&self) -> bool;
}
```

### Configuration Schema

```toml
[slack_integration]
enabled = true

# Credential source
[slack_integration.credentials]
webhook_url_env = "SLACK_WEBHOOK_URL"  # Primary
fallback_urls_env = "SLACK_WEBHOOK_URLS_FALLBACK"  # Comma-separated

# Event filtering
[slack_integration.filters]
included_categories = ["Admin", "Financial", "System"]
excluded_categories = []
included_priorities = ["High", "Critical"]
excluded_priorities = []

# Channel routing
[slack_integration.channel_routing]
default_channel = "#notifications"
routes = [
    { category = "Admin", priority = "Critical", channel = "#security-alerts" },
    { category = "Financial", channel = "#finance-alerts" },
    { category = "System", channel = "#ops-alerts" },
]

# Delivery settings
[slack_integration.delivery]
timeout_seconds = 5
max_retries = 5
initial_backoff_ms = 1000
max_backoff_ms = 30000
rate_limit_per_second = 10

# Message formatting
[slack_integration.formatting]
validate_block_kit = true
max_field_chars = 3000
max_blocks_per_message = 150
use_priority_emoji = true
truncation_indicator = "..."

# Message batching (optional)
[slack_integration.batching]
enabled = false
batch_window_ms = 10000
max_events_per_batch = 10
flush_on_critical = true

# Audit logging
[slack_integration.audit]
log_deliveries = true
redact_urls = true
retention_days = 90
```

---

## Event Formatting Rules

### Color Mapping by Priority

```
Priority::Critical  → #FF3333 (Red)       + 🔴 emoji
Priority::High      → #FFA500 (Orange)    + 🟠 emoji
Priority::Medium    → #FFD700 (Gold)      + 🟡 emoji
Priority::Low       → #00DD00 (Green)     + 🟢 emoji
```

### Format Templates by Category

#### Group Category Events

```
Title: "Group Event: {event_type}"
Color: Category color (Group = #0099FF)

Sections:
- Header: "🔵 Group: {group_name}"
- Fields:
  - "Action": {action_type}
  - "Creator": {creator_id}
  - "Created": {timestamp}
  - "Status": {status}

Context: "Event ID: {event_id} | Category: Group"
```

#### Admin Category Events

```
Title: "🔐 Admin Action: {event_type}"
Color: Priority color (Critical = #FF3333)

Sections:
- Header: "ADMIN ALERT" (if Critical)
- Fields:
  - "Action": {action}
  - "Previous Admin": {old_admin}
  - "New Admin": {new_admin}
  - "Timestamp": {timestamp}
  - "Authorization": {auth_status}

Actions: [View Details] [Acknowledge]
Context: "Event ID: {event_id} | Priority: {priority}"
```

#### Financial Category Events

```
Title: "💰 Financial Transaction: {event_type}"
Color: Priority color

Sections:
- Header: "TRANSACTION"
- Fields:
  - "Amount": {amount} {currency}
  - "Recipient": {recipient}
  - "Status": {status}
  - "Timestamp": {timestamp}
  - "Tx ID": {transaction_id}

Context: "Event ID: {event_id} | Priority: {priority}"
```

#### Notification Category Events

```
Title: "📧 Notification: {event_type}"
Color: Priority color

Sections:
- Header: "{event_type}"
- Fields:
  - "ID": {notification_id}
  - "Scheduled": {scheduled_time}
  - "Recipients": {recipient_count}
  - "Message Preview": {truncated_message}

Context: "Event ID: {event_id}"
```

#### System Category Events

```
Title: "⚙️ System: {event_type}"
Color: Priority color

Sections:
- Header: "{event_type}"
- Fields:
  - "Action": {action}
  - "Old Value": {old_value}
  - "New Value": {new_value}
  - "Timestamp": {timestamp}

Context: "Event ID: {event_id} | Priority: {priority}"
```

---

## Delivery & Retry Strategy

### Exponential Backoff Algorithm

```
Attempt 1: Immediate
Attempt 2: 1000ms
Attempt 3: 2000ms
Attempt 4: 4000ms
Attempt 5: 8000ms
Attempt 6: 16000ms (capped at max_backoff_ms)

Max retries: 5 (configurable)
Total time budget: ~30 seconds

Transient errors triggering retry:
- HTTP 5xx (server error)
- HTTP 429 (rate limit)
- Network timeout
- DNS resolution failure

Permanent errors (no retry):
- HTTP 401 (unauthorized)
- HTTP 403 (forbidden)
- HTTP 400 (invalid request)
- Malformed URL
```

### Rate Limiting

```rust
pub struct RateLimiter {
    max_messages_per_second: f64,
    last_send_time: Instant,
    queued_messages: VecDeque<PendingMessage>,
}

impl RateLimiter {
    pub async fn send(&mut self, message: SlackMessage) -> Result<()> {
        let elapsed_since_last = self.last_send_time.elapsed();
        let min_interval = Duration::from_secs_f64(1.0 / self.max_messages_per_second);
        
        if elapsed_since_last < min_interval {
            let wait_duration = min_interval - elapsed_since_last;
            tokio::time::sleep(wait_duration).await;
        }
        
        // Send message
        self.last_send_time = Instant::now();
    }
}

// Slack's default rate limit: ~10 requests/minute per webhook
// Conservative limit: 1 message/second (60/minute)
```

---

## Credential Management

### Loading Strategy

```rust
pub fn load_credentials() -> Result<Vec<WebhookCredential>> {
    let mut webhooks = Vec::new();
    
    // Load primary webhook from SLACK_WEBHOOK_URL
    if let Ok(url) = env::var("SLACK_WEBHOOK_URL") {
        validate_webhook_url(&url)?;
        webhooks.push(WebhookCredential {
            url,
            workspace_id: "primary".to_string(),
            enabled: true,
            created_at: SystemTime::now(),
            rotated_at: None,
        });
    }
    
    // Load fallback webhooks from SLACK_WEBHOOK_URLS_FALLBACK
    if let Ok(urls) = env::var("SLACK_WEBHOOK_URLS_FALLBACK") {
        for (idx, url) in urls.split(',').enumerate() {
            validate_webhook_url(url)?;
            webhooks.push(WebhookCredential {
                url: url.to_string(),
                workspace_id: format!("fallback_{}", idx),
                enabled: true,
                created_at: SystemTime::now(),
                rotated_at: None,
            });
        }
    }
    
    if webhooks.is_empty() {
        return Err("No Slack webhooks configured".into());
    }
    
    Ok(webhooks)
}

fn validate_webhook_url(url: &str) -> Result<()> {
    if !url.starts_with("https://hooks.slack.com/services/") {
        return Err("Invalid Slack webhook URL format".into());
    }
    Ok(())
}
```

### Rotation on Failure

```rust
impl CredentialManager {
    pub fn rotate_on_failure(&mut self) -> Result<&str> {
        self.webhooks[self.primary_index].enabled = false;
        
        // Find next enabled webhook
        for i in 0..self.webhooks.len() {
            let idx = (self.primary_index + 1 + i) % self.webhooks.len();
            if self.webhooks[idx].enabled {
                self.primary_index = idx;
                return Ok(&self.webhooks[idx].url);
            }
        }
        
        Err("No active webhooks available".into())
    }
}
```

---

## Test Infrastructure

### Mock Slack Adapter

```rust
pub struct TestSlackAdapter {
    delivered_messages: Arc<Mutex<Vec<TestMessage>>>,
    next_response: Arc<Mutex<DeliveryResponse>>,
    failure_count: Arc<Mutex<u32>>,
}

pub struct TestMessage {
    pub channel: String,
    pub blocks: Vec<SlackBlock>,
    pub timestamp: SystemTime,
    pub event_id: String,
}

impl TestSlackAdapter {
    pub fn new() -> Self {
        Self {
            delivered_messages: Arc::new(Mutex::new(Vec::new())),
            next_response: Arc::new(Mutex::new(DeliveryResponse::Success)),
            failure_count: Arc::new(Mutex::new(0)),
        }
    }
    
    pub fn set_response(&self, response: DeliveryResponse) {
        *self.next_response.lock().unwrap() = response;
    }
    
    pub fn inject_failure(&self, count: u32) {
        *self.failure_count.lock().unwrap() = count;
    }
    
    pub fn get_delivered_messages(&self) -> Vec<TestMessage> {
        self.delivered_messages.lock().unwrap().clone()
    }
    
    pub fn assert_message_delivered(
        &self,
        channel: &str,
        event_id: &str,
    ) -> Result<TestMessage> {
        let messages = self.delivered_messages.lock().unwrap();
        messages.iter()
            .find(|m| m.channel == channel && m.event_id == event_id)
            .cloned()
            .ok_or("Message not found".into())
    }
}

#[async_trait]
impl DeliveryAdapter for TestSlackAdapter {
    async fn deliver(&self, message: &SlackMessage) -> DeliveryResult {
        let mut failures = self.failure_count.lock().unwrap();
        
        if *failures > 0 {
            *failures -= 1;
            return DeliveryResult {
                status: DeliveryStatus::TransientError,
                error: Some(DeliveryError {
                    code: "INJECTED_FAILURE".to_string(),
                    message: "Test failure".to_string(),
                    details: None,
                }),
                slack_ts: None,
                retry_after: Some(Duration::from_millis(100)),
                http_code: Some(503),
            };
        }
        
        self.delivered_messages.lock().unwrap().push(TestMessage {
            channel: message.channel.clone(),
            blocks: message.blocks.clone(),
            timestamp: SystemTime::now(),
            event_id: extract_event_id(&message),
        });
        
        DeliveryResult {
            status: DeliveryStatus::Success,
            slack_ts: Some(format!("1234567890.{}", Uuid::new_v4())),
            error: None,
            retry_after: None,
            http_code: Some(200),
        }
    }
    
    async fn health_check(&self) -> HealthStatus {
        HealthStatus {
            status: HealthCheckStatus::Healthy,
            last_successful_delivery: Some(Instant::now()),
            consecutive_failures: 0,
            error_message: None,
        }
    }
}
```

---

## Correctness Properties

### Property 1: Valid Slack Block Kit Format

**For all** formatted messages, the generated JSON SHALL be valid Slack Block Kit format according to Slack's API specification.

**Implementation**: Validate message structure during formatting; fail-safe to generic message on validation error.

### Property 2: Message Delivery Guarantee

**For all** successfully queued messages, the system SHALL either deliver to Slack or exhaustively retry and log failure.

**Implementation**: Exponential backoff with max 5 retries; track all attempts in audit log.

### Property 3: No Credential Leakage

**For all** logs and error messages, webhook URLs and tokens SHALL never appear in plain text.

**Implementation**: Redact credentials in all log output; validate in unit tests.

### Property 4: Event Processing Independence

**For all** contract events, Slack delivery failures SHALL NOT block or delay event processing pipeline.

**Implementation**: Async, non-blocking delivery; failures logged but not propagated.

### Property 5: Consistent Priority Formatting

**For all** events with same priority, Slack messages SHALL use identical color and emoji.

**Implementation**: Deterministic color mapping function; test coverage for all priority levels.

---

## Testing Strategy

### Unit Tests

- Formatter validates all event categories produce valid Block Kit JSON
- Formatter correctly applies colors based on priority
- Formatter truncates long fields to Slack limits
- Formatter handles missing/null fields gracefully
- Credential manager loads from environment variables
- Credential manager validates webhook URL format
- Rate limiter correctly spaces messages
- Retry logic implements exponential backoff

### Integration Tests

- End-to-end: Event → Formatter → TestAdapter → Validated message
- Credential rotation: Primary webhook fails, system uses fallback
- Retry logic: Transient failure, retry succeeds
- Message batching: Events aggregated, flushed on timeout

### Property-Based Tests

- All 5 correctness properties verified for random event data
- 100+ iterations per property
- Edge cases: null fields, max-length fields, special characters

---

## Performance Analysis

### Formatting Latency
- Target: <100ms per message
- Typical: 5-15ms (JSON generation, validation)
- Budget: 100ms (comfortable margin)

### Delivery Latency
- Target: <5 seconds per delivery
- Network: 100-500ms (typical HTTPS roundtrip)
- Retry delay (if needed): 1-30 seconds exponential backoff
- Budget: 5 seconds per attempt (success case)

### Throughput
- Target: 1000+ events/second
- Formatting: 1000+ messages/second (single threaded)
- Delivery: Rate limited to ~10/second by Slack (configurable)
- Async batch processing handles burst load via queue

---

## Integration with Event Pipeline

```
Contract Event Emitted
    ↓
Event Processor
    ├─ Route to Slack Integration (if enabled)
    ├─ Route to other adapters (Email, Webhook, etc.)
    └─ Continue pipeline (non-blocking)
    
Slack Integration
    ├─ Check filters (category, priority)
    ├─ Format message
    ├─ Route to channel(s)
    ├─ Queue for delivery (batching if enabled)
    └─ Send asynchronously
    
Result logged to audit trail
    ├─ Success: timestamp, Slack message ID
    └─ Failure: reason, retry status
```

The Slack delivery is non-blocking; the main event pipeline continues regardless of Slack delivery status.

---

## Configuration Examples

### Minimal Setup

```toml
[slack_integration]
enabled = true

[slack_integration.credentials]
webhook_url_env = "SLACK_WEBHOOK_URL"

[slack_integration.channel_routing]
default_channel = "#notifications"
```

### Advanced Setup

```toml
[slack_integration]
enabled = true

[slack_integration.credentials]
webhook_url_env = "SLACK_WEBHOOK_URL"
fallback_urls_env = "SLACK_WEBHOOK_URLS_FALLBACK"

[slack_integration.filters]
included_categories = ["Admin", "Financial", "System"]
included_priorities = ["High", "Critical"]

[slack_integration.channel_routing]
default_channel = "#notifications"
routes = [
    { category = "Admin", priority = "Critical", channel = "#security" },
    { category = "Financial", channel = "#finance" },
    { category = "System", channel = "#ops" },
]

[slack_integration.delivery]
max_retries = 5
rate_limit_per_second = 5

[slack_integration.batching]
enabled = true
batch_window_ms = 5000
max_events_per_batch = 20
```

---

## Success Criteria

- All supported event categories (Group, Admin, Financial, Notification, System) format correctly
- Formatted messages validate as Slack Block Kit format
- 99%+ delivery success rate (with retries)
- <100ms formatting latency, <5s delivery per message
- Zero credential leakage in logs or error messages
- Test adapter enables complete testing without Slack workspace
- >95% code coverage for formatter and delivery adapter
- Configuration clear, documented, with sensible defaults
