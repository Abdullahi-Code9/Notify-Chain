/**
 * Tests for ProviderManager
 *
 * Verifies provider registration, discovery, concurrent sending,
 * consistent error handling, and callback execution.
 */

import { ProviderManager } from '../manager';
import { ConsoleProvider } from '../consoleProvider';
import type {
  NotificationProvider,
  ProviderSendResult,
  ProviderConfig,
} from '../types';
import type { BlockchainEvent } from '../../../types/event';

// Mock provider for testing
class MockProvider implements NotificationProvider {
  private name: string;
  private config: ProviderConfig;
  private shouldFail: boolean = false;
  private delay: number = 0;

  constructor(
    name: string,
    config: Partial<ProviderConfig> = {},
    shouldFail: boolean = false,
    delay: number = 0
  ) {
    this.name = name;
    this.config = { enabled: true, ...config };
    this.shouldFail = shouldFail;
    this.delay = delay;
  }

  getName(): string {
    return this.name;
  }

  isAvailable(): boolean {
    return this.config.enabled;
  }

  getConfig(): ProviderConfig {
    return { ...this.config };
  }

  updateConfig(config: Partial<ProviderConfig>): void {
    this.config = { ...this.config, ...config };
  }

  async send(event: BlockchainEvent): Promise<ProviderSendResult> {
    if (this.delay > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.delay));
    }

    if (this.shouldFail) {
      return {
        status: 'failure',
        message: `${this.name} failed intentionally`,
        error: {
          code: 'TEST_FAILURE',
          message: 'Intentional failure',
        },
      };
    }

    return {
      status: 'success',
      message: `${this.name} sent successfully`,
      metadata: {
        deliveryId: event.eventId,
      },
    };
  }

  async healthCheck(): Promise<{ healthy: boolean; reason?: string }> {
    return {
      healthy: this.isAvailable(),
      reason: this.isAvailable() ? 'Healthy' : 'Disabled',
    };
  }
}

