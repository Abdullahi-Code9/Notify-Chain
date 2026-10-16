/**
 * Console Notification Provider
 *
 * Development notification provider that outputs formatted notifications to the console
 * instead of sending them to an external service. Implements the NotificationProvider interface.
 *
 * Acceptance Criteria:
 * - Console provider implements the notification provider interface
 * - Event information is clearly formatted
 * - No external network request is made
 * - Provider can be enabled through configuration
 * - Tests cover the provider
 */

import type { BlockchainEvent } from '../types/event';

export interface NotificationProvider {
  /**
   * Send a notification
   * @param event The blockchain event to notify about
   * @returns Promise that resolves when notification is sent
   */
  send(event: BlockchainEvent): Promise<void>;

  /**
   * Check if the provider is configured and available
   */
  isAvailable(): boolean;

  /**
   * Get the provider name
   */
  getName(): string;
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
 * Outputs notifications to the browser console with formatted styling.
 * Used for development and debugging. No external network requests are made.
 */
export class ConsoleNotificationProvider implements NotificationProvider {
  private enabled: boolean;

  constructor(enabled: boolean = true) {
    this.enabled = enabled;
  }

  /**
   * Send a notification to the console
   */
  async send(event: BlockchainEvent): Promise<void> {
    if (!this.isAvailable()) {
      return;
    }

    const formattedMessage = formatEvent(event);

    // Determine log level based on event type
    const logLevel = this.getLogLevel(event.type);

    // Output to console with styling
    console[logLevel](
      `%c${formattedMessage}`,
      this.getConsoleStyle(logLevel),
      event
    );

    // Also output raw data for inspection
    console.group(`Event Data (${event.eventId.slice(0, 16)}...)`);
    console.table(event);
    if (event.topic && event.topic.length > 0) {
      console.log('Topics:', event.topic);
    }
    console.groupEnd();
  }

  /**
   * Check if the provider is available
   */
  isAvailable(): boolean {
    return this.enabled && typeof console !== 'undefined';
  }

  /**
   * Get the provider name
   */
  getName(): string {
    return 'ConsoleNotificationProvider';
  }

  /**
   * Enable the provider
   */
  enable(): void {
    this.enabled = true;
  }

  /**
   * Disable the provider
   */
  disable(): void {
    this.enabled = false;
  }

  /**
   * Determine log level based on event type and status
   */
  private getLogLevel(
    type: string
  ): 'log' | 'info' | 'warn' | 'error' {
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

  /**
   * Get console styling based on log level
   */
  private getConsoleStyle(
    logLevel: 'log' | 'info' | 'warn' | 'error'
  ): string {
    const styles: Record<string, string> = {
      log: 'color: #0066cc; font-weight: bold; font-size: 12px;',
      info: 'color: #00a86b; font-weight: bold; font-size: 12px;',
      warn: 'color: #ff8c00; font-weight: bold; font-size: 12px;',
      error: 'color: #ff0000; font-weight: bold; font-size: 12px;',
    };

    return styles[logLevel] || styles.log;
  }
}

/**
 * Create a console notification provider with configuration
 */
export function createConsoleProvider(
  config?: { enabled?: boolean }
): ConsoleNotificationProvider {
  return new ConsoleNotificationProvider(config?.enabled ?? true);
}
