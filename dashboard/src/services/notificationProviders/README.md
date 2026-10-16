# Notification Provider System

A flexible, extensible abstraction for implementing notification delivery channels without modifying the core event-processing pipeline.

## Overview

The notification provider system decouples event sources from delivery mechanisms. New notification channels (email, Discord, Slack, webhooks, etc.) can be implemented by implementing the `NotificationProvider` interface.

## Architecture

```
Event Source
    ↓
Event → ProviderManager
            ↓
    ┌───────┴───────┬───────────┬──────────┐
    ↓               ↓           ↓          ↓
ConsoleProvider EmailProvider DiscordProvider WebhookProvider
    ↓               ↓           ↓          ↓
  Result        Result      Result      Result
    └───────┬───────┴───────────┴──────────┘
            ↓
    Aggregated Results
```

## Core Concepts

### NotificationProvider Interface

All providers must implement the `NotificationProvider` interface:

```typescript
interface NotificationProvider {
  // Get provider identifier
  getName(): string;

  // Check if provider is configured
  isAvailable(): boolean;

  // Send single notification
  send(event: BlockchainEvent): Promise<ProviderSendResult>;

  // Send multiple notifications (optional)
  sendBatch?(events: BlockchainEvent[]): Promise<ProviderSendResult[]>;

  // Get configuration
  getConfig(): ProviderConfig;

  // Update configuration
  updateConfig(config: Partial<ProviderConfig>): void;

  // Health check (optional)
  healthCheck?(): Promise<{ healthy: boolean; reason?: string }>;

  // Cleanup (optional)
  dispose?(): Promise<void>;
}
```

### ProviderSendResult

Every send operation returns a result indicating success, failure, or retry:

```typescript
interface ProviderSendResult {
  status: 'success' | 'failure' | 'retry' | 'skipped';
  message: string;
  error?: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
  metadata?: {
    durationMs?: number;
    deliveryId?: string;
    retryAttempts?: number;
    [key: string]: unknown;
  };
}
```

## Usage

### Basic Setup

```typescript
import { ProviderManager } from './notificationProviders/manager';
import { ConsoleProvider } from './notificationProviders/consoleProvider';
import { EmailProvider } from './notificationProviders/emailProvider'; // Your implementation

// Create manager
const manager = new ProviderManager();

// Register providers
manager.register(new ConsoleProvider({ enabled: true }));
manager.register(new EmailProvider({ apiKey: process.env.EMAIL_API_KEY }));

// Send notification through all available providers
const event = { /* BlockchainEvent */ };
const results = await manager.sendAll(event);

// Check results
for (const [providerName, result] of results) {
  if (result.status === 'success') {
    console.log(`✓ ${providerName}: ${result.message}`);
  } else if (result.status === 'failure') {
    console.error(`✗ ${providerName}: ${result.error?.message}`);
  }
}
```

### Sending Through Specific Providers

```typescript
// Send only through console and email providers
const results = await manager.send(event, ['ConsoleProvider', 'EmailProvider']);
```

### Error Handling

```typescript
// Register failure handler
manager.onFailure(async (provider, event, result) => {
  console.error(`${provider.getName()} failed:`, result.error);

  // Log to monitoring system
  await logProviderFailure(provider.getName(), result.error);

  // Retry logic
  if (result.error?.code === 'TIMEOUT') {
    await retryWithBackoff(provider, event);
  }
});

// Register success handler
manager.onSuccess(async (provider, event, result) => {
  console.log(`${provider.getName()} succeeded:`, result.metadata);
});
```

### Health Monitoring

```typescript
// Check health of all providers
const health = await manager.getHealthStatus();

for (const [providerName, status] of health) {
  console.log(`${providerName}: ${status.healthy ? 'healthy' : 'unhealthy'}`);
  if (status.reason) {
    console.log(`  Reason: ${status.reason}`);
  }
}
```

## Implementing a Custom Provider

### Example: Email Provider

