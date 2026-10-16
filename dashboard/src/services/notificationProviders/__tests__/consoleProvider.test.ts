/**
 * Tests for ConsoleProvider
 *
 * Verifies NotificationProvider interface implementation,
 * console output formatting, and configuration handling.
 */

import { ConsoleProvider } from '../consoleProvider';
import type { BlockchainEvent } from '../../../types/event';

describe('ConsoleProvider', () => {
  let provider: ConsoleProvider;
  let consoleSpy: {
    log: jest.SpyInstance;
    info: jest.SpyInstance;
    warn: jest.SpyInstance;
    error: jest.SpyInstance;
    table: jest.SpyInstance;
    group: jest.SpyInstance;
    groupEnd: jest.SpyInstance;
  };

  const mockEvent: BlockchainEvent = {
    eventId: 'evt_0123456789abcdef',
    contractAddress: 'C1234567890abcdef',
    eventName: 'NotificationScheduled',
    ledger: 12345,
    type: 'notification_scheduled',
    topic: ['topic1', 'topic2'],
    value: 'test_value',
    txHash: 'tx_0123456789abcdef',
    receivedAt: Date.now(),
    notificationStatus: 'active',
  };

  beforeEach(() => {
    provider = new ConsoleProvider({ enabled: true });

    consoleSpy = {
      log: jest.spyOn(console, 'log').mockImplementation(() => {}),
      info: jest.spyOn(console, 'info').mockImplementation(() => {}),
      warn: jest.spyOn(console, 'warn').mockImplementation(() => {}),
      error: jest.spyOn(console, 'error').mockImplementation(() => {}),
      table: jest.spyOn(console, 'table').mockImplementation(() => {}),
      group: jest.spyOn(console, 'group').mockImplementation(() => {}),
      groupEnd: jest.spyOn(console, 'groupEnd').mockImplementation(() => {}),
    };
  });

  afterEach(() => {
    jest.clearAllMocks();
    Object.values(consoleSpy).forEach((spy) => spy.mockRestore());
  });

  describe('Interface Implementation', () => {
    it('should implement NotificationProvider interface', () => {
      expect(typeof provider.getName).toBe('function');
      expect(typeof provider.isAvailable).toBe('function');
      expect(typeof provider.send).toBe('function');
      expect(typeof provider.getConfig).toBe('function');
      expect(typeof provider.updateConfig).toBe('function');
    });

    it('should return correct provider name', () => {
      expect(provider.getName()).toBe('ConsoleProvider');
    });

    it('should have optional methods implemented', () => {
      expect(typeof provider.sendBatch).toBe('function');
      expect(typeof provider.healthCheck).toBe('function');
    });
  });

  describe('Availability', () => {
    it('should report as available when enabled', () => {
      provider.updateConfig({ enabled: true });
      expect(provider.isAvailable()).toBe(true);
    });

    it('should report as unavailable when disabled', () => {
      provider.updateConfig({ enabled: false });
      expect(provider.isAvailable()).toBe(false);
    });

    it('should default to enabled', () => {
      const newProvider = new ConsoleProvider();
      expect(newProvider.isAvailable()).toBe(true);
    });
  });

  describe('Sending Notifications', () => {
    it('should send notification successfully', async () => {
      const result = await provider.send(mockEvent);

      expect(result.status).toBe('success');
      expect(result.message).toContain('sent to console');
      expect(result.metadata?.deliveryId).toBe(mockEvent.eventId);
    });

    it('should not send when provider is disabled', async () => {
      provider.updateConfig({ enabled: false });
      const result = await provider.send(mockEvent);

      expect(result.status).toBe('skipped');
      expect(consoleSpy.log).not.toHaveBeenCalled();
    });

    it('should output formatted message to console', async () => {
      await provider.send(mockEvent);

      expect(consoleSpy.log).toHaveBeenCalled();
      const logCall = consoleSpy.log.mock.calls[0];
      const message = logCall[0];

      expect(message).toContain('Blockchain Event Notification');
      expect(message).toContain(mockEvent.eventName);
      expect(message).toContain(mockEvent.type);
    });

    it('should output table with event data', async () => {
      await provider.send(mockEvent);

      expect(consoleSpy.table).toHaveBeenCalledWith(mockEvent);
    });

    it('should group console output', async () => {
      await provider.send(mockEvent);

      expect(consoleSpy.group).toHaveBeenCalled();
      expect(consoleSpy.groupEnd).toHaveBeenCalled();
    });

    it('should include topics in output', async () => {
      await provider.send(mockEvent);

      const groupCalls = consoleSpy.log.mock.calls;
      const hasTopics = groupCalls.some((call) =>
        JSON.stringify(call).includes('Topics')
      );
      expect(hasTopics).toBe(true);
    });

    it('should handle events without optional fields', async () => {
      const minimalEvent: BlockchainEvent = {
        eventId: 'evt_test',
        contractAddress: 'C1234567890abcdef',
        eventName: null,
        ledger: 100,
        type: 'generic_event',
        topic: [],
        value: 'value',
        receivedAt: Date.now(),
      };

      const result = await provider.send(minimalEvent);

      expect(result.status).toBe('success');
      expect(consoleSpy.log).toHaveBeenCalled();
    });

    it('should include duration in metadata', async () => {
      const result = await provider.send(mockEvent);

      expect(result.metadata?.durationMs).toBeDefined();
      expect(typeof result.metadata?.durationMs).toBe('number');
      expect(result.metadata?.durationMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Batch Sending', () => {
    it('should send batch of notifications', async () => {
      const events = [mockEvent, { ...mockEvent, eventId: 'evt_2' }];

      const results = await provider.sendBatch(events);

      expect(results).toHaveLength(2);
      expect(results[0].status).toBe('success');
      expect(results[1].status).toBe('success');
    });

    it('should handle empty batch', async () => {
      const results = await provider.sendBatch([]);

      expect(results).toHaveLength(0);
    });

    it('should send each event individually in batch', async () => {
      const events = Array.from({ length: 3 }, (_, i) => ({
        ...mockEvent,
        eventId: `evt_${i}`,
      }));

      await provider.sendBatch(events);

      // Should call table 3 times (once per event)
      expect(consoleSpy.table).toHaveBeenCalledTimes(3);
    });
  });

  describe('Log Level Selection', () => {
    const createEvent = (type: string): BlockchainEvent => ({
      ...mockEvent,
      type,
      eventName: type,
    });

    it('should use error level for error-like events', async () => {
      await provider.send(createEvent('notification_failed'));
      expect(consoleSpy.error).toHaveBeenCalled();
    });

    it('should use error level for revoked events', async () => {
      await provider.send(createEvent('notification_revoked'));
      expect(consoleSpy.error).toHaveBeenCalled();
    });

    it('should use warn level for expiry events', async () => {
      await provider.send(createEvent('notification_expired'));
      expect(consoleSpy.warn).toHaveBeenCalled();
    });

    it('should use warn level for degraded events', async () => {
      await provider.send(createEvent('system_degraded'));
      expect(consoleSpy.warn).toHaveBeenCalled();
    });

    it('should use info level for success events', async () => {
      await provider.send(createEvent('notification_created'));
      expect(consoleSpy.info).toHaveBeenCalled();
    });

    it('should use info level for completed events', async () => {
      await provider.send(createEvent('operation_completed'));
      expect(consoleSpy.info).toHaveBeenCalled();
    });

    it('should use log level for generic events', async () => {
      consoleSpy.log.mockClear();
      await provider.send(createEvent('generic_event'));
      expect(consoleSpy.log).toHaveBeenCalled();
    });
  });

  describe('Configuration', () => {
    it('should return current configuration', () => {
      const config = provider.getConfig();

      expect(config.enabled).toBe(true);
      expect(config.maxRetries).toBeDefined();
      expect(config.timeoutMs).toBeDefined();
    });

    it('should update configuration', () => {
      provider.updateConfig({
        timeoutMs: 60000,
        maxRetries: 3,
      });

      const config = provider.getConfig();
      expect(config.timeoutMs).toBe(60000);
      expect(config.maxRetries).toBe(3);
    });

    it('should accept custom configuration in constructor', () => {
      const customProvider = new ConsoleProvider({
        enabled: true,
        timeoutMs: 10000,
        styleEnabled: false,
      });

      const config = customProvider.getConfig();
      expect(config.timeoutMs).toBe(10000);
    });

    it('should respect styleEnabled configuration', async () => {
      const styledProvider = new ConsoleProvider({ styleEnabled: true });
      await styledProvider.send(mockEvent);

      // First argument should be format string when styled
      expect(consoleSpy.log.mock.calls[0][0]).toContain('%c');

      consoleSpy.log.mockClear();

      const plainProvider = new ConsoleProvider({ styleEnabled: false });
      await plainProvider.send(mockEvent);

      // Should output plain text (no format string)
      expect(consoleSpy.log.mock.calls[0][0]).not.toContain('%c');
    });
  });

  describe('Health Checks', () => {
    it('should report healthy when available', async () => {
      provider.updateConfig({ enabled: true });
      const health = await provider.healthCheck();

      expect(health.healthy).toBe(true);
      expect(health.reason).toContain('available');
    });

    it('should report unhealthy when disabled', async () => {
      provider.updateConfig({ enabled: false });
      const health = await provider.healthCheck();

      expect(health.healthy).toBe(false);
    });

    it('should include reason in health status', async () => {
      const health = await provider.healthCheck();

      expect(health.reason).toBeDefined();
      expect(typeof health.reason).toBe('string');
    });
  });

  describe('Error Handling', () => {
    it('should handle console errors gracefully', async () => {
      consoleSpy.log.mockImplementationOnce(() => {
        throw new Error('Console error');
      });

      const result = await provider.send(mockEvent);

      expect(result.status).toBe('failure');
      expect(result.error?.code).toBe('CONSOLE_ERROR');
    });

    it('should return appropriate error in result', async () => {
      consoleSpy.table.mockImplementationOnce(() => {
        throw new Error('Table error');
      });

      const result = await provider.send(mockEvent);

      expect(result.error).toBeDefined();
      expect(result.error?.message).toContain('Table error');
    });
  });

  describe('Event Formatting', () => {
    it('should include event name in formatted output', async () => {
      await provider.send(mockEvent);

      const logCall = consoleSpy.log.mock.calls[0][0];
      expect(logCall).toContain(mockEvent.eventName);
    });

    it('should include contract address in formatted output', async () => {
      await provider.send(mockEvent);

      const logCall = consoleSpy.log.mock.calls[0][0];
      expect(logCall).toContain(mockEvent.contractAddress.slice(0, 8));
    });

    it('should include ledger in formatted output', async () => {
      await provider.send(mockEvent);

      const logCall = consoleSpy.log.mock.calls[0][0];
      expect(logCall).toContain(mockEvent.ledger.toString());
    });

    it('should include notification status if present', async () => {
      await provider.send(mockEvent);

      const logCall = consoleSpy.log.mock.calls[0][0];
      expect(logCall).toContain(mockEvent.notificationStatus);
    });

    it('should exclude notification status if not present', async () => {
      const eventWithoutStatus = { ...mockEvent, notificationStatus: undefined };
      await provider.send(eventWithoutStatus);

      const logCall = consoleSpy.log.mock.calls[0][0];
      expect(logCall).not.toContain('Status:');
    });
  });
});
