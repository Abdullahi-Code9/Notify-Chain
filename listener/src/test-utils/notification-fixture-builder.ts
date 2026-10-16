/**
 * Notification Fixture Builder
 * 
 * A centralized, reusable utility for generating test notification payloads.
 * Uses the Builder pattern to provide flexible, deterministic test data.
 * 
 * Features:
 * - Deterministic output (no random data)
 * - Type-safe with full TypeScript support
 * - Builder pattern for easy customization
 * - Supports all notification types
 * - Removes duplicate test fixtures
 * 
 * @example
 * ```typescript
 * // Simple usage with defaults
 * const notification = NotificationFixtureBuilder.aScheduledNotification().build();
 * 
 * // Custom overrides
 * const customNotification = NotificationFixtureBuilder.aScheduledNotification()
 *   .withType(NotificationType.EMAIL)
 *   .withPriority(1)
 *   .build();
 * 
 * // Chain multiple modifications
 * const notification = NotificationFixtureBuilder.aScheduledNotification()
 *   .withPayload({ customField: 'value' })
 *   .withExecuteAt(new Date('2024-12-31T12:00:00Z'))
 *   .withMaxRetries(5)
 *   .build();
 * ```
 */

import * as StellarSDK from '@stellar/stellar-sdk';
import { xdr } from '@stellar/stellar-sdk';
import {
  NotificationType,
  NotificationStatus,
  CreateScheduledNotificationInput,
  ScheduledNotification,
  NotificationExecutionLog,
} from '../types/scheduled-notification';

/**
 * Deterministic date generator
 * Returns consistent dates relative to a fixed epoch
 */
class DeterministicDateGenerator {
  private static EPOCH = new Date('2024-01-01T00:00:00Z');

  static now(): Date {
    return new Date(this.EPOCH);
  }

  static future(offsetMs: number = 3600000): Date {
    return new Date(this.EPOCH.getTime() + offsetMs);
  }

  static past(offsetMs: number = 3600000): Date {
    return new Date(this.EPOCH.getTime() - offsetMs);
  }
}

/**
 * Base notification payload templates
 */
const PAYLOAD_TEMPLATES = {
  discord: {
    content: 'Test Discord notification',
    embeds: [
      {
        title: 'Test Notification',
        description: 'This is a test notification from fixture builder',
        color: 0x00ff00,
        fields: [
          { name: 'Environment', value: 'Test', inline: true },
          { name: 'Priority', value: 'Normal', inline: true },
        ],
      },
    ],
  },
  email: {
    subject: 'Test Email Notification',
    body: 'This is a test email notification',
    from: 'test@example.com',
    to: 'recipient@example.com',
  },
  webhook: {
    event: 'test.event',
    data: { key: 'value' },
    timestamp: '2024-01-01T00:00:00Z',
  },
  sms: {
    message: 'Test SMS notification',
    phoneNumber: '+1234567890',
  },
};

/**
 * Deterministic contract addresses and event IDs
 */
const TEST_CONSTANTS = {
  contractAddress: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
  eventId: 'test-event-00000001',
  webhookUrl: 'https://discord.com/api/webhooks/123456789/abcdefghijk',
  processorId: 'test-processor-uuid-0001',
  requestId: 'test-request-00001',
};

/**
 * Builder for CreateScheduledNotificationInput
 */
export class ScheduledNotificationInputBuilder {
  private input: CreateScheduledNotificationInput;

  constructor() {
    this.input = {
      payload: { ...PAYLOAD_TEMPLATES.discord },
      notificationType: NotificationType.DISCORD,
      targetRecipient: TEST_CONSTANTS.webhookUrl,
      executeAt: DeterministicDateGenerator.future(3600000), // 1 hour from epoch
      maxRetries: 3,
      priority: 5,
    };
  }

  withPayload(payload: Record<string, any>): this {
    this.input.payload = payload;
    return this;
  }

  withType(type: NotificationType): this {
    this.input.notificationType = type;
    // Auto-update payload template based on type
    switch (type) {
      case NotificationType.EMAIL:
        this.input.payload = { ...PAYLOAD_TEMPLATES.email };
        break;
      case NotificationType.WEBHOOK:
        this.input.payload = { ...PAYLOAD_TEMPLATES.webhook };
        break;
      case NotificationType.SMS:
        this.input.payload = { ...PAYLOAD_TEMPLATES.sms };
        break;
      default:
        this.input.payload = { ...PAYLOAD_TEMPLATES.discord };
    }
    return this;
  }

