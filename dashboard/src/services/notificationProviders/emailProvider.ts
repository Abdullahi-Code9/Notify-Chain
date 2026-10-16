/**
 * Email Notification Provider
 *
 * Sends blockchain event notifications via email.
 * Supports digest mode for batch notifications.
 */

import type {
  NotificationProvider,
  ProviderConfig,
  ProviderSendResult,
} from './types';
import type { BlockchainEvent } from '../../types/event';

export interface EmailProviderConfig extends ProviderConfig {
  enabled: boolean;
  apiKey: string;
  apiUrl: string;
  fromAddress: string;
  toAddresses: string[];
  timeout?: number;
  maxRetries?: number;
}

/**
 * Email Notification Provider
 *
 * Sends blockchain events to configured email recipients.
 * Integrates with email service APIs (SendGrid, Mailgun, etc.).
 */
export class EmailProvider implements NotificationProvider {
  private config: EmailProviderConfig;

  constructor(config: EmailProviderConfig) {
    if (!config.apiKey || !config.apiUrl) {
      throw new Error('apiKey and apiUrl are required for EmailProvider');
    }

    if (!config.fromAddress || config.toAddresses.length === 0) {
      throw new Error('fromAddress and toAddresses are required');
    }

    this.config = {
      timeout: 30000,
      maxRetries: 3,
      ...config,
    };
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

      const response = await fetch(this.config.apiUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: this.config.fromAddress,
          to: this.config.toAddresses,
          subject: this.formatSubject(event),
          text: this.formatPlainText(event),
          html: this.formatHtml(event),
        }),
        signal: AbortSignal.timeout(this.config.timeout || 30000),
      });

      const durationMs = performance.now() - startTime;

      if (!response.ok) {
        if (response.status >= 400 && response.status < 500) {
          return {
            status: 'failure',
            message: `Email service rejected the request (${response.status})`,
            error: {
              code: `EMAIL_${response.status}`,
              message: `HTTP ${response.status}`,
            },
            metadata: { durationMs },
          };
        }

        return {
          status: 'retry',
          message: `Email service returned ${response.status}`,
          error: {
            code: 'EMAIL_SERVICE_ERROR',
            message: `HTTP ${response.status}`,
          },
          metadata: { durationMs },
        };
      }

      const data = (await response.json()) as Record<string, unknown>;

      return {
        status: 'success',
        message: 'Email sent successfully',
        metadata: {
          durationMs,
          deliveryId: String(data.id || data.messageId || event.eventId),
        },
      };
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        return {
          status: 'retry',
          message: 'Email request timed out',
          error: {
            code: 'EMAIL_TIMEOUT',
            message: error.message,
          },
        };
      }

      return {
        status: 'failure',
        message: 'Failed to send email',
        error: {
          code: 'EMAIL_FAILED',
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

  async sendBatch(events: BlockchainEvent[]): Promise<ProviderSendResult[]> {
    if (!this.isAvailable()) {
      return events.map(() => ({
        status: 'skipped',
        message: 'Email provider is not available',
      }));
    }

    if (events.length === 0) {
      return [];
    }

    try {
      const startTime = performance.now();

      const response = await fetch(this.config.apiUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: this.config.fromAddress,
          to: this.config.toAddresses,
          subject: `Blockchain Events Digest - ${events.length} notifications`,
          text: this.formatBatchPlainText(events),
          html: this.formatBatchHtml(events),
        }),
        signal: AbortSignal.timeout(this.config.timeout || 30000),
      });

      const durationMs = performance.now() - startTime;

      if (!response.ok) {
        const errorResult: ProviderSendResult = {
          status: 'failure',
          message: `Email batch rejected (${response.status})`,
          error: {
            code: `EMAIL_${response.status}`,
            message: `HTTP ${response.status}`,
          },
          metadata: { durationMs },
        };
        return events.map(() => errorResult);
      }

      const data = (await response.json()) as Record<string, unknown>;
      const successResult: ProviderSendResult = {
        status: 'success',
        message: `Digest email sent for ${events.length} events`,
        metadata: {
          durationMs,
          deliveryId: String(data.id || data.messageId || 'batch'),
        },
      };

      return events.map(() => successResult);
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
    if (!this.isAvailable()) {
      return {
        healthy: false,
        reason: 'Email provider is disabled or unconfigured',
      };
    }

    try {
      const response = await fetch(`${this.config.apiUrl}/health`, {
        headers: {
          'Authorization': `Bearer ${this.config.apiKey}`,
        },
        signal: AbortSignal.timeout(5000),
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
        reason: `Health check failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  private formatSubject(event: BlockchainEvent): string {
    return `Blockchain Event: ${event.eventName || event.type}`;
  }

  private formatPlainText(event: BlockchainEvent): string {
    const timestamp = new Date(event.receivedAt).toISOString();

    return `
Blockchain Event Notification
==============================

Event: ${event.eventName || event.type}
Type: ${event.type}
Contract: ${event.contractAddress}
Ledger: ${event.ledger}
Timestamp: ${timestamp}
${event.notificationStatus ? `Status: ${event.notificationStatus}` : ''}
${event.txHash ? `Transaction: ${event.txHash}` : ''}

Event ID: ${event.eventId}
    `.trim();
  }

  private formatHtml(event: BlockchainEvent): string {
    const timestamp = new Date(event.receivedAt).toISOString();

    return `
<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: Arial, sans-serif; color: #333; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
    .header { background: #f5f5f5; padding: 15px; border-radius: 5px; margin-bottom: 20px; }
    .field { margin: 10px 0; }
    .label { font-weight: bold; color: #555; }
    .value { margin-left: 10px; color: #333; }
    .footer { margin-top: 20px; font-size: 12px; color: #999; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h2>📬 Blockchain Event Notification</h2>
    </div>

    <div class="field">
      <span class="label">Event:</span>
      <span class="value">${event.eventName || event.type}</span>
    </div>

    <div class="field">
      <span class="label">Type:</span>
      <span class="value">${event.type}</span>
    </div>

    <div class="field">
      <span class="label">Contract:</span>
      <span class="value">${event.contractAddress}</span>
    </div>

    <div class="field">
      <span class="label">Ledger:</span>
      <span class="value">${event.ledger}</span>
    </div>

    <div class="field">
      <span class="label">Timestamp:</span>
      <span class="value">${timestamp}</span>
    </div>

    ${event.notificationStatus ? `
    <div class="field">
      <span class="label">Status:</span>
      <span class="value">${event.notificationStatus}</span>
    </div>
    ` : ''}

    ${event.txHash ? `
    <div class="field">
      <span class="label">Transaction:</span>
      <span class="value">${event.txHash}</span>
    </div>
    ` : ''}

    <div class="footer">
      <p>Event ID: ${event.eventId}</p>
    </div>
  </div>
</body>
</html>
    `.trim();
  }

  private formatBatchPlainText(events: BlockchainEvent[]): string {
    const eventList = events
      .map((e) => `- ${e.eventName || e.type} (Ledger ${e.ledger})`)
      .join('\n');

    return `
Blockchain Events Digest
========================

Total Events: ${events.length}

Events:
${eventList}

Generated: ${new Date().toISOString()}
    `.trim();
  }

  private formatBatchHtml(events: BlockchainEvent[]): string {
    const eventRows = events
      .map(
        (e) =>
          `<tr><td>${e.eventName || e.type}</td><td>${e.ledger}</td><td>${new Date(e.receivedAt).toLocaleString()}</td></tr>`
      )
      .join('\n');

    return `
<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: Arial, sans-serif; color: #333; }
    .container { max-width: 700px; margin: 0 auto; padding: 20px; }
    .header { background: #f5f5f5; padding: 15px; border-radius: 5px; margin-bottom: 20px; }
    table { width: 100%; border-collapse: collapse; margin: 20px 0; }
    th { background: #007bff; color: white; padding: 10px; text-align: left; }
    td { padding: 10px; border-bottom: 1px solid #ddd; }
    tr:hover { background: #f9f9f9; }
    .footer { margin-top: 20px; font-size: 12px; color: #999; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h2>📊 Blockchain Events Digest</h2>
      <p>Total Events: ${events.length}</p>
    </div>

    <table>
      <thead>
        <tr>
          <th>Event</th>
          <th>Ledger</th>
          <th>Timestamp</th>
        </tr>
      </thead>
      <tbody>
        ${eventRows}
      </tbody>
    </table>

    <div class="footer">
      <p>Generated: ${new Date().toISOString()}</p>
    </div>
  </div>
</body>
</html>
    `.trim();
  }
}

/**
 * Create an email provider with configuration
 */
export function createEmailProvider(config: EmailProviderConfig): EmailProvider {
  return new EmailProvider(config);
}
