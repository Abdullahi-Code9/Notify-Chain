/**
 * Refactored Discord Notification Tests
 * 
 * Uses NotificationFixtureBuilder to eliminate duplicate event creation
 * and provide deterministic test data for Discord webhook tests.
 */

import { DiscordNotificationService } from './discord-notification';
import { NotificationDeduplicator } from './notification-deduplicator';
import { NotificationFixtureBuilder } from '../test-utils/notification-fixture-builder';

const mockFetch = jest.fn();
global.fetch = mockFetch;

jest.mock('../utils/logger', () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
  },
}));

describe('DiscordNotificationService (Refactored)', () => {
  const mockConfig = {
    webhookUrl: NotificationFixtureBuilder.constants.webhookUrl,
    webhookId: '123',
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('sendEventNotification', () => {
    it('should send event notification successfully', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true });

      const service = new DiscordNotificationService(mockConfig);
      
      // ✅ Using fixture builder - no more manual event creation
      const mockEvent = NotificationFixtureBuilder
        .aStellarEvent()
        .withTopicSymbol('autoshare_created')
        .build();

      const mockContractConfig = NotificationFixtureBuilder
        .aContractConfig()
        .withSingleEvent('autoshare_created')
        .build();

      const result = await service.sendEventNotification(mockEvent, mockContractConfig);

      expect(result).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      
      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toBe(mockConfig.webhookUrl);
      expect(options.method).toBe('POST');
      expect(options.headers).toEqual({ 'Content-Type': 'application/json' });
      
      const body = JSON.parse(options.body);
      expect(body.embeds).toHaveLength(1);
      expect(body.embeds[0].title).toContain('autoshare_created');
    });

    it('should handle webhook failure', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        text: () => Promise.resolve('Invalid payload'),
      });

      const service = new DiscordNotificationService(mockConfig);
      
      // ✅ Simple, deterministic event
      const mockEvent = NotificationFixtureBuilder
        .aStellarEvent()
        .build();

      const mockContractConfig = NotificationFixtureBuilder
        .aContractConfig()
        .build();

      const result = await service.sendEventNotification(mockEvent, mockContractConfig);
      expect(result).toBe(false);
    });

    it('should handle network error', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      const service = new DiscordNotificationService(mockConfig);
      
      const mockEvent = NotificationFixtureBuilder
        .aStellarEvent()
        .build();

      const mockContractConfig = NotificationFixtureBuilder
        .aContractConfig()
        .build();

      const result = await service.sendEventNotification(mockEvent, mockContractConfig);
      expect(result).toBe(false);
    });
  });

  describe('duplicate detection', () => {
    it('skips the webhook call for a duplicate event', async () => {
      mockFetch.mockResolvedValue({ ok: true });

      const service = new DiscordNotificationService(mockConfig);
      
      // ✅ Deterministic event ID
      const mockEvent = NotificationFixtureBuilder
        .aStellarEvent()
        .withId('event-dup')
        .build();

      const mockContractConfig = NotificationFixtureBuilder
        .aContractConfig()
        .build();

      await service.sendEventNotification(mockEvent, mockContractConfig);
      const secondResult = await service.sendEventNotification(mockEvent, mockContractConfig);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(secondResult).toBe(true);
    });

    it('logs a duplicate detection event', async () => {
      mockFetch.mockResolvedValue({ ok: true });

      const mockLoggerModule = jest.requireMock('../utils/logger').default;
      const service = new DiscordNotificationService(mockConfig);
      
      const mockEvent = NotificationFixtureBuilder
        .aStellarEvent()
        .withId('event-dup-log')
        .build();

      const mockContractConfig = NotificationFixtureBuilder
        .aContractConfig()
        .build();

      await service.sendEventNotification(mockEvent, mockContractConfig);
      await service.sendEventNotification(mockEvent, mockContractConfig);

      expect(mockLoggerModule.info).toHaveBeenCalledWith(
        'Skipping duplicate notification',
        expect.objectContaining({
          eventId: 'event-dup-log',
          contractAddress: mockContractConfig.address,
        })
      );
    });

    it('allows the same event id on a different contract through', async () => {
      mockFetch.mockResolvedValue({ ok: true });

      const service = new DiscordNotificationService(mockConfig);
      
      // ✅ Single event, multiple contracts - cleaner
      const mockEvent = NotificationFixtureBuilder
        .aStellarEvent()
        .withId('event-shared-id')
        .build();

      const contractA = NotificationFixtureBuilder
        .aContractConfig()
        .withAddress('CONTRACT-A')
        .build();

      const contractB = NotificationFixtureBuilder
        .aContractConfig()
        .withAddress('CONTRACT-B')
        .build();

      await service.sendEventNotification(mockEvent, contractA);
      const result = await service.sendEventNotification(mockEvent, contractB);

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(result).toBe(true);
    });

    it('does not mark an event as sent when the webhook call fails', async () => {
      mockFetch
        .mockResolvedValueOnce({ 
          ok: false, 
          status: 500, 
          statusText: 'Error', 
          text: () => Promise.resolve('') 
        })
        .mockResolvedValueOnce({ ok: true });

      const service = new DiscordNotificationService(mockConfig);
      
      const mockEvent = NotificationFixtureBuilder
        .aStellarEvent()
        .withId('event-retry')
        .build();

      const mockContractConfig = NotificationFixtureBuilder
        .aContractConfig()
        .build();

      const firstResult = await service.sendEventNotification(mockEvent, mockContractConfig);
      const secondResult = await service.sendEventNotification(mockEvent, mockContractConfig);

      expect(firstResult).toBe(false);
      expect(secondResult).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('accepts an injected deduplicator', async () => {
      mockFetch.mockResolvedValue({ ok: true });

      const deduplicator = new NotificationDeduplicator();
      const service = new DiscordNotificationService(mockConfig, deduplicator);
      
      const mockEvent = NotificationFixtureBuilder
        .aStellarEvent()
        .withId('event-injected')
        .build();

      const mockContractConfig = NotificationFixtureBuilder
        .aContractConfig()
        .build();

      await service.sendEventNotification(mockEvent, mockContractConfig);

      expect(deduplicator.size()).toBe(1);
      expect(deduplicator.isDuplicate(
        `${mockContractConfig.address}:event-injected`
      )).toBe(true);
    });
  });

  describe('sendTestMessage', () => {
    it('should send test message successfully', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true });

      const service = new DiscordNotificationService(mockConfig);
      const result = await service.sendTestMessage();

      expect(result).toBe(true);
    });

    it('should handle test message failure', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      const service = new DiscordNotificationService(mockConfig);
      const result = await service.sendTestMessage();

      expect(result).toBe(false);
    });
  });

  describe('formatEventMessage', () => {
    it('should format event with string value correctly', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true });

      const service = new DiscordNotificationService(mockConfig);
      
      // ✅ Easy to specify string value
      const mockEvent = NotificationFixtureBuilder
        .aStellarEvent()
        .withStringValue('Hello World')
        .build();

      const mockContractConfig = NotificationFixtureBuilder
        .aContractConfig()
        .build();

      const result = await service.sendEventNotification(mockEvent, mockContractConfig);
      expect(result).toBe(true);
      
      const [, options] = mockFetch.mock.calls[0];
      const body = JSON.parse(options.body);
      const valueField = body.embeds[0].fields.find((f: any) => f.name === 'Value');
      expect(valueField.value).toBe('Hello World');
    });

    it('should truncate long string values', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true });

      const service = new DiscordNotificationService(mockConfig);
      
      const longValue = 'a'.repeat(1100);
      const mockEvent = NotificationFixtureBuilder
        .aStellarEvent()
        .withStringValue(longValue)
        .build();

      const mockContractConfig = NotificationFixtureBuilder
        .aContractConfig()
        .build();

      const result = await service.sendEventNotification(mockEvent, mockContractConfig);
      expect(result).toBe(true);
      
      const [, options] = mockFetch.mock.calls[0];
      const body = JSON.parse(options.body);
      const valueField = body.embeds[0].fields.find((f: any) => f.name === 'Value');
      expect(valueField.value.length).toBeLessThan(1100);
      expect(valueField.value).toContain('...');
    });

    it('should handle symbol type values', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true });

      const service = new DiscordNotificationService(mockConfig);
      
      const mockEvent = NotificationFixtureBuilder
        .aStellarEvent()
        .withSymbolValue('my_symbol')
        .build();

      const mockContractConfig = NotificationFixtureBuilder
        .aContractConfig()
        .build();

      const result = await service.sendEventNotification(mockEvent, mockContractConfig);
      expect(result).toBe(true);
      
      const [, options] = mockFetch.mock.calls[0];
      const body = JSON.parse(options.body);
      const valueField = body.embeds[0].fields.find((f: any) => f.name === 'Value');
      expect(valueField.value).toContain('my_symbol');
    });

    it('should preserve short messages without truncation', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true });

      const service = new DiscordNotificationService(mockConfig);
      
      const mockEvent = NotificationFixtureBuilder
        .aStellarEvent()
        .withStringValue('short')
        .build();

      const mockContractConfig = NotificationFixtureBuilder
        .aContractConfig()
        .build();

      const result = await service.sendEventNotification(mockEvent, mockContractConfig);
      expect(result).toBe(true);
      
      const [, options] = mockFetch.mock.calls[0];
      const body = JSON.parse(options.body);
      const valueField = body.embeds[0].fields.find((f: any) => f.name === 'Value');
      expect(valueField.value).toBe('short');
    });

    it('should truncate oversized embed titles', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true });

      const service = new DiscordNotificationService(mockConfig);
      
      const longTopic = 'a'.repeat(300);
      const mockEvent = NotificationFixtureBuilder
        .aStellarEvent()
        .withTopicSymbol(longTopic)
        .withStringValue('test')
        .build();

      const mockContractConfig = NotificationFixtureBuilder
        .aContractConfig()
        .build();

      const result = await service.sendEventNotification(mockEvent, mockContractConfig);
      expect(result).toBe(true);
      
      const [, options] = mockFetch.mock.calls[0];
      const body = JSON.parse(options.body);
      expect(body.embeds[0].title.length).toBeLessThanOrEqual(256);
      expect(body.embeds[0].title).toContain('...');
    });

    it('should enforce total embed size limit', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true });

      const service = new DiscordNotificationService(mockConfig);
      
      const longTopic = 'a'.repeat(300);
      const hugeValue = 'b'.repeat(6000);
      const mockEvent = NotificationFixtureBuilder
        .aStellarEvent()
        .withTopicSymbol(longTopic)
        .withStringValue(hugeValue)
        .build();

      const mockContractConfig = NotificationFixtureBuilder
        .aContractConfig()
        .build();

      const result = await service.sendEventNotification(mockEvent, mockContractConfig);
      expect(result).toBe(true);
      
      const [, options] = mockFetch.mock.calls[0];
      const body = JSON.parse(options.body);
      const embed = body.embeds[0];
      expect(service.getEmbedLength(embed)).toBeLessThanOrEqual(6000);
    });

    it('should handle exact field value length boundary', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true });

      const service = new DiscordNotificationService(mockConfig);
      
      const exactValue = 'a'.repeat(1024);
      const mockEvent = NotificationFixtureBuilder
        .aStellarEvent()
        .withStringValue(exactValue)
        .build();

      const mockContractConfig = NotificationFixtureBuilder
        .aContractConfig()
        .build();

      const result = await service.sendEventNotification(mockEvent, mockContractConfig);
      expect(result).toBe(true);
      
      const [, options] = mockFetch.mock.calls[0];
      const body = JSON.parse(options.body);
      const valueField = body.embeds[0].fields.find((f: any) => f.name === 'Value');
      expect(valueField.value).toBe(exactValue);
    });
  });
});