  withTargetRecipient(recipient: string): this {
    this.input.targetRecipient = recipient;
    return this;
  }

  withExecuteAt(date: Date): this {
    this.input.executeAt = date;
    return this;
  }

  withMaxRetries(retries: number): this {
    this.input.maxRetries = retries;
    return this;
  }

  withPriority(priority: number): this {
    this.input.priority = priority;
    return this;
  }

  withEventId(eventId: string): this {
    this.input.eventId = eventId;
    return this;
  }

  withContractAddress(address: string): this {
    this.input.contractAddress = address;
    return this;
  }

  withMetadata(metadata: Record<string, any>): this {
    this.input.metadata = metadata;
    return this;
  }

  /**
   * Build for immediate execution (past date)
   */
  forImmediateExecution(): this {
    this.input.executeAt = DeterministicDateGenerator.past(1000);
    return this;
  }

  /**
   * Build for future execution
   */
  forFutureExecution(offsetMs: number = 3600000): this {
    this.input.executeAt = DeterministicDateGenerator.future(offsetMs);
    return this;
  }

  build(): CreateScheduledNotificationInput {
    return { ...this.input };
  }
}

/**
 * Builder for ScheduledNotification (full entity with database fields)
 */
export class ScheduledNotificationBuilder {
  private notification: Partial<ScheduledNotification>;

  constructor() {
    this.notification = {
      id: 1,
      payload: JSON.stringify(PAYLOAD_TEMPLATES.discord),
      notificationType: NotificationType.DISCORD,
      targetRecipient: TEST_CONSTANTS.webhookUrl,
      executeAt: DeterministicDateGenerator.future(3600000),
      createdAt: DeterministicDateGenerator.now(),
      updatedAt: DeterministicDateGenerator.now(),
      status: NotificationStatus.PENDING,
      retryCount: 0,
      maxRetries: 3,
      priority: 5,
      processingStartedAt: null,
      processingCompletedAt: null,
      processorId: null,
      lockExpiresAt: null,
      lastError: null,
      errorDetails: null,
      eventId: null,
      contractAddress: null,
      metadata: null,
    };
  }

  withId(id: number): this {
    this.notification.id = id;
    return this;
  }

  withStatus(status: NotificationStatus): this {
    this.notification.status = status;
    return this;
  }

  withRetryCount(count: number): this {
    this.notification.retryCount = count;
    return this;
  }

  withProcessorId(processorId: string): this {
    this.notification.processorId = processorId;
    return this;
  }

  withLockExpiresAt(date: Date | null): this {
    this.notification.lockExpiresAt = date;
    return this;
  }

  withLastError(error: string): this {
    this.notification.lastError = error;
    return this;
  }

  asProcessing(processorId: string = TEST_CONSTANTS.processorId): this {
    this.notification.status = NotificationStatus.PROCESSING;
    this.notification.processorId = processorId;
    this.notification.lockExpiresAt = DeterministicDateGenerator.future(60000);
    this.notification.processingStartedAt = DeterministicDateGenerator.now();
    return this;
  }

  asCompleted(): this {
    this.notification.status = NotificationStatus.COMPLETED;
    this.notification.processingCompletedAt = DeterministicDateGenerator.now();
    this.notification.processorId = null;
    this.notification.lockExpiresAt = null;
    return this;
  }

  asFailed(error: string = 'Test error'): this {
    this.notification.status = NotificationStatus.FAILED;
    this.notification.lastError = error;
    this.notification.errorDetails = JSON.stringify({
      message: error,
      timestamp: DeterministicDateGenerator.now().toISOString(),
    });
    this.notification.processingCompletedAt = DeterministicDateGenerator.now();
    return this;
  }

  build(): ScheduledNotification {
    return this.notification as ScheduledNotification;
  }
}

/**
 * Builder for Stellar SDK EventResponse (for Discord/webhook tests)
 */
export class StellarEventBuilder {
  private event: Partial<StellarSDK.rpc.Api.EventResponse>;

  constructor() {
    this.event = {
      id: TEST_CONSTANTS.eventId,
      type: 'contract',
      ledger: 1000,
      ledgerClosedAt: '2024-01-01T00:00:00Z',
      transactionIndex: 1,
      operationIndex: 0,
      inSuccessfulContractCall: true,
      txHash: 'test-tx-hash-0001',
      topic: [xdr.ScVal.scvSymbol('test_event')],
      value: xdr.ScVal.scvString('test value'),
    };
  }

