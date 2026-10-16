/**
 * Console Notification Provider
 *
 * Refactored to use the NotificationProvider abstraction.
 * Outputs formatted notifications to browser console for development/debugging.
 */

import type {
  NotificationProvider,
  ProviderConfig,
  ProviderSendResult,
  ProviderStatus,
} from './types';
import type { BlockchainEvent } from '../../types/event';

interface ConsoleProviderConfig extends ProviderConfig {
  enabled: boolean;
  maxRetries?: number;
  timeoutMs?: number;
  styleEnabled?: boolean;
}

/**
 * Format a blockchain event for console output
 */
function formatEvent(event: BlockchainEvent): string {
  const timestamp = new Date(event.receivedAt).toISOString();
  const contractShort = event.contractAddress.slice(0, 8) + '...';

  return `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  📬 Blockchain Event Notification
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Event Name:     ${event.eventName || 'N/A'}
  Event Type:     ${event.type}
  Contract:       ${contractShort}
  Ledger:         ${event.ledger}
  Event ID:       ${event.eventId.slice(0, 16)}...
  Timestamp:      ${timestamp}
  ${event.notificationStatus ? `Status:          ${event.notificationStatus}` : ''}
  ${event.txHash ? `Transaction:    ${event.txHash.slice(0, 16)}...` : ''}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`;
}

/**
 * Console Notification Provider
 *
 * Implements NotificationProvider interface for console output.
 * Used for development, debugging, and local testing.
 */
export class ConsoleProvider implements NotificationProvider {
  private config: ConsoleProviderConfig;

  constructor(config?: Partial<ConsoleProviderConfig>) {
    this.config = {
      enabled: true,
      maxRetries: 0,
      timeoutMs: 5000,
      styleEnabled: true,
      ...config,
    };
  }

  getName(): string {
    return 'ConsoleProvider';
  }

  isAvailable(): boolean {
    return this.config.enabled && typeof console !== 'undefined';
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
        message: 'Console provider is not available',
      };
    }

    try {
      const startTime = performance.now();
      const formattedMessage = formatEvent(event);
      const logLevel = this.getLogLevel(event.type);

      // Output formatted message
      if (this.config.styleEnabled) {
        console[logLevel](
          `%c${formattedMessage}`,
          this.getConsoleStyle(logLevel),
          event
        );
      } else {
        console[logLevel](formattedMessage);
      }

      // Output detailed data
      console.group(`Event Data (${event.eventId.slice(0, 16)}...)`);
      console.table(event);
      if (event.topic && event.topic.length > 0) {
        console.log('Topics:', event.topic);
      }
      console.groupEnd();

      const durationMs = performance.now() - startTime;

      return {
        status: 'success',
        message: `Notification sent to console (${event.eventName || event.type})`,
        metadata: {
          durationMs,
          deliveryId: event.eventId,
        },
      };
    } catch (error) {
      return {
        status: 'failure',
        message: 'Failed to send notification to console',
        error: {
          code: 'CONSOLE_ERROR',
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

  async sendBatch(events: BlockchainEvent[]): Promise<ProviderSendResult[]> {
    return Promise.all(events.map((event) => this.send(event)));
  }

  async healthCheck(): Promise<{ healthy: boolean; reason?: string }> {
    return {
      healthy: this.isAvailable(),
      reason: this.isAvailable()
        ? 'Console provider is available'
        : 'Console provider is disabled',
    };
  }

  private getLogLevel(type: string): 'log' | 'info' | 'warn' | 'error' {
    const lowerType = type.toLowerCase();

    if (
      lowerType.includes('error') ||
      lowerType.includes('failed') ||
      lowerType.includes('revoked')
    ) {
      return 'error';
    }

    if (
      lowerType.includes('warn') ||
      lowerType.includes('expired') ||
      lowerType.includes('degraded')
    ) {
      return 'warn';
    }

    if (
      lowerType.includes('success') ||
      lowerType.includes('created') ||
      lowerType.includes('completed')
    ) {
      return 'info';
    }

    return 'log';
  }

  private getConsoleStyle(logLevel: string): string {
    const styles: Record<string, string> = {
      log: 'color: #0066cc; font-weight: bold; font-size: 12px;',
      info: 'color: #00a86b; font-weight: bold; font-size: 12px;',
      warn: 'color: #ff8c00; font-weight: bold; font-size: 12px;',
      error: 'color: #ff0000; font-weight: bold; font-size: 12px;',
    };

    return styles[logLevel] || styles.log;
  }
}