```typescript
import type {
  NotificationProvider,
  ProviderConfig,
  ProviderSendResult,
} from './types';
import type { BlockchainEvent } from '../../types/event';

interface EmailProviderConfig extends ProviderConfig {
  enabled: boolean;
  apiKey: string;
  fromAddress: string;
  toAddresses: string[];
}

export class EmailProvider implements NotificationProvider {
  private config: EmailProviderConfig;

  constructor(config: EmailProviderConfig) {
    this.config = config;
  }

  getName(): string {
    return 'EmailProvider';
  }

  isAvailable(): boolean {
    return (
      this.config.enabled &&
      !!this.config.apiKey &&
      this.config.toAddresses.length > 0
    );
  }

  getConfig(): ProviderConfig {
    return { ...this.config };
  }

  updateConfig(config: Partial<ProviderConfig>): void {
    this.config = { ...this.config, ...config };
  }

  async send(event: BlockchainEvent): Promise<ProviderSendResult> {
    if (!this.isAvailable()) {
      return {
        status: 'skipped',
        message: 'Email provider is not available',
      };
    }

    try {
      const startTime = performance.now();

      // Send email through your email service
      const response = await fetch('https://api.emailservice.com/send', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: this.config.fromAddress,
          to: this.config.toAddresses,
          subject: `Blockchain Event: ${event.eventName || event.type}`,
          body: this.formatEmailBody(event),
          html: this.formatEmailHtml(event),
        }),
      });

      if (!response.ok) {
        throw new Error(`Email API returned ${response.status}`);
      }

      const data = await response.json();
      const durationMs = performance.now() - startTime;

      return {
        status: 'success',
        message: `Email sent successfully`,
        metadata: {
          durationMs,
          deliveryId: data.messageId,
        },
      };
    } catch (error) {
      return {
        status: 'failure',
        message: 'Failed to send email',
        error: {
          code: 'EMAIL_SEND_FAILED',
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

  async sendBatch(
    events: BlockchainEvent[]
  ): Promise<ProviderSendResult[]> {
    // Optimize by sending a digest email instead of individual emails
    if (events.length === 0) {
      return [];
    }

    try {
      const startTime = performance.now();

      const response = await fetch('https://api.emailservice.com/send', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: this.config.fromAddress,
          to: this.config.toAddresses,
          subject: `Blockchain Events Digest - ${events.length} events`,
          body: this.formatBatchEmailBody(events),
          html: this.formatBatchEmailHtml(events),
        }),
      });

      if (!response.ok) {
        throw new Error(`Email API returned ${response.status}`);
      }

      const data = await response.json();
      const durationMs = performance.now() - startTime;

      // Return single result that applies to all events
      const result: ProviderSendResult = {
        status: 'success',
        message: `Batch email sent for ${events.length} events`,
        metadata: {
          durationMs,
          deliveryId: data.messageId,
        },
      };

      return events.map(() => result);
    } catch (error) {
      const errorResult: ProviderSendResult = {
        status: 'failure',
        message: 'Failed to send batch email',
        error: {
          code: 'EMAIL_BATCH_FAILED',
          message: error instanceof Error ? error.message : String(error),
        },
      };

      return events.map(() => errorResult);
    }
  }

  async healthCheck(): Promise<{ healthy: boolean; reason?: string }> {
    try {
      const response = await fetch('https://api.emailservice.com/health', {
        headers: {
          'Authorization': `Bearer ${this.config.apiKey}`,
        },
      });

      if (!response.ok) {
        return {
          healthy: false,
          reason: `Email service returned ${response.status}`,
        };
      }

      return {
        healthy: true,
        reason: 'Email service is operational',
      };
    } catch (error) {
      return {
        healthy: false,
        reason: `Unable to reach email service: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  async dispose(): Promise<void> {
    // Cleanup resources if needed
    console.log('Email provider disposed');
  }

  private formatEmailBody(event: BlockchainEvent): string {
    return `
Event: ${event.eventName || event.type}
Contract: ${event.contractAddress}
Ledger: ${event.ledger}
Timestamp: ${new Date(event.receivedAt).toISOString()}
    `.trim();
  }

  private formatEmailHtml(event: BlockchainEvent): string {
    return `
<h2>${event.eventName || event.type}</h2>
<p><strong>Contract:</strong> ${event.contractAddress}</p>
<p><strong>Ledger:</strong> ${event.ledger}</p>
<p><strong>Timestamp:</strong> ${new Date(event.receivedAt).toISOString()}</p>
    `.trim();
  }

  private formatBatchEmailBody(events: BlockchainEvent[]): string {
    return events.map((e) => `- ${e.eventName || e.type}`).join('\n');
  }

  private formatBatchEmailHtml(events: BlockchainEvent[]): string {
    return `
<h2>Blockchain Events (${events.length})</h2>
<ul>
${events.map((e) => `<li>${e.eventName || e.type} (Ledger ${e.ledger})</li>`).join('\n')}
</ul>
    `.trim();
  }
}
```

### Best Practices

1. **Always implement error handling**: Catch exceptions and return `ProviderSendResult` with appropriate status
2. **Include metadata**: Provide `durationMs` and `deliveryId` for tracking
3. **Support configuration**: Allow runtime config updates via `updateConfig()`
4. **Implement health checks**: Help diagnose configuration/connectivity issues
5. **Optimize batch operations**: Implement `sendBatch()` for efficiency when possible
6. **Resource cleanup**: Implement `dispose()` for connection pooling or external resources
7. **Timeout protection**: Always respect `timeoutMs` configuration
8. **Retry logic**: Return `'retry'` status for transient failures

## Configuration

### Provider Configuration

```typescript
interface ProviderConfig {
  enabled: boolean;
  maxRetries?: number;
  timeoutMs?: number;
  [key: string]: unknown; // Custom provider-specific config
}
```

### Example: Configuring Providers

```typescript
// Console provider with custom timeout
manager.getProvider('ConsoleProvider')?.updateConfig({
  timeoutMs: 10000,
});

