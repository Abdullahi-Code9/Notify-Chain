/**
 * Tests for EmailProvider
 */

import { EmailProvider } from '../emailProvider';
import type { BlockchainEvent } from '../../../types/event';

describe('EmailProvider', () => {
  let provider: EmailProvider;
  let mockEvent: BlockchainEvent;

  beforeEach(() => {
    provider = new EmailProvider({
      enabled: true,
      apiKey: 'test_key_123',
      apiUrl: 'https://api.emailservice.com/send',
      fromAddress: 'notifications@example.com',
      toAddresses: ['user@example.com', 'admin@example.com'],
    });

    mockEvent = {
      eventId: 'evt_test_123',
      contractAddress: 'C1234567890abcdef',
      eventName: 'PaymentReceived',
      ledger: 100,
      type: 'payment_event',
      topic: [],
      value: 'test_value',
      receivedAt: Date.now(),
      notificationStatus: 'active',
    };

    global.fetch = jest.fn();
  });

  describe('Configuration', () => {
    it('should require apiKey and apiUrl', () => {
      expect(
        () =>
          new EmailProvider({
            enabled: true,
            apiKey: '',
            apiUrl: 'https://api.example.com',
            fromAddress: 'test@example.com',
            toAddresses: ['user@example.com'],
          })
      ).toThrow();
    });

    it('should require fromAddress and toAddresses', () => {
      expect(
        () =>
          new EmailProvider({
            enabled: true,
            apiKey: 'key',
            apiUrl: 'https://api.example.com',
            fromAddress: '',
            toAddresses: [],
          })
      ).toThrow();
    });
  });

  describe('Sending Notifications', () => {
    it('should send email successfully', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ id: 'msg_123', messageId: 'msg_123' }),
      });

      const result = await provider.send(mockEvent);

      expect(result.status).toBe('success');
      expect(result.message).toContain('Email sent');
      expect(result.metadata?.deliveryId).toBeDefined();
    });

    it('should include authorization header', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ id: 'msg' }),
      });

      await provider.send(mockEvent);

      const call = (global.fetch as jest.Mock).mock.calls[0];
      expect(call[1].headers['Authorization']).toBe('Bearer test_key_123');
    });

    it('should format email subject', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ id: 'msg' }),
      });

      await provider.send(mockEvent);

      const call = (global.fetch as jest.Mock).mock.calls[0];
      const body = JSON.parse(call[1].body);
      expect(body.subject).toContain(mockEvent.eventName);
    });

    it('should include event data in email body', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ id: 'msg' }),
      });

      await provider.send(mockEvent);

      const call = (global.fetch as jest.Mock).mock.calls[0];
      const body = JSON.parse(call[1].body);
      expect(body.html).toContain(mockEvent.contractAddress);
      expect(body.html).toContain(mockEvent.ledger.toString());
    });

    it('should handle client errors (non-retryable)', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: () => Promise.resolve({ error: 'Invalid email' }),
      });

      const result = await provider.send(mockEvent);

      expect(result.status).toBe('failure');
      expect(result.error?.code).toBe('EMAIL_400');
    });

    it('should return retry status for server errors', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: () => Promise.resolve({ error: 'Server error' }),
      });

      const result = await provider.send(mockEvent);

      expect(result.status).toBe('retry');
      expect(result.error?.code).toBe('EMAIL_SERVICE_ERROR');
    });

    it('should skip when provider is disabled', async () => {
      provider.updateConfig({ enabled: false });

      const result = await provider.send(mockEvent);

      expect(result.status).toBe('skipped');
      expect((global.fetch as jest.Mock)).not.toHaveBeenCalled();
    });
  });

  describe('Batch Operations', () => {
    it('should send batch email digest', async () => {
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
      expect(body.subject).toContain('Digest');
      expect(body.subject).toContain('3');
    });

    it('should handle empty batch', async () => {
      const results = await provider.sendBatch([]);
      expect(results).toHaveLength(0);
      expect((global.fetch as jest.Mock)).not.toHaveBeenCalled();
    });

    it('should include all events in digest', async () => {
      const events = Array.from({ length: 5 }, (_, i) => ({
        ...mockEvent,
        eventId: `evt_${i}`,
        eventName: `Event${i}`,
        ledger: 100 + i,
      }));

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ id: 'batch' }),
      });

      await provider.sendBatch(events);

      const call = (global.fetch as jest.Mock).mock.calls[0];
      const body = JSON.parse(call[1].body);

      for (let i = 0; i < 5; i++) {
        expect(body.html).toContain(`Event${i}`);
      }
    });
  });

  describe('Health Checks', () => {
    it('should check provider availability', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        status: 200,
      });

      const health = await provider.healthCheck();

      expect(health.healthy).toBe(true);
      expect(health.reason).toContain('operational');
    });

    it('should report unhealthy on connection errors', async () => {
      (global.fetch as jest.Mock).mockRejectedValueOnce(new Error('Connection refused'));

      const health = await provider.healthCheck();

      expect(health.healthy).toBe(false);
      expect(health.reason).toContain('failed');
    });

    it('should report unhealthy when disabled', async () => {
      provider.updateConfig({ enabled: false });

      const health = await provider.healthCheck();

      expect(health.healthy).toBe(false);
    });
  });

  describe('Email Formatting', () => {
    it('should include all event details in HTML email', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ id: 'msg' }),
      });

      await provider.send(mockEvent);

      const call = (global.fetch as jest.Mock).mock.calls[0];
      const body = JSON.parse(call[1].body);
      const html = body.html;

      expect(html).toContain(mockEvent.contractAddress);
      expect(html).toContain(mockEvent.eventName);
      expect(html).toContain(mockEvent.ledger.toString());
      expect(html).toContain('Status');
      expect(html).toContain(mockEvent.notificationStatus);
    });

    it('should format digest email as HTML table', async () => {
      const events = Array.from({ length: 3 }, (_, i) => ({
        ...mockEvent,
        eventId: `evt_${i}`,
        eventName: `Event${i}`,
        ledger: 100 + i,
      }));

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ id: 'batch' }),
      });

      await provider.sendBatch(events);

      const call = (global.fetch as jest.Mock).mock.calls[0];
      const body = JSON.parse(call[1].body);
      const html = body.html;

      expect(html).toContain('<table>');
      expect(html).toContain('Event');
      expect(html).toContain('Ledger');
    });

    it('should handle missing optional event fields', async () => {
      const minimalEvent: BlockchainEvent = {
        eventId: 'evt_minimal',
        contractAddress: 'C123',
        eventName: null,
        ledger: 100,
        type: 'test',
        topic: [],
        value: 'val',
        receivedAt: Date.now(),
      };

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ id: 'msg' }),
      });

      const result = await provider.send(minimalEvent);

      expect(result.status).toBe('success');

      const call = (global.fetch as jest.Mock).mock.calls[0];
      const body = JSON.parse(call[1].body);
      expect(body.subject).toContain('test');
    });
  });

  describe('Error Handling', () => {
    it('should handle request timeouts', async () => {
      (global.fetch as jest.Mock).mockImplementationOnce(() => {
        const error = new Error('The operation was aborted');
        (error as any).name = 'AbortError';
        return Promise.reject(error);
      });

      const result = await provider.send(mockEvent);

      expect(result.status).toBe('retry');
      expect(result.error?.code).toBe('EMAIL_TIMEOUT');
    });

    it('should include duration in metadata', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ id: 'msg' }),
      });

      const result = await provider.send(mockEvent);

      expect(result.metadata?.durationMs).toBeDefined();
      expect(typeof result.metadata?.durationMs).toBe('number');
    });
  });

  describe('Configuration', () => {
    it('should accept custom timeout', () => {
      const customProvider = new EmailProvider({
        enabled: true,
        apiKey: 'key',
        apiUrl: 'https://api.example.com/send',
        fromAddress: 'test@example.com',
        toAddresses: ['user@example.com'],
        timeout: 60000,
      });

      expect(customProvider.getConfig().timeout).toBe(60000);
    });

    it('should update configuration', () => {
      provider.updateConfig({ timeout: 60000 });

      expect(provider.getConfig().timeout).toBe(60000);
    });
  });
});