  withId(id: string): this {
    this.event.id = id;
    return this;
  }

  withTopic(topic: xdr.ScVal[]): this {
    this.event.topic = topic;
    return this;
  }

  withTopicSymbol(symbol: string): this {
    this.event.topic = [xdr.ScVal.scvSymbol(symbol)];
    return this;
  }

  withValue(value: xdr.ScVal): this {
    this.event.value = value;
    return this;
  }

  withStringValue(str: string): this {
    this.event.value = xdr.ScVal.scvString(str);
    return this;
  }

  withSymbolValue(symbol: string): this {
    this.event.value = xdr.ScVal.scvSymbol(symbol);
    return this;
  }

  withLedger(ledger: number): this {
    this.event.ledger = ledger;
    return this;
  }

  withTxHash(hash: string): this {
    this.event.txHash = hash;
    return this;
  }

  /**
   * Set the event value to an ScvMap containing a `payload_version` key,
   * matching the shape of the Soroban `NotificationScheduled` event data.
   *
   * Events that pre-date versioning should use `withValue` / `withStringValue`
   * directly; this helper is specifically for testing version-aware parsing.
   */
  withPayloadVersion(version: number): this {
    this.event.value = xdr.ScVal.scvMap([
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol('payload_version'),
        val: xdr.ScVal.scvU32(version),
      }),
    ]);
    return this;
  }

  build(): StellarSDK.rpc.Api.EventResponse {
    return this.event as StellarSDK.rpc.Api.EventResponse;
  }
}

/**
 * Builder for contract configuration
 */
export class ContractConfigBuilder {
  private config: { address: string; events: string[] };

  constructor() {
    this.config = {
      address: TEST_CONSTANTS.contractAddress,
      events: ['*'],
    };
  }

  withAddress(address: string): this {
    this.config.address = address;
    return this;
  }

  withEvents(events: string[]): this {
    this.config.events = events;
    return this;
  }

  withSingleEvent(event: string): this {
    this.config.events = [event];
    return this;
  }

  build(): { address: string; events: string[] } {
    return { ...this.config };
  }
}

/**
 * Builder for NotificationExecutionLog
 */
export class ExecutionLogBuilder {
  private log: Partial<NotificationExecutionLog>;

  constructor() {
    this.log = {
      id: 1,
      scheduledNotificationId: 1,
      executionAttempt: 1,
      executionTime: DeterministicDateGenerator.now(),
      status: 'SUCCESS',
      errorMessage: null,
      responseData: null,
      durationMs: 150,
    };
  }

  withScheduledNotificationId(id: number): this {
    this.log.scheduledNotificationId = id;
    return this;
  }

  withAttempt(attempt: number): this {
    this.log.executionAttempt = attempt;
    return this;
  }

  withStatus(status: 'SUCCESS' | 'FAILED' | 'RETRY'): this {
    this.log.status = status;
    return this;
  }

  withError(message: string): this {
    this.log.status = 'FAILED';
    this.log.errorMessage = message;
    return this;
  }

  withDuration(ms: number): this {
    this.log.durationMs = ms;
    return this;
  }

  build(): NotificationExecutionLog {
    return this.log as NotificationExecutionLog;
  }
}

/**
 * Main NotificationFixtureBuilder class (Facade)
 * Provides convenient static methods to access all builders
 */
export class NotificationFixtureBuilder {
  /**
   * Create a builder for CreateScheduledNotificationInput
   */
  static aScheduledNotificationInput(): ScheduledNotificationInputBuilder {
    return new ScheduledNotificationInputBuilder();
  }

  /**
   * Create a builder for ScheduledNotification (full entity)
   */
  static aScheduledNotification(): ScheduledNotificationBuilder {
    return new ScheduledNotificationBuilder();
  }

  /**
   * Create a builder for Stellar SDK EventResponse
   */
  static aStellarEvent(): StellarEventBuilder {
    return new StellarEventBuilder();
  }

  /**
   * Create a builder for contract configuration
   */
  static aContractConfig(): ContractConfigBuilder {
    return new ContractConfigBuilder();
  }

  /**
   * Create a builder for execution log
   */
  static anExecutionLog(): ExecutionLogBuilder {
    return new ExecutionLogBuilder();
  }

  /**
   * Get test constants (deterministic values)
   */
  static constants = TEST_CONSTANTS;

  /**
   * Get deterministic date generator
   */
  static dates = DeterministicDateGenerator;

  /**
   * Get payload templates
   */
  static payloads = PAYLOAD_TEMPLATES;
}