describe('ProviderManager', () => {
  let manager: ProviderManager;
  let mockEvent: BlockchainEvent;

  beforeEach(() => {
    manager = new ProviderManager();
    mockEvent = {
      eventId: 'evt_test_123',
      contractAddress: 'C1234567890abcdef',
      eventName: 'TestEvent',
      ledger: 100,
      type: 'test_event',
      topic: ['topic1'],
      value: 'test_value',
      receivedAt: Date.now(),
    };
  });

  describe('Provider Registration', () => {
    it('should register a provider', () => {
      const provider = new MockProvider('TestProvider');
      manager.register(provider);

      expect(manager.getProvider('TestProvider')).toBe(provider);
    });

    it('should get all registered providers', () => {
      const provider1 = new MockProvider('Provider1');
      const provider2 = new MockProvider('Provider2');

      manager.register(provider1);
      manager.register(provider2);

      const all = manager.getAllProviders();
      expect(all).toHaveLength(2);
      expect(all).toContain(provider1);
      expect(all).toContain(provider2);
    });

    it('should get only available providers', () => {
      const available = new MockProvider('Available', { enabled: true });
      const disabled = new MockProvider('Disabled', { enabled: false });

      manager.register(available);
      manager.register(disabled);

      const availableProviders = manager.getAvailableProviders();
      expect(availableProviders).toHaveLength(1);
      expect(availableProviders[0].getName()).toBe('Available');
    });

    it('should replace existing provider with same name', () => {
      const provider1 = new MockProvider('Duplicate');
      const provider2 = new MockProvider('Duplicate');

      manager.register(provider1);
      manager.register(provider2);

      expect(manager.getAllProviders()).toHaveLength(1);
      expect(manager.getProvider('Duplicate')).toBe(provider2);
    });
  });

  describe('Provider Unregistration', () => {
    it('should unregister a provider', async () => {
      const provider = new MockProvider('ToRemove');
      manager.register(provider);

      expect(manager.getProvider('ToRemove')).toBeDefined();

      await manager.unregister('ToRemove');

      expect(manager.getProvider('ToRemove')).toBeUndefined();
    });

    it('should call dispose on provider when unregistering', async () => {
      const provider = new MockProvider('WithDispose');
      const disposeSpy = jest.spyOn(provider, 'dispose');
      (provider as any).dispose = disposeSpy;

      manager.register(provider);
      await manager.unregister('WithDispose');

      expect(disposeSpy).toHaveBeenCalled();
    });
  });

  describe('Sending Notifications', () => {
    it('should send through all available providers', async () => {
      const provider1 = new MockProvider('Provider1');
      const provider2 = new MockProvider('Provider2');

      manager.register(provider1);
      manager.register(provider2);

      const results = await manager.sendAll(mockEvent);

      expect(results.size).toBe(2);
      expect(results.get('Provider1')?.status).toBe('success');
      expect(results.get('Provider2')?.status).toBe('success');
    });

    it('should skip disabled providers', async () => {
      const enabled = new MockProvider('Enabled', { enabled: true });
      const disabled = new MockProvider('Disabled', { enabled: false });

      manager.register(enabled);
      manager.register(disabled);

      const results = await manager.sendAll(mockEvent);

      expect(results.size).toBe(1);
      expect(results.get('Enabled')).toBeDefined();
      expect(results.get('Disabled')).toBeUndefined();
    });

    it('should send through specific providers only', async () => {
      const provider1 = new MockProvider('Provider1');
      const provider2 = new MockProvider('Provider2');
      const provider3 = new MockProvider('Provider3');

      manager.register(provider1);
      manager.register(provider2);
      manager.register(provider3);

      const results = await manager.send(mockEvent, ['Provider1', 'Provider3']);

      expect(results.size).toBe(2);
      expect(results.get('Provider1')).toBeDefined();
      expect(results.get('Provider2')).toBeUndefined();
      expect(results.get('Provider3')).toBeDefined();
    });

    it('should handle provider failures gracefully', async () => {
      const success = new MockProvider('Success');
      const failure = new MockProvider('Failure', {}, true);

      manager.register(success);
      manager.register(failure);

      const results = await manager.sendAll(mockEvent);

      expect(results.get('Success')?.status).toBe('success');
      expect(results.get('Failure')?.status).toBe('failure');
    });

    it('should enforce provider timeouts', async () => {
      const slowProvider = new MockProvider('Slow', { timeoutMs: 100 }, false, 500);

      manager.register(slowProvider);

      const results = await manager.sendAll(mockEvent);
      const result = results.get('Slow');

      expect(result?.status).toBe('failure');
      expect(result?.error?.code).toBe('TIMEOUT');
    });

    it('should return concurrent results', async () => {
      const providers = Array.from({ length: 5 }, (_, i) =>
        new MockProvider(`Provider${i}`, {}, false, 50)
      );

      providers.forEach((p) => manager.register(p));

      const startTime = performance.now();
      const results = await manager.sendAll(mockEvent);
      const duration = performance.now() - startTime;

      expect(results.size).toBe(5);
      // Should be faster than sequential (250ms) due to concurrency
      expect(duration).toBeLessThan(250);
    });
  });

  describe('Error Handling', () => {
    it('should call failure handlers on failure', async () => {
      const failureHandler = jest.fn();
      manager.onFailure(failureHandler);

      const failingProvider = new MockProvider('Failing', {}, true);
      manager.register(failingProvider);

      await manager.sendAll(mockEvent);

      expect(failureHandler).toHaveBeenCalledWith(
        failingProvider,
        mockEvent,
        expect.objectContaining({
          status: 'failure',
        })
      );
    });

    it('should call success handlers on success', async () => {
      const successHandler = jest.fn();
      manager.onSuccess(successHandler);

      const successProvider = new MockProvider('Success');
      manager.register(successProvider);

      await manager.sendAll(mockEvent);

      expect(successHandler).toHaveBeenCalledWith(
        successProvider,
        mockEvent,
        expect.objectContaining({
          status: 'success',
        })
      );
    });

    it('should handle handler errors gracefully', async () => {
      const errorHandler = jest.fn(() => {
        throw new Error('Handler error');
      });

      manager.onFailure(errorHandler);

      const failingProvider = new MockProvider('Failing', {}, true);
      manager.register(failingProvider);

      // Should not throw
      const results = await manager.sendAll(mockEvent);
      expect(results.get('Failing')?.status).toBe('failure');
    });

    it('should handle unexpected provider errors', async () => {
      const errorProvider: NotificationProvider = {
        getName: () => 'ErrorProvider',
        isAvailable: () => true,
        getConfig: () => ({ enabled: true }),
        updateConfig: () => {},
        send: () => {
          throw new Error('Unexpected provider error');
        },
      };

      manager.register(errorProvider);

      const results = await manager.sendAll(mockEvent);
      const result = results.get('ErrorProvider');

      expect(result?.status).toBe('failure');
      expect(result?.error?.code).toBe('UNEXPECTED_ERROR');
    });
  });

  describe('Health Checks', () => {
    it('should get health status of all providers', async () => {
      const provider1 = new MockProvider('Provider1');
      const provider2 = new MockProvider('Provider2', { enabled: false });

      manager.register(provider1);
      manager.register(provider2);

      const health = await manager.getHealthStatus();

      expect(health.size).toBe(2);
      expect(health.get('Provider1')?.healthy).toBe(true);
      expect(health.get('Provider2')?.healthy).toBe(false);
    });

    it('should provide reasons for health status', async () => {
      const provider = new MockProvider('HealthyProvider');
      manager.register(provider);

      const health = await manager.getHealthStatus();
      const status = health.get('HealthyProvider');

      expect(status?.reason).toBeDefined();
    });

    it('should handle health check errors', async () => {
      const errorProvider: NotificationProvider = {
        getName: () => 'HealthErrorProvider',
        isAvailable: () => true,
        getConfig: () => ({ enabled: true }),
        updateConfig: () => {},
        send: () => Promise.resolve({ status: 'success', message: 'ok' }),
        healthCheck: () => {
          throw new Error('Health check failed');
        },
      };

      manager.register(errorProvider);

      const health = await manager.getHealthStatus();
      const status = health.get('HealthErrorProvider');

      expect(status?.healthy).toBe(false);
      expect(status?.reason).toContain('Health check failed');
    });
  });

  describe('Cleanup', () => {
    it('should dispose all providers', async () => {
      const provider1 = new MockProvider('Provider1');
      const provider2 = new MockProvider('Provider2');

      manager.register(provider1);
      manager.register(provider2);

      await manager.disposeAll();

      expect(manager.getAllProviders()).toHaveLength(0);
    });

    it('should handle cleanup errors gracefully', async () => {
      const errorProvider: NotificationProvider = {
        getName: () => 'DisposalError',
        isAvailable: () => true,
        getConfig: () => ({ enabled: true }),
        updateConfig: () => {},
        send: () => Promise.resolve({ status: 'success', message: 'ok' }),
        dispose: () => {
          throw new Error('Disposal error');
        },
      };

      manager.register(errorProvider);

      // Should not throw
      await manager.disposeAll();
      expect(manager.getAllProviders()).toHaveLength(0);
    });
  });

  describe('Configuration Management', () => {
    it('should update provider configuration', () => {
      const provider = new MockProvider('ConfigTest');
      manager.register(provider);

      manager.getProvider('ConfigTest')?.updateConfig({
        timeoutMs: 60000,
      });

      const config = provider.getConfig();
      expect(config.timeoutMs).toBe(60000);
    });

    it('should reflect configuration changes in send operations', async () => {
      const provider = new MockProvider('SlowProvider', { timeoutMs: 100 }, false, 50);
      manager.register(provider);

      // First send should succeed (delay < timeout)
      let results = await manager.sendAll(mockEvent);
      expect(results.get('SlowProvider')?.status).toBe('success');

      // Update timeout to be very short
      provider.updateConfig({ timeoutMs: 10 });

      // Now should timeout
      results = await manager.sendAll(mockEvent);
      expect(results.get('SlowProvider')?.status).toBe('failure');
    });
  });
});
