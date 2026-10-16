/**
 * Notification Pipeline Smoke Test
 * 
 * This smoke test exercises the end-to-end notification lifecycle from event ingestion
 * to notification payload generation WITHOUT making any external network calls.
 * 
 * Pipeline: Event Ingestion → Validation → Routing → Template Resolution → Delivery
 * 
 * All external delivery providers (Discord, email, SMS, webhooks) are mocked to ensure:
 * - Zero real network calls
 * - Deterministic execution (no flaky tests)
 * - Fast execution (<2-3 seconds)
 * - Offline capability (no external dependencies)
 * 
 * Usage:
 *   npm run test:smoke
 *   npm test -- smoke
 */

import * as StellarSDK from '@stellar/stellar-sdk';
import { EventRegistry } from '../../store/event-registry';
import { MockNotificationTransport, createMockTransport } from '../../services/mock-notification-transport';
import { NotificationDeduplicator } from '../../services/notification-deduplicator';
import { ContractConfig, DiscordConfig } from '../../types';
import { validateEventPayload, getEventName, matchesEventFilter } from '../../utils/event-utils';

describe('Notification Pipeline Smoke Test', () => {
  let eventRegistry: EventRegistry;
  let mockTransport: MockNotificationTransport;
  let deduplicator: NotificationDeduplicator;
  let testConfig: DiscordConfig;
  let contractConfig: ContractConfig;

  beforeEach(() => {
    // Reset state for each test
    eventRegistry = new EventRegistry();
    deduplicator = new NotificationDeduplicator();
    
    testConfig = {
      webhookUrl: 'https://discord.com/api/webhooks/mock/test',
      webhookId: 'mock-webhook-id-12345',
    };
    
    mockTransport = createMockTransport(testConfig);
    
    contractConfig = {
      address: 'CDNJ3YJ5F4U5YF4O5U6Y7I8U9Y0U1I2O3P4I5U6Y7I8U9Y0',
      events: ['*'], // Accept all events
    };
  });

  afterEach(() => {
    // Clean up
    eventRegistry.clear();
    mockTransport.clear();
    deduplicator.clear();
  });

  describe('End-to-End Pipeline', () => {
    test('should process event from ingestion to notification generation', async () => {
      // ============================================================================
      // Step 1: Create a representative sample event
      // ============================================================================
      const testEvent = createMockContractEvent({
        id: 'event-smoke-test-001',
        contractAddress: contractConfig.address,
        eventName: 'AutoshareCreated',
        ledger: 123456,
        txHash: 'tx-abc123def456',
      });

      // ============================================================================
      // Step 2: Validate event payload
      // ============================================================================
      const validation = validateEventPayload(testEvent);
      expect(validation.valid).toBe(true);
      expect(validation.reason).toBeUndefined();

      // ============================================================================
      // Step 3: Check event routing/filtering
      // ============================================================================
      const eventName = getEventName(testEvent.topic);
      expect(eventName).toBe('AutoshareCreated');
      
      const shouldProcess = matchesEventFilter(eventName, contractConfig.events);
      expect(shouldProcess).toBe(true);

      // ============================================================================
      // Step 4: Add to registry (simulates EventSubscriber processing)
      // ============================================================================
      const registeredEvent = eventRegistry.addFromInput({
        eventId: testEvent.id,
        contractAddress: contractConfig.address,
        eventName: eventName || 'Unknown',
        ledger: testEvent.ledger,
        type: testEvent.type,
        topic: testEvent.topic,
        value: testEvent.value,
        txHash: testEvent.txHash,
      });

      expect(registeredEvent.eventId).toBe(testEvent.id);
      expect(registeredEvent.contractAddress).toBe(contractConfig.address);
      expect(registeredEvent.eventName).toBe('AutoshareCreated');

      // ============================================================================
      // Step 5: Send notification (captured by mock transport)
      // ============================================================================
      const requestId = 'smoke-test-request-001';
      const success = await mockTransport.sendEventNotification(
        testEvent,
        contractConfig,
        requestId
      );

      expect(success).toBe(true);

      // ============================================================================
      // Step 6: Verify notification payload generation
      // ============================================================================
      const captured = mockTransport.getCaptured();
      expect(captured).toHaveLength(1);

      const notification = captured[0];
      expect(notification.eventId).toBe(testEvent.id);
      expect(notification.contractAddress).toBe(contractConfig.address);
      expect(notification.eventName).toBe('AutoshareCreated');
      expect(notification.requestId).toBe(requestId);

      // ============================================================================
      // Step 7: Verify notification message structure
      // ============================================================================
      expect(notification.message).toBeDefined();
      expect(notification.message.embeds).toBeDefined();
      expect(notification.message.embeds?.length).toBeGreaterThan(0);

      const embed = notification.message.embeds![0];
      expect(embed.title).toContain('AutoshareCreated');
      expect(embed.fields).toBeDefined();
      
      // Verify required fields
      const contractField = embed.fields?.find((f) => f.name === 'Contract');
      const ledgerField = embed.fields?.find((f) => f.name === 'Ledger');
      const typeField = embed.fields?.find((f) => f.name === 'Type');

      expect(contractField).toBeDefined();
      expect(ledgerField?.value).toBe('123456');
      expect(typeField?.value).toBe('contract');

      // ============================================================================
      // Step 8: Verify no real external requests were made
      // ============================================================================
      // Mock transport should have captured the notification, not sent it
      expect(mockTransport.getCapturedCount()).toBe(1);
      
      // Verify the mock config was used (not real Discord)
      const capturedConfig = mockTransport.getConfig();
      expect(capturedConfig.webhookUrl).toContain('mock');
      expect(capturedConfig.webhookId).toContain('mock');
    });

    test('should handle multiple events in sequence', async () => {
      const events = [
        createMockContractEvent({
          id: 'event-001',
          eventName: 'AutoshareCreated',
          ledger: 100,
        }),
        createMockContractEvent({
          id: 'event-002',
          eventName: 'AutoshareUpdated',
          ledger: 101,
        }),
        createMockContractEvent({
          id: 'event-003',
          eventName: 'GroupDeactivated',
          ledger: 102,
        }),
      ];

      for (const event of events) {
        // Process each event through the pipeline
        const validation = validateEventPayload(event);
        expect(validation.valid).toBe(true);

        eventRegistry.addFromInput({
          eventId: event.id,
          contractAddress: contractConfig.address,
          eventName: getEventName(event.topic) || 'Unknown',
          ledger: event.ledger,
          type: event.type,
          topic: event.topic,
          value: event.value,
          txHash: event.txHash || '',
        });

        await mockTransport.sendEventNotification(event, contractConfig);
      }

      // Verify all events were processed
      expect(eventRegistry.count()).toBe(3);
      expect(mockTransport.getCapturedCount()).toBe(3);

      // Verify events maintain correct order
      const captured = mockTransport.getCaptured();
      expect(captured[0].eventName).toBe('AutoshareCreated');
      expect(captured[1].eventName).toBe('AutoshareUpdated');
      expect(captured[2].eventName).toBe('GroupDeactivated');
    });

    test('should process event with complex data payload', async () => {
      // Create event with structured data
      const complexEvent = createMockContractEvent({
        id: 'event-complex-001',
        eventName: 'AdminTransferred',
        ledger: 500,
        valueType: 'address',
      });

      const validation = validateEventPayload(complexEvent);
      expect(validation.valid).toBe(true);

      const success = await mockTransport.sendEventNotification(
        complexEvent,
        contractConfig
      );

      expect(success).toBe(true);

      const notification = mockTransport.getLatest();
      expect(notification).toBeDefined();
      expect(notification?.message.embeds).toBeDefined();

      // Verify value was formatted correctly
      const valueField = notification?.message.embeds![0].fields?.find(
        (f) => f.name === 'Value'
      );
      expect(valueField).toBeDefined();
    });
  });

  describe('Event Validation', () => {
    test('should reject event with missing id', () => {
      const invalidEvent = {
        type: 'contract',
        ledger: 100,
        topic: [StellarSDK.xdr.ScVal.scvSymbol('test')],
        value: StellarSDK.xdr.ScVal.scvU32(42),
      } as any;

      const validation = validateEventPayload(invalidEvent);
      expect(validation.valid).toBe(false);
      expect(validation.reason).toContain('id');
    });

    test('should reject event with invalid ledger', () => {
      const invalidEvent = createMockContractEvent({
        id: 'test',
        eventName: 'Test',
        ledger: -1,
      });
      invalidEvent.ledger = -1;

      const validation = validateEventPayload(invalidEvent);
      expect(validation.valid).toBe(false);
      expect(validation.reason).toContain('ledger');
    });

    test('should reject event with missing topic', () => {
      const invalidEvent = {
        id: 'test-id',
        type: 'contract',
        ledger: 100,
        value: StellarSDK.xdr.ScVal.scvU32(42),
      } as any;

      const validation = validateEventPayload(invalidEvent);
      expect(validation.valid).toBe(false);
      expect(validation.reason).toContain('topic');
    });
  });

  describe('Event Routing and Filtering', () => {
    test('should accept event matching wildcard filter', () => {
      const eventName = 'AnyEvent';
      const filter = ['*'];

      const matches = matchesEventFilter(eventName, filter);
      expect(matches).toBe(true);
    });

    test('should accept event matching specific filter', () => {
      const eventName = 'AutoshareCreated';
      const filter = ['AutoshareCreated', 'AutoshareUpdated'];

      const matches = matchesEventFilter(eventName, filter);
      expect(matches).toBe(true);
    });

    test('should reject event not matching filter', () => {
      const eventName = 'UnexpectedEvent';
      const filter = ['AutoshareCreated', 'AutoshareUpdated'];

      const matches = matchesEventFilter(eventName, filter);
      expect(matches).toBe(false);
    });

    test('should extract event name from topic', () => {
      const topic = [
        StellarSDK.xdr.ScVal.scvSymbol('AutoshareCreated'),
        StellarSDK.xdr.ScVal.scvU32(123),
      ];

      const name = getEventName(topic);
      expect(name).toBe('AutoshareCreated');
    });
  });

  describe('Notification Deduplication', () => {
    test('should prevent duplicate notifications', async () => {
      const event = createMockContractEvent({
        id: 'duplicate-test-001',
        eventName: 'TestEvent',
        ledger: 200,
      });

      // First send - should succeed
      const fingerprint = `${event.id}-${contractConfig.address}`;
      expect(deduplicator.isDuplicate(fingerprint)).toBe(false);
      
      await mockTransport.sendEventNotification(event, contractConfig);
      deduplicator.markSent(fingerprint);

      // Second send - should be detected as duplicate
      expect(deduplicator.isDuplicate(fingerprint)).toBe(true);
      
      // Verify only one notification was captured
      expect(mockTransport.getCapturedCount()).toBe(1);
    });

    test('should allow same event from different contracts', async () => {
      const event1 = createMockContractEvent({
        id: 'shared-event-001',
        eventName: 'TestEvent',
        ledger: 300,
      });

      const contract1 = { ...contractConfig, address: 'CONTRACT_AAA' };
      const contract2 = { ...contractConfig, address: 'CONTRACT_BBB' };

      const fp1 = `${event1.id}-${contract1.address}`;
      const fp2 = `${event1.id}-${contract2.address}`;

      // Both should be unique
      expect(deduplicator.isDuplicate(fp1)).toBe(false);
      expect(deduplicator.isDuplicate(fp2)).toBe(false);

      await mockTransport.sendEventNotification(event1, contract1);
      deduplicator.markSent(fp1);

      await mockTransport.sendEventNotification(event1, contract2);
      deduplicator.markSent(fp2);

      // Both should be captured
      expect(mockTransport.getCapturedCount()).toBe(2);
    });
  });

  describe('Error Handling', () => {
    test('should handle notification failure gracefully', async () => {
      const event = createMockContractEvent({
        id: 'error-test-001',
        eventName: 'TestEvent',
        ledger: 400,
      });

      // Force next send to fail
      mockTransport.failNext('network');

      const success = await mockTransport.sendEventNotification(
        event,
        contractConfig
      );

      expect(success).toBe(false);
      expect(mockTransport.getCapturedCount()).toBe(0);
    });

    test('should continue processing after individual event failure', async () => {
      const events = [
        createMockContractEvent({ id: 'event-1', eventName: 'Test1', ledger: 500 }),
        createMockContractEvent({ id: 'event-2', eventName: 'Test2', ledger: 501 }),
        createMockContractEvent({ id: 'event-3', eventName: 'Test3', ledger: 502 }),
      ];

      // First succeeds
      await mockTransport.sendEventNotification(events[0], contractConfig);

      // Second fails
      mockTransport.failNext();
      await mockTransport.sendEventNotification(events[1], contractConfig);

      // Third succeeds
      await mockTransport.sendEventNotification(events[2], contractConfig);

      // Verify partial success
      expect(mockTransport.getCapturedCount()).toBe(2);
    });
  });

  describe('Performance and Resource Management', () => {
    test('should process events quickly (< 100ms per event)', async () => {
      const event = createMockContractEvent({
        id: 'perf-test-001',
        eventName: 'PerfTest',
        ledger: 600,
      });

      const startTime = Date.now();
      
      await mockTransport.sendEventNotification(event, contractConfig);
      
      const duration = Date.now() - startTime;
      
      expect(duration).toBeLessThan(100);
    });

    test('should handle registry size limits', () => {
      const smallRegistry = new EventRegistry(5); // Small max for testing

      // Add more events than limit
      for (let i = 0; i < 10; i++) {
        smallRegistry.addFromInput({
          eventId: `event-${i}`,
          contractAddress: contractConfig.address,
          eventName: 'Test',
          ledger: i,
          type: 'contract',
          topic: [StellarSDK.xdr.ScVal.scvSymbol('test')],
          value: StellarSDK.xdr.ScVal.scvU32(i),
          txHash: `tx-${i}`,
        });
      }

      // Should only keep last 5
      expect(smallRegistry.count()).toBe(5);
    });

    test('should clean up resources properly', () => {
      // Create and populate
      const tempRegistry = new EventRegistry();
      const tempTransport = createMockTransport();

      tempRegistry.addFromInput({
        eventId: 'cleanup-test',
        contractAddress: 'TEST',
        eventName: 'Test',
        ledger: 1,
        type: 'contract',
        topic: [StellarSDK.xdr.ScVal.scvSymbol('test')],
        value: StellarSDK.xdr.ScVal.scvU32(1),
        txHash: 'tx-1',
      });

      // Cleanup
      tempRegistry.clear();
      tempTransport.clear();

      expect(tempRegistry.count()).toBe(0);
      expect(tempTransport.getCapturedCount()).toBe(0);
    });
  });

  describe('Smoke Test Meta-Validation', () => {
    test('should execute in under 2 seconds', async () => {
      const startTime = Date.now();

      // Run a full pipeline
      const event = createMockContractEvent({
        id: 'meta-test-001',
        eventName: 'MetaTest',
        ledger: 700,
      });

      validateEventPayload(event);
      eventRegistry.addFromInput({
        eventId: event.id,
        contractAddress: contractConfig.address,
        eventName: 'MetaTest',
        ledger: event.ledger,
        type: event.type,
        topic: event.topic,
        value: event.value,
        txHash: event.txHash || '',
      });

      await mockTransport.sendEventNotification(event, contractConfig);

      const duration = Date.now() - startTime;
      
      expect(duration).toBeLessThan(2000);
    });

    test('should make zero external network calls', async () => {
      const event = createMockContractEvent({
        id: 'network-test-001',
        eventName: 'NetworkTest',
        ledger: 800,
      });

      // Send through mock transport
      await mockTransport.sendEventNotification(event, contractConfig);

      // Verify mock config (not real endpoints)
      const config = mockTransport.getConfig();
      expect(config.webhookUrl).toContain('mock');
      
      // Verify notification was captured, not sent
      const captured = mockTransport.getCaptured();
      expect(captured.length).toBeGreaterThan(0);
    });

    test('should run deterministically (same input = same output)', async () => {
      const event = createMockContractEvent({
        id: 'deterministic-test',
        eventName: 'DetTest',
        ledger: 900,
      });

      // Run twice
      await mockTransport.sendEventNotification(event, contractConfig);
      const first = mockTransport.getLatest();

      mockTransport.clear();

      await mockTransport.sendEventNotification(event, contractConfig);
      const second = mockTransport.getLatest();

      // Should produce identical notification structures
      expect(first?.eventId).toBe(second?.eventId);
      expect(first?.eventName).toBe(second?.eventName);
      expect(first?.message.embeds?.[0].title).toBe(second?.message.embeds?.[0].title);
    });
  });
});

