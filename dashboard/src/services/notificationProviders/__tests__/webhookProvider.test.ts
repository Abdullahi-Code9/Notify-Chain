/**
 * Tests for WebhookProvider
 */

import { WebhookProvider } from '../webhookProvider';
import type { BlockchainEvent } from '../../../types/event';

describe('WebhookProvider', () => {
  let provider: WebhookProvider;
  let mockEvent: BlockchainEvent;

  beforeEach(() => {
    provider = new WebhookProvider({
      enabled: true,
      webhookUrl: 'https://api.example.com/webhook',
    });

    mockEvent = {
      eventId: 'evt_test_123',
      contractAddress: 'C1234567890abcdef',
      eventName: 'TestEvent',
      ledger: 100,
      type: 'test_event',
      topic: [],
      value: 'test_value',
      receivedAt: Date.now(),
    };

    global.fetch = jest.fn();
  });

  describe('Interface Implementation', () => {
    it('should implement NotificationProvider interface', () => {
      expect(typeof provider.getName).toBe('function');
      expect(typeof provider.isAvailable).toBe('function');
      expect(typeof provider.send).toBe('function');
      expect(typeof provider.sendBatch).toBe('function');
      expect(typeof provider.healthCheck).toBe('function');
    });

    it('should return correct provider name', () => {
      expect(provider.getName()).toBe('WebhookProvider');
    });
  });

  describe('Configuration', () => {
    it('should require webhookUrl', () => {
      expect(
        () =>
          new WebhookProvider({
            enabled: true,
            webhookUrl: '',
          })
      ).toThrow('webhookUrl is required');
    });

    it('should accept optional configuration', () => {
      const customProvider = new WebhookProvider({
        enabled: true,
        webhookUrl: 'https://api.example.com/webhook',
        timeout: 60000,
        maxRetries: 5,
      });

      const config = customProvider.getConfig();
      expect(config.timeout).toBe(60000);
      expect(config.maxRetries).toBe(5);
    });
  });

  describe('Sending Notifications', () => {
    it('should send event successfully', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ id: 'msg_123' }),
      });

      const result = await provider.send(mockEvent);

      expect(result.status).toBe('success');
      expect(result.metadata?.deliveryId).toBe(mockEvent.eventId);
    });

    it('should handle non-retryable client errors', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: () => Promise.resolve({ error: 'Bad request' }),
      });

      const result = await provider.send(mockEvent);

      expect(result.status).toBe('failure');
      expect(result.error?.code).toBe('HTTP_400');
    });

    it('should retry on server errors', async () => {
      (global.fetch as jest.Mock)
        .mockResolvedValueOnce({
          ok: false,
          status: 500,
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ id: 'msg_123' }),
        });

      const result = await provider.send(mockEvent);

      expect(result.status).toBe('success');
      expect(result.metadata?.retryAttempts).toBeGreaterThan(0);
      expect((global.fetch as jest.Mock).mock.calls.length).toBeGreaterThan(1);
    });

    it('should skip when provider is disabled', async () => {
      provider.updateConfig({ enabled: false });

      const result = await provider.send(mockEvent);

      expect(result.status).toBe('skipped');
      expect((global.fetch as jest.Mock)).not.toHaveBeenCalled();
    });
  });

  describe('Batch Operations', () => {
    it('should send batch of events', async () => {
      const events = Array.from({ length: 3 }, (_, i) => ({
        ...mockEvent,
        eventId: `evt_${i}`,
      }));

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ id: 'batch_123' }),
      });

      const results = await provider.sendBatch(events);

      expect(results).toHaveLength(3);
      expect(results[0].status).toBe('success');

      const call = (global.fetch as jest.Mock).mock.calls[0];
      const body = JSON.parse(call[1].body);
      expect(body.type).toBe('blockchain_events_batch');
      expect(body.count).toBe(3);
    });

    it('should batch events in chunks', async () => {
      const provider2 = new WebhookProvider({
        enabled: true,
        webhookUrl: 'https://api.example.com/webhook',
        batchSize: 5,
      });

      const events = Array.from({ length: 12 }, (_, i) => ({
        ...mockEvent,
        eventId: `evt_${i}`,
      }));

      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ id: 'batch' }),
      });

      await provider2.sendBatch(events);

      // Should be called 3 times (12 events / 5 per batch = 3 batches)
      expect((global.fetch as jest.Mock).mock.calls.length).toBe(3);
    });

    it('should handle empty batch', async () => {
      const results = await provider.sendBatch([]);
      expect(results).toHaveLength(0);
    });
  });

  describe('Health Checks', () => {
    it('should report healthy when provider is available', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        status: 200,
      });

      const health = await provider.healthCheck();

      expect(health.healthy).toBe(true);
      expect(health.reason).toContain('reachable');
    });

    it('should report unhealthy when webhook is unreachable', async () => {
      (global.fetch as jest.Mock).mockRejectedValueOnce(new Error('Network error'));

      const health = await provider.healthCheck();

      expect(health.healthy).toBe(false);
      expect(health.reason).toContain('failed');
    });
  });

  describe('Error Handling', () => {
    it('should handle network timeouts', async () => {
      (global.fetch as jest.Mock).mockImplementationOnce(() => {
        const error = new Error('The operation was aborted');
        (error as any).name = 'AbortError';
        return Promise.reject(error);
      });

      const result = await provider.send(mockEvent);

      expect(result.status).toBe('failure');
      expect(result.error?.code).toBe('WEBHOOK_TIMEOUT');
    });

    it('should include retry attempt count in metadata', async () => {
      (global.fetch as jest.Mock)
        .mockResolvedValueOnce({ ok: false, status: 500 })
        .mockResolvedValueOnce({ ok: false, status: 500 })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ id: 'msg' }),
        });

      const result = await provider.send(mockEvent);

      expect(result.metadata?.retryAttempts).toBe(2);
    });
  });

  describe('Headers and Custom Configuration', () => {
    it('should include custom headers in requests', async () => {
      const customProvider = new WebhookProvider({
        enabled: true,
        webhookUrl: 'https://api.example.com/webhook',
        headers: {
          'X-Custom-Header': 'value',
          'Authorization': 'Bearer token',
        },
      });

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ id: 'msg' }),
      });

      await customProvider.send(mockEvent);

      const call = (global.fetch as jest.Mock).mock.calls[0];
      expect(call[1].headers['X-Custom-Header']).toBe('value');
      expect(call[1].headers['Authorization']).toBe('Bearer token');
    });
  });
});
