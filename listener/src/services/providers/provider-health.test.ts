import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { DiscordNotificationProvider } from './discord-provider';
import { WebhookNotificationProvider } from './webhook-provider';

const mockFetch = jest.fn() as jest.MockedFunction<typeof fetch>;
(global as any).fetch = mockFetch;

describe('Notification Provider Health Checks (#709)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('DiscordNotificationProvider.checkHealth', () => {
    it('returns not_configured when no webhook URL is present', async () => {
      const provider = new DiscordNotificationProvider({});
      const result = await provider.checkHealth();

      expect(result.status).toBe('not_configured');
      expect(result.providerId).toBe('discord');
      expect(result.detail).toContain('No Discord webhook URL configured');
    });

    it('returns ok with latency when endpoint responds successfully', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, status: 200 } as Response);

      const provider = new DiscordNotificationProvider({
        webhookUrl: 'https://discord.com/api/webhooks/123/my-secret-token',
      });
      const result = await provider.checkHealth();

      expect(result.status).toBe('ok');
      expect(typeof result.latencyMs).toBe('number');
    });

    it('reports failure without exposing webhook credentials/tokens', async () => {
      mockFetch.mockRejectedValueOnce(
        new Error(
          'Failed request to https://discord.com/api/webhooks/123456789/my-super-secret-token'
        )
      );

      const provider = new DiscordNotificationProvider({
        webhookUrl: 'https://discord.com/api/webhooks/123456789/my-super-secret-token',
      });
      const result = await provider.checkHealth();

      expect(result.status).toBe('error');
      expect(result.detail).toBeDefined();
      // Must NOT contain the secret token!
      expect(result.detail).not.toContain('my-super-secret-token');
      expect(result.detail).toContain('***');
    });
  });

  describe('WebhookNotificationProvider.checkHealth', () => {
    it('returns not_configured when no URL is provided', async () => {
      const provider = new WebhookNotificationProvider();
      const result = await provider.checkHealth();

      expect(result.status).toBe('not_configured');
      expect(result.providerId).toBe('webhook');
    });

    it('returns ok when endpoint is reachable', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, status: 200 } as Response);

      const provider = new WebhookNotificationProvider({
        healthCheckUrl: 'https://api.example.com/health',
      });
      const result = await provider.checkHealth();

      expect(result.status).toBe('ok');
      expect(typeof result.latencyMs).toBe('number');
    });

    it('redacts query credentials from error messages', async () => {
      mockFetch.mockRejectedValueOnce(
        new Error('Connection failed to https://api.example.com/webhook?token=secret12345&key=mykey')
      );

      const provider = new WebhookNotificationProvider({
        healthCheckUrl: 'https://api.example.com/webhook?token=secret12345&key=mykey',
      });
      const result = await provider.checkHealth();

      expect(result.status).toBe('error');
      expect(result.detail).not.toContain('secret12345');
      expect(result.detail).not.toContain('mykey');
      expect(result.detail).toContain('token=***');
      expect(result.detail).toContain('key=***');
    });
  });
});