// Email provider with new credentials
manager.getProvider('EmailProvider')?.updateConfig({
  apiKey: newApiKey,
});
```

## Event Filtering

Providers can filter events based on type, category, or custom logic:

```typescript
export class SelectiveProvider implements NotificationProvider {
  async send(event: BlockchainEvent): Promise<ProviderSendResult> {
    // Only send certain event types
    if (
      !event.type.includes('notification') &&
      !event.type.includes('error')
    ) {
      return {
        status: 'skipped',
        message: 'Event type not relevant for this provider',
      };
    }

    // ... send event
  }
}
```

## Testing Providers

```typescript
import { ConsoleProvider } from './notificationProviders/consoleProvider';
import type { BlockchainEvent } from './types/event';

describe('ConsoleProvider', () => {
  it('should send notification', async () => {
    const provider = new ConsoleProvider({ enabled: true });
    const event: BlockchainEvent = {
      eventId: 'test-1',
      contractAddress: 'C1234567890',
      eventName: 'Test',
      ledger: 100,
      type: 'test',
      topic: [],
      value: 'test',
      receivedAt: Date.now(),
    };

    const result = await provider.send(event);
    expect(result.status).toBe('success');
    expect(result.metadata?.deliveryId).toBe(event.eventId);
  });
});
```

## Migration Guide

If you have existing notification code, migrate to the provider system:

### Before

```typescript
async function sendNotification(event: BlockchainEvent) {
  await sendEmail(event);
  await sendDiscord(event);
  console.log(event);
}
```

### After

```typescript
const manager = new ProviderManager();
manager.register(new EmailProvider(emailConfig));
manager.register(new DiscordProvider(discordConfig));
manager.register(new ConsoleProvider());

// Single unified call
await manager.sendAll(event);
```

## Troubleshooting

### Provider Not Sending

```typescript
// Check if provider is available
const provider = manager.getProvider('EmailProvider');
console.log('Available:', provider?.isAvailable());

// Check health
const health = await manager.getHealthStatus();
console.log(health.get('EmailProvider'));
```

### Handling Timeouts

```typescript
manager.onFailure((provider, event, result) => {
  if (result.error?.code === 'TIMEOUT') {
    console.log(`${provider.getName()} timed out - retrying...`);
    // Implement retry logic
  }
});
```

### Debugging Failures

```typescript
const results = await manager.send(event);
for (const [name, result] of results) {
  if (result.status !== 'success') {
    console.error(`${name} details:`, JSON.stringify(result, null, 2));
  }
}
```
