/**
 * Mock Notification Transport
 * 
 * A no-op transport adapter for testing notification pipeline without external dependencies.
 * This transport captures notification payloads for verification without making any real
 * network calls.
 */

import * as StellarSDK from '@stellar/stellar-sdk';
import { ContractConfig, DiscordConfig } from '../types';
import { DiscordMessage, DiscordEmbed } from './discord-notification';
import { getEventName } from '../utils/event-utils';

export interface CapturedNotification {
  eventId: string;
  contractAddress: string;
  eventName: string | null;
  message: DiscordMessage;
  timestamp: number;
  requestId?: string;
}

/**
 * MockNotificationTransport - In-memory notification capture for testing
 * 
 * This transport mimics the interface of DiscordNotificationService but:
 * - Makes zero external network calls
 * - Captures all notification payloads in memory
 * - Provides inspection methods for test assertions
 * - Executes synchronously for deterministic testing
 */
export class MockNotificationTransport {
  private captured: CapturedNotification[] = [];
  private config: DiscordConfig;
  private shouldFailNext: boolean = false;
  private failureMode: 'network' | 'validation' | null = null;

  constructor(config: DiscordConfig) {
    this.config = config;
  }

  /**
   * Simulate sending a notification (captures instead of sending)
   */
  async sendEventNotification(
    event: StellarSDK.rpc.Api.EventResponse,
    contractConfig: ContractConfig,
    requestId?: string
  ): Promise<boolean> {
    // Simulate failure scenarios for testing error handling
    if (this.shouldFailNext) {
      this.shouldFailNext = false;
      return false;
    }

    const eventName = getEventName(event.topic);
    const message = this.formatEventMessage(event, contractConfig);

    const notification: CapturedNotification = {
      eventId: event.id,
      contractAddress: contractConfig.address,
      eventName,
      message,
      timestamp: Date.now(),
      requestId,
    };

    this.captured.push(notification);
    return true;
  }

  /**
   * Simulate sending a test message
   */
  async sendTestMessage(requestId?: string): Promise<boolean> {
    const testNotification: CapturedNotification = {
      eventId: 'test-message',
      contractAddress: 'N/A',
      eventName: 'TestMessage',
      message: {
        embeds: [
          {
            title: '✅ Test Notification',
            description: 'Discord webhook is working correctly!',
            color: 0x00ff00,
            timestamp: new Date().toISOString(),
          },
        ],
      },
      timestamp: Date.now(),
      requestId,
    };

    this.captured.push(testNotification);
    return true;
  }

  /**
   * Get all captured notifications
   */
  getCaptured(): CapturedNotification[] {
    return [...this.captured];
  }

  /**
   * Get the count of captured notifications
   */
  getCapturedCount(): number {
    return this.captured.length;
  }

  /**
   * Get the most recent captured notification
   */
  getLatest(): CapturedNotification | undefined {
    return this.captured[this.captured.length - 1];
  }

  /**
   * Find notifications by event ID
   */
  findByEventId(eventId: string): CapturedNotification[] {
    return this.captured.filter((n) => n.eventId === eventId);
  }

  /**
   * Find notifications by contract address
   */
  findByContract(address: string): CapturedNotification[] {
    return this.captured.filter((n) => n.contractAddress === address);
  }

  /**
   * Clear all captured notifications
   */
  clear(): void {
    this.captured = [];
  }

  /**
   * Force the next send to fail (for error scenario testing)
   */
  failNext(mode: 'network' | 'validation' = 'network'): void {
    this.shouldFailNext = true;
    this.failureMode = mode;
  }

  /**
   * Get configuration
   */
  getConfig(): DiscordConfig {
    return { ...this.config };
  }

  /**
   * Format event message (mimics Discord service behavior)
   */
  private formatEventMessage(
    event: StellarSDK.rpc.Api.EventResponse,
    contractConfig: ContractConfig
  ): DiscordMessage {
    const eventName = getEventName(event.topic) ?? 'Unknown Event';
    const embed = this.createEventEmbed(event, contractConfig, eventName);

    return {
      embeds: [embed],
    };
  }

  /**
   * Create event embed (mimics Discord service behavior)
   */
  private createEventEmbed(
    event: StellarSDK.rpc.Api.EventResponse,
    contractConfig: ContractConfig,
    eventName: string
  ): DiscordEmbed {
    const fields: { name: string; value: string; inline?: boolean }[] = [
      {
        name: 'Contract',
        value: this.formatAddress(contractConfig.address),
        inline: true,
      },
      {
        name: 'Ledger',
        value: String(event.ledger),
        inline: true,
      },
      {
        name: 'Type',
        value: event.type,
        inline: true,
      },
    ];

    if (event.value) {
      fields.push({
        name: 'Value',
        value: this.formatValue(event.value),
        inline: false,
      });
    }

    return {
      title: `📡 Event: ${eventName}`,
      color: this.getEventColor(event.type),
      timestamp: new Date().toISOString(),
      fields,
    };
  }

  /**
   * Get color for event type
   */
  private getEventColor(eventType: string): number {
    const colors: Record<string, number> = {
      system: 0x0099ff,
      contract: 0x00ff00,
      transaction: 0xffaa00,
    };
    return colors[eventType] || 0x808080;
  }

  /**
   * Format address for display
   */
  private formatAddress(address: string): string {
    if (address.length <= 16) return address;
    return `${address.slice(0, 8)}...${address.slice(-8)}`;
  }

  /**
   * Format ScVal value for display
   */
  private formatValue(value: StellarSDK.xdr.ScVal): string {
    try {
      switch (value.switch()) {
        case StellarSDK.xdr.ScValType.scvVoid():
          return '_No data_';
        case StellarSDK.xdr.ScValType.scvU64():
          return String(value.u64());
        case StellarSDK.xdr.ScValType.scvI64():
          return String(value.i64());
        case StellarSDK.xdr.ScValType.scvString(): {
          const strVal = value.str().toString();
          return strVal.length > 500 ? strVal.slice(0, 500) + '...' : strVal;
        }
        case StellarSDK.xdr.ScValType.scvSymbol():
          return `🔹 ${value.sym().toString()}`;
        case StellarSDK.xdr.ScValType.scvAddress():
          return this.formatAddress(value.address().toString());
        default:
          return JSON.stringify(value).slice(0, 500);
      }
    } catch {
      return String(value);
    }
  }
}

/**
 * Factory function to create a mock transport
 */
export function createMockTransport(config?: Partial<DiscordConfig>): MockNotificationTransport {
  const defaultConfig: DiscordConfig = {
    webhookUrl: 'https://discord.com/api/webhooks/mock/test',
    webhookId: 'mock-webhook-id',
    ...config,
  };

  return new MockNotificationTransport(defaultConfig);
}