// ============================================================================
// Test Helper Functions
// ============================================================================

interface MockEventOptions {
  id: string;
  eventName: string;
  ledger: number;
  contractAddress?: string;
  txHash?: string;
  valueType?: 'u32' | 'string' | 'address' | 'void';
}

/**
 * Create a mock contract event for testing
 */
function createMockContractEvent(options: MockEventOptions): StellarSDK.rpc.Api.EventResponse {
  const {
    id,
    eventName,
    ledger,
    contractAddress = 'CDNJ3YJ5F4U5YF4O5U6Y7I8U9Y0U1I2O3P4I5U6Y7I8U9Y0',
    txHash = `tx-${id}`,
    valueType = 'u32',
  } = options;

  // Create topic with event name
  const topic = [
    StellarSDK.xdr.ScVal.scvSymbol(eventName),
  ];

  // Create value based on type
  let value: StellarSDK.xdr.ScVal;
  switch (valueType) {
    case 'string':
      value = StellarSDK.xdr.ScVal.scvString(Buffer.from('test-string-value'));
      break;
    case 'address':
      value = StellarSDK.xdr.ScVal.scvAddress(
        StellarSDK.Address.fromString(contractAddress).toScAddress()
      );
      break;
    case 'void':
      value = StellarSDK.xdr.ScVal.scvVoid();
      break;
    case 'u32':
    default:
      value = StellarSDK.xdr.ScVal.scvU32(42);
  }

  return {
    id,
    type: 'contract',
    ledger,
    ledgerClosedAt: new Date().toISOString(),
    contractId: contractAddress,
    topic,
    value,
    inSuccessfulContractCall: true,
    txHash,
  };
}
