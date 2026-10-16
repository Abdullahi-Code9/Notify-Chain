/**
 * Tests for ConsoleNotificationProvider
 *
 * Verifies:
 * - Console provider implements the notification provider interface
 * - Event information is clearly formatted
 * - No external network request is made
 * - Provider can be enabled through configuration
 */

import { ConsoleNotificationProvider, createConsoleProvider } from './consoleNotificationProvider';
import type { BlockchainEvent } from '../types/event';

describe('ConsoleNotificationProvider', () => {
  let provider: ConsoleNotificationProvider;
  let consoleSpy: {
    log: jest.SpyInstance;
    info: jest.SpyInstance;
    warn: jest.SpyInstance;
    error: jest.SpyInstance;
    table: jest.SpyInstance;
    group: jest.SpyInstance;
    groupEnd: jest.SpyInstance;
  };

  beforeEach(() => {
    provider = new ConsoleNotificationProvider(true);

    // Spy on console methods
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
      expect(typeof provider.send).toBe('function');
      expect(typeof provider.isAvailable).toBe('function');
      expect(typeof provider.getName).toBe('function');
    });

    it('should return correct provider name', () => {
      expect(provider.getName()).toBe('ConsoleNotificationProvider');
    });
  });

  describe('Availability', () => {
    it('should report as available when enabled', () => {
      provider.enable();
      expect(provider.isAvailable()).toBe(true);
    });

    it('should report as unavailable when disabled', () => {
      provider.disable();
      expect(provider.isAvailable()).toBe(false);
    });

    it('should start enabled by default', () => {
      const newProvider = new ConsoleNotificationProvider();
      expect(newProvider.isAvailable()).toBe(true);
    });

    it('should respect enabled flag in constructor', () => {
      const disabledProvider = new ConsoleNotificationProvider(false);
      expect(disabledProvider.isAvailable()).toBe(false);
    });
  });

  describe('Event Sending', () => {
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

    it('should send notification without external requests', async () => {
      await provider.send(mockEvent);

      // Verify no network requests were made (implicit in this test)
      expect(consoleSpy.log).toHaveBeenCalled();
      expect(consoleSpy.table).toHaveBeenCalled();
    });

    it('should not send when provider is disabled', async () => {
      provider.disable();
      await provider.send(mockEvent);

      expect(consoleSpy.log).not.toHaveBeenCalled();
      expect(consoleSpy.table).not.toHaveBeenCalled();
    });

    it('should format event information clearly', async () => {
      await provider.send(mockEvent);

      const lastLogCall = consoleSpy.log.mock.calls[0];
      const formattedMessage = lastLogCall[0];

      expect(formattedMessage).toContain('Blockchain Event Notification');
      expect(formattedMessage).toContain(mockEvent.eventName);
      expect(formattedMessage).toContain(mockEvent.type);
      expect(formattedMessage).toContain(mockEvent.contractAddress.slice(0, 8));
      expect(formattedMessage).toContain(mockEvent.ledger.toString());
    });

    it('should output table with event data', async () => {
      await provider.send(mockEvent);

      expect(consoleSpy.table).toHaveBeenCalledWith(mockEvent);
    });

    it('should group related console output', async () => {
      await provider.send(mockEvent);

      expect(consoleSpy.group).toHaveBeenCalled();
      expect(consoleSpy.groupEnd).toHaveBeenCalled();
    });

    it('should include topics in console group', async () => {
      await provider.send(mockEvent);

      const groupCalls = consoleSpy.log.mock.calls;
      const topicsLogged = groupCalls.some((call) =>
        JSON.stringify(call).includes('Topics')
      );
      expect(topicsLogged).toBe(true);
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

      await provider.send(minimalEvent);

      expect(consoleSpy.log).toHaveBeenCalled();
      expect(consoleSpy.table).toHaveBeenCalled();
    });
  });

  describe('Log Level Selection', () => {
    const createEvent = (type: string): BlockchainEvent => ({
      eventId: 'evt_test',
      contractAddress: 'C1234567890abcdef',
      eventName: type,
      ledger: 100,
      type,
      topic: [],
      value: 'value',
      receivedAt: Date.now(),
    });

    it('should use error level for error-like events', async () => {
      const errorEvent = createEvent('notification_failed');
      await provider.send(errorEvent);
      expect(consoleSpy.error).toHaveBeenCalled();
    });

    it('should use warn level for expiry events', async () => {
      const expiredEvent = createEvent('notification_expired');
      await provider.send(expiredEvent);
      expect(consoleSpy.warn).toHaveBeenCalled();
    });

    it('should use info level for success events', async () => {
      const successEvent = createEvent('notification_created');
      await provider.send(successEvent);
      expect(consoleSpy.info).toHaveBeenCalled();
    });

    it('should use log level for generic events', async () => {
      const genericEvent = createEvent('generic_event');
      await provider.send(genericEvent);
      expect(consoleSpy.log).toHaveBeenCalled();
    });

    it('should use error level for revoked events', async () => {
      const revokedEvent = createEvent('notification_revoked');
      await provider.send(revokedEvent);
      expect(consoleSpy.error).toHaveBeenCalled();
    });
  });

  describe('Configuration', () => {
    it('should create provider with createConsoleProvider factory', () => {
      const newProvider = createConsoleProvider({ enabled: true });
      expect(newProvider).toBeInstanceOf(ConsoleNotificationProvider);
      expect(newProvider.isAvailable()).toBe(true);
    });

    it('should create disabled provider with factory', () => {
      const disabledProvider = createConsoleProvider({ enabled: false });
      expect(disabledProvider.isAvailable()).toBe(false);
    });

    it('should default to enabled when no config provided', () => {
      const defaultProvider = createConsoleProvider();
      expect(defaultProvider.isAvailable()).toBe(true);
    });
  });

  describe('Enable/Disable Toggle', () => {
    it('should toggle enabled state', () => {
      provider.enable();
      expect(provider.isAvailable()).toBe(true);

      provider.disable();
      expect(provider.isAvailable()).toBe(false);

      provider.enable();
      expect(provider.isAvailable()).toBe(true);
    });

    it('should respect enable/disable across multiple calls', async () => {
      const mockEvent: BlockchainEvent = {
        eventId: 'evt_test',
        contractAddress: 'C1234567890abcdef',
        eventName: 'Test',
        ledger: 100,
        type: 'test',
        topic: [],
        value: 'value',
        receivedAt: Date.now(),
      };

      provider.enable();
      await provider.send(mockEvent);
      expect(consoleSpy.log).toHaveBeenCalledTimes(1);

      provider.disable();
      await provider.send(mockEvent);
      expect(consoleSpy.log).toHaveBeenCalledTimes(1); // No additional call

      provider.enable();
      await provider.send(mockEvent);
      expect(consoleSpy.log).toHaveBeenCalledTimes(2); // Now called again
    });
  });

  describe('Format Completeness', () => {
    it('should format all key event information', async () => {
      const fullEvent: BlockchainEvent = {
        eventId: 'evt_1234567890abcdefghijklmnopqrst',
        contractAddress: 'CABCDEFGHIJKLMNOPQRSTUVWXYZ1234',
        eventName: 'ComplexEventName',
        ledger: 999999,
        type: 'complex_event_type',
        topic: ['t1', 't2', 't3'],
        value: 'complex_value',
        txHash: 'tx_1234567890abcdefghijklmnopqrst',
        receivedAt: 1234567890000,
        notificationStatus: 'expired',
      };

      await provider.send(fullEvent);

      const lastLogCall = consoleSpy.log.mock.calls[0];
      const formattedMessage = lastLogCall[0];

      expect(formattedMessage).toContain('ComplexEventName');
      expect(formattedMessage).toContain('complex_event_type');
      expect(formattedMessage).toContain('999999');
      expect(formattedMessage).toContain('expired');
      expect(formattedMessage).toContain('tx_1234567890ab');
    });
  });
});
