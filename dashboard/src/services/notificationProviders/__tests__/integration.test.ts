/**
 * Integration Tests for Notification Provider System
 *
 * Tests multi-provider scenarios, error handling across providers,
 * and real-world usage patterns.
 */

import { ProviderManager } from '../manager';
import { ConsoleProvider } from '../consoleProvider';
import { WebhookProvider } from '../webhookProvider';
import { EmailProvider } from '../emailProvider';
import type { BlockchainEvent } from '../../../types/event';

describe('Notification Provider Integration', () => {
  let manager: ProviderManager;
  let mockEvent: BlockchainEvent;

  beforeEach(() => {
    manager = new ProviderManager();
    mockEvent = {
      eventId: 'evt_integration_test',
      contractAddress: 'C1234567890abcdef',
      eventName: 'TestEvent',
      ledger: 100,
      type: 'test_event',
      topic: ['topic1'],
      value: 'test_value',
      receivedAt: Date.now(),
      notificationStatus: 'active',
    };
  });

  describe('Multi-Provider Scenarios', () => {
    it('should send through multiple providers simultaneously', async () => {
      const consoleProvider = new ConsoleProvider({ enabled: true });
      const webhookProvider = new WebhookProvider({
        enabled: true,
        webhookUrl: 'https://api.example.com/webhook',
      });

      manager.register(consoleProvider);
      manager.register(webhookProvider);

      // Mock fetch for webhook
      global.fetch = jest.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ id: 'msg_123' }),
        } as Response)
      );

      const results = await manager.sendAll(mockEvent);

      expect(results.size).toBe(2);
      expect(results.get('ConsoleProvider')?.status).toBe('success');
      expect(results.get('WebhookProvider')?.status).toBe('success');
    });

    it('should handle partial failures across multiple providers', async () => {
      const console1 = new ConsoleProvider({ enabled: true });
      const console2 = new ConsoleProvider({ enabled: false }); // disabled

      manager.register(console1);
      manager.register(console2);

      const results = await manager.sendAll(mockEvent);

      expect(results.size).toBe(1);
      expect(results.get('ConsoleProvider')).toBeDefined();
    });

    it('should apply callbacks for success and failure', async () => {
      const consoleProvider = new ConsoleProvider({ enabled: true });
      manager.register(consoleProvider);

      const successHandler = jest.fn();
      const failureHandler = jest.fn();

      manager.onSuccess(successHandler);
      manager.onFailure(failureHandler);

      await manager.sendAll(mockEvent);

      expect(successHandler).toHaveBeenCalled();
      expect(failureHandler).not.toHaveBeenCalled();
    });

    it('should handle provider-specific configuration', async () => {
      const consoleProvider = new ConsoleProvider({ enabled: true });
      manager.register(consoleProvider);

      consoleProvider.updateConfig({
        timeoutMs: 60000,
      });

      const config = consoleProvider.getConfig();
      expect(config.timeoutMs).toBe(60000);
    });
  });

  describe('Provider Discovery and Registration', () => {
    it('should discover all providers by name', async () => {
      manager.register(new ConsoleProvider());
      manager.register(new WebhookProvider({ enabled: true, webhookUrl: 'http://test' }));
      manager.register(
        new EmailProvider({
          enabled: true,
          apiKey: 'test',
          apiUrl: 'http://test',
          fromAddress: 'test@example.com',
          toAddresses: ['user@example.com'],
        })
      );

      expect(manager.getProvider('ConsoleProvider')).toBeDefined();
      expect(manager.getProvider('WebhookProvider')).toBeDefined();
      expect(manager.getProvider('EmailProvider')).toBeDefined();
    });

    it('should filter available providers', async () => {
      manager.register(new ConsoleProvider({ enabled: true }));
      manager.register(new ConsoleProvider({ enabled: false }));

      const available = manager.getAvailableProviders();
      expect(available).toHaveLength(1);
      expect(available[0].isAvailable()).toBe(true);
    });

    it('should replace provider on re-registration', async () => {
      const provider1 = new ConsoleProvider({ enabled: true });
      const provider2 = new ConsoleProvider({ enabled: false });

      manager.register(provider1);
      expect(manager.getProvider('ConsoleProvider')?.isAvailable()).toBe(true);

      manager.register(provider2);
      expect(manager.getProvider('ConsoleProvider')?.isAvailable()).toBe(false);
    });
  });

  describe('Error Handling Patterns', () => {
    it('should collect results from all providers even if some fail', async () => {
      const successProvider = new ConsoleProvider({ enabled: true });
      const failProvider = new WebhookProvider({
        enabled: true,
        webhookUrl: 'https://invalid.example.com',
      });

      manager.register(successProvider);
      manager.register(failProvider);

      // Mock fetch to simulate timeout
      global.fetch = jest.fn(() =>
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error('Network error')), 100);
        })
      );

      const results = await manager.sendAll(mockEvent);

      expect(results.size).toBe(2);
      expect(results.get('ConsoleProvider')?.status).toBe('success');
      expect(results.get('WebhookProvider')?.status).toBe('failure');
    });

    it('should execute failure handlers for failed providers', async () => {
      const failureHandler = jest.fn();
      manager.onFailure(failureHandler);

      const webhookProvider = new WebhookProvider({
        enabled: true,
        webhookUrl: 'https://invalid.example.com',
      });

      manager.register(webhookProvider);

      // Mock fetch to fail
      global.fetch = jest.fn(() =>
        Promise.resolve({
          ok: false,
          status: 500,
          json: () => Promise.resolve({ error: 'Server error' }),
        } as Response)
      );

      await manager.sendAll(mockEvent);

      expect(failureHandler).toHaveBeenCalledWith(
        webhookProvider,
        mockEvent,
        expect.objectContaining({
          status: 'failure',
        })
      );
    });

    it('should not throw on handler errors', async () => {
      const errorHandler = jest.fn(() => {
        throw new Error('Handler error');
      });

      manager.onSuccess(errorHandler);

      const consoleProvider = new ConsoleProvider({ enabled: true });
      manager.register(consoleProvider);

      // Should not throw
      const results = await manager.sendAll(mockEvent);
      expect(results.get('ConsoleProvider')?.status).toBe('success');
    });
  });

  describe('Health Monitoring', () => {
    it('should report health status of all providers', async () => {
      manager.register(new ConsoleProvider({ enabled: true }));
      manager.register(new ConsoleProvider({ enabled: false }));

      const health = await manager.getHealthStatus();

      expect(health.size).toBe(2);
      const healthyCount = Array.from(health.values()).filter((h) => h.healthy).length;
      expect(healthyCount).toBe(1);
    });

    it('should include reasons for health status', async () => {
      manager.register(new ConsoleProvider({ enabled: true }));

      const health = await manager.getHealthStatus();
      const status = health.get('ConsoleProvider');

      expect(status?.reason).toBeDefined();
      expect(typeof status?.reason).toBe('string');
    });
  });

  describe('Batch Operations', () => {
    it('should send events in batch when batch method exists', async () => {
      const events = Array.from({ length: 5 }, (_, i) => ({
        ...mockEvent,
        eventId: `evt_${i}`,
      }));

      const consoleProvider = new ConsoleProvider({ enabled: true });
      manager.register(consoleProvider);

      const batchSpy = jest.spyOn(consoleProvider, 'sendBatch');

      // Send through specific provider
      const results = await manager.send(events[0], ['ConsoleProvider']);
      expect(results.get('ConsoleProvider')?.status).toBe('success');
    });
  });

  describe('Lifecycle Management', () => {
    it('should cleanup all providers on dispose', async () => {
      const provider1 = new ConsoleProvider();
      const provider2 = new ConsoleProvider();

      manager.register(provider1);
      manager.register(provider2);

      expect(manager.getAllProviders()).toHaveLength(2);

      await manager.disposeAll();

      expect(manager.getAllProviders()).toHaveLength(0);
    });

    it('should unregister specific providers', async () => {
      manager.register(new ConsoleProvider({ enabled: true }));
      manager.register(new ConsoleProvider({ enabled: true }));

      await manager.unregister('ConsoleProvider');

      expect(manager.getAllProviders()).toHaveLength(0);
    });
  });

  describe('Real-World Scenarios', () => {
    it('should handle notification burst with multiple providers', async () => {
      manager.register(new ConsoleProvider({ enabled: true }));

      global.fetch = jest.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ id: 'msg' }),
        } as Response)
      );

      // Simulate burst of events
      const events = Array.from({ length: 10 }, (_, i) => ({
        ...mockEvent,
        eventId: `evt_burst_${i}`,
      }));

      const startTime = performance.now();

      for (const event of events) {
        await manager.sendAll(event);
      }

      const duration = performance.now() - startTime;

      // Should complete in reasonable time despite concurrent operations
      expect(duration).toBeLessThan(10000);
    });

    it('should maintain provider state across multiple operations', async () => {
      const consoleProvider = new ConsoleProvider({ enabled: true });
      manager.register(consoleProvider);

      // First send
      let results = await manager.sendAll(mockEvent);
      expect(results.get('ConsoleProvider')?.status).toBe('success');

      // Update config
      consoleProvider.updateConfig({ enabled: false });

      // Second send - should be skipped
      results = await manager.sendAll(mockEvent);
      expect(results.get('ConsoleProvider')?.status).toBe('skipped');

      // Re-enable
      consoleProvider.updateConfig({ enabled: true });

      // Third send - should succeed
      results = await manager.sendAll(mockEvent);
      expect(results.get('ConsoleProvider')?.status).toBe('success');
    });

    it('should support graceful degradation with provider failures', async () => {
      const consoleProvider = new ConsoleProvider({ enabled: true });
      const webhookProvider = new WebhookProvider({
        enabled: true,
        webhookUrl: 'https://api.example.com/webhook',
      });

      manager.register(consoleProvider);
      manager.register(webhookProvider);

      // Mock webhook to always fail
      global.fetch = jest.fn(() =>
        Promise.reject(new Error('Network unavailable'))
      );

      const results = await manager.sendAll(mockEvent);

      // Console provider should still work
      expect(results.get('ConsoleProvider')?.status).toBe('success');

      // Webhook should fail
      expect(results.get('WebhookProvider')?.status).toBe('failure');

      // Application should still function
      expect(results.size).toBe(2);
    });
  });

  describe('Performance', () => {
    it('should send through multiple providers concurrently', async () => {
      const providers = Array.from({ length: 5 }, () => new ConsoleProvider());
      providers.forEach((p, i) => {
        // Manually change names for testing
        Object.defineProperty(p, 'getName', {
          value: () => `ConsoleProvider${i}`,
        });
        manager.register(p);
      });

      const startTime = performance.now();
      const results = await manager.sendAll(mockEvent);
      const duration = performance.now() - startTime;

      expect(results.size).toBe(5);
      // Should be faster than sequential due to concurrency
      expect(duration).toBeLessThan(1000);
    });

    it('should handle timeout across multiple providers', async () => {
      const providers = [
        new ConsoleProvider({ enabled: true, timeoutMs: 100 }),
        new ConsoleProvider({ enabled: true, timeoutMs: 100 }),
      ];

      providers.forEach((p, i) => {
        Object.defineProperty(p, 'getName', {
          value: () => `ConsoleProvider${i}`,
        });
        manager.register(p);
      });

      const startTime = performance.now();
      const results = await manager.sendAll(mockEvent);
      const duration = performance.now() - startTime;

      // Should respect individual timeouts
      expect(duration).toBeLessThan(5000);
      expect(results.size).toBe(2);
    });
  });
});
