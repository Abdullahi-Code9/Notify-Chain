import { xdr } from '@stellar/stellar-sdk';
import * as StellarSDK from '@stellar/stellar-sdk';
import { EventSubscriber } from './event-subscriber';
import { Config, ContractConfig } from '../types';
import logger from '../utils/logger';

const mockGetEvents = jest.fn();

jest.mock('@stellar/stellar-sdk', () => {
  const actual = jest.requireActual('@stellar/stellar-sdk');
  return {
    ...actual,
    rpc: {
      Server: jest.fn().mockImplementation(() => ({
        getEvents: mockGetEvents,
      })),
    },
  };
});

jest.mock('../utils/logger', () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
  },
}));

const mockDiscordService = {
  sendEventNotification: jest.fn().mockResolvedValue(true),
};

jest.mock('./discord-notification', () => ({
  DiscordNotificationService: jest.fn().mockImplementation(() => mockDiscordService),
}));

jest.mock('../store/preference-store', () => ({
  preferenceStore: {
    isCategoryEnabled: jest.fn().mockReturnValue(true),
  },
}));

const mockLogger = logger as jest.Mocked<typeof logger>;

const contractConfig: ContractConfig = {
  address: 'CCEMX6Q5V5F5F5F5F5F5F5F5F5F5F5F5F5F5F5F5F5F5F5F5F5F5F5',
  events: ['*'],
};

const testConfig: Config = {
  stellarNetwork: 'testnet',
  stellarNetworkPassphrase: 'Test SDF Network ; September 2015',
  stellarRpcUrl: 'https://soroban-testnet.stellar.org:443',
  contractAddresses: [contractConfig],
  pollIntervalMs: 30000,
  eventBatchSize: 100,
  maxReconnectAttempts: 5,
  reconnectDelayMs: 100,
  eventsApiPort: 8787,
  eventsApiCorsOrigin: 'http://localhost:5173',
};

function createMockEvent(
  overrides: Partial<StellarSDK.rpc.Api.EventResponse> = {}
): StellarSDK.rpc.Api.EventResponse {
  return {
    id: 'event-1',
    type: 'contract',
    ledger: 12345,
    ledgerClosedAt: '2026-01-01T00:00:00Z',
    transactionIndex: 0,
    operationIndex: 0,
    inSuccessfulContractCall: true,
    txHash: 'abc123def456',
    topic: [xdr.ScVal.scvSymbol('TaskCreated')],
    value: xdr.ScVal.scvU32(1),
    ...overrides,
  };
}

function countLogCalls(level: 'info' | 'warn' | 'error', message: string): number {
  const mock = mockLogger[level] as jest.Mock;
  return mock.mock.calls.filter((call: unknown[]) => call[0] === message).length;
}

describe('EventSubscriber', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetEvents.mockResolvedValue({ events: [], cursor: '' });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('lifecycle', () => {
    it('should create an instance', () => {
      const subscriber = new EventSubscriber(testConfig);
      expect(subscriber).toBeDefined();
    });

    it('should start and stop without errors', async () => {
      jest.useFakeTimers();

      const subscriber = new EventSubscriber(testConfig);
      await subscriber.start();
      await jest.advanceTimersByTimeAsync(0);
      await subscriber.stop();
    });

    it('does not start a second poll loop when start is called twice', async () => {
      jest.useFakeTimers();
      mockGetEvents.mockResolvedValue({ events: [], cursor: '' });

      const subscriber = new EventSubscriber(testConfig);
      await subscriber.start();
      await subscriber.start();

      await Promise.resolve();
      await Promise.resolve();

      expect(mockGetEvents).toHaveBeenCalledTimes(1);
      expect(mockLogger.warn).toHaveBeenCalledWith('Event subscriber already running');

      await subscriber.stop();
    });
  });

  describe('successful event processing', () => {
    it('processes and logs events returned from RPC', async () => {
      const event = createMockEvent({ id: 'event-abc', ledger: 99999 });
      mockGetEvents.mockResolvedValue({
        events: [event],
        cursor: 'cursor-1',
      });

      const subscriber = new EventSubscriber(testConfig);
      await (subscriber as any).checkForEvents();

      expect(mockGetEvents).toHaveBeenCalledTimes(1);
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Received events',
        expect.objectContaining({
          contractAddress: contractConfig.address,
          count: 1,
          processed: 1,
        })
      );
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Processing event',
        expect.objectContaining({
          contractAddress: contractConfig.address,
          eventName: 'TaskCreated',
          ledger: 99999,
          type: 'contract',
        })
      );
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Event processing complete',
        expect.objectContaining({
          eventId: 'event-abc',
          outcome: 'success',
          durationMs: expect.any(Number),
        })
      );
    });

    it('processes each valid event in a batch', async () => {
      mockGetEvents.mockResolvedValue({
        events: [
          createMockEvent({ id: 'event-1' }),
          createMockEvent({ id: 'event-2' }),
          createMockEvent({ id: 'event-3' }),
        ],
        cursor: 'cursor-batch',
      });

      const subscriber = new EventSubscriber(testConfig);
      await (subscriber as any).checkForEvents();

      expect(countLogCalls('info', 'Processing event')).toBe(3);
    });

    it('continues processing valid events after a malformed event', async () => {
      const malformedEvent = createMockEvent({
        id: 'event-malformed',
        topic: [undefined as unknown as xdr.ScVal],
      });
      mockGetEvents.mockResolvedValue({
        events: [malformedEvent, createMockEvent({ id: 'event-valid' })],
        cursor: 'cursor-mixed',
      });

      const subscriber = new EventSubscriber(testConfig);
      await expect((subscriber as any).checkForEvents()).resolves.toBeUndefined();

      expect(countLogCalls('info', 'Processing event')).toBe(1);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Skipping malformed event',
        expect.objectContaining({
          contractAddress: contractConfig.address,
          eventId: 'event-malformed',
          eventIndex: 0,
        })
      );
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Processing event',
        expect.objectContaining({ eventId: 'event-valid' })
      );
    });

    it('continues processing after an individual event-processing failure', async () => {
      mockGetEvents.mockResolvedValue({
        events: [
          createMockEvent({ id: 'event-fails' }),
          createMockEvent({ id: 'event-after-failure' }),
        ],
        cursor: 'cursor-processing-failure',
      });

      const subscriber = new EventSubscriber(testConfig);
      const processEvent = jest
        .spyOn(subscriber as any, 'processEvent')
        .mockRejectedValueOnce(new Error('unexpected event shape'))
        .mockResolvedValueOnce(true);

      await expect((subscriber as any).checkForEvents()).resolves.toBeUndefined();

      expect(processEvent).toHaveBeenCalledTimes(2);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Event processing failed; continuing batch',
        expect.objectContaining({
          eventId: 'event-fails',
          error: 'unexpected event shape',
        })
      );
      expect(processEvent).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ id: 'event-after-failure' }),
        contractConfig,
        expect.any(String)
      );
    });

    it('does not log received events when RPC returns an empty list', async () => {
      mockGetEvents.mockResolvedValue({ events: [], cursor: 'cursor-empty' });

      const subscriber = new EventSubscriber(testConfig);
      await (subscriber as any).checkForEvents();

      expect(countLogCalls('info', 'Received events')).toBe(0);
    });

    it('uses startLedger on the first fetch and cursor on subsequent fetches', async () => {
      mockGetEvents
        .mockResolvedValueOnce({
          events: [createMockEvent()],
          cursor: 'cursor-next',
        })
        .mockResolvedValueOnce({ events: [], cursor: 'cursor-next' });

      const subscriber = new EventSubscriber(testConfig);
      await (subscriber as any).checkForEvents();
      await (subscriber as any).checkForEvents();

      expect(mockGetEvents.mock.calls[0][0]).toMatchObject({ startLedger: 1 });
      expect(mockGetEvents.mock.calls[1][0]).toMatchObject({ cursor: 'cursor-next' });
    });

    it('uses the configured event batch size for RPC requests', async () => {
      const configuredBatchSize = 25;
      const subscriber = new EventSubscriber({
        ...testConfig,
        eventBatchSize: configuredBatchSize,
      });

      await (subscriber as any).checkForEvents();

      expect(mockGetEvents.mock.calls[0][0]).toMatchObject({
        limit: configuredBatchSize,
      });
    });

    it('tracks cursors independently per contract', async () => {
      const secondContract: ContractConfig = {
        address: 'CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
        events: ['*'],
      };
      const multiContractConfig: Config = {
        ...testConfig,
        contractAddresses: [contractConfig, secondContract],
      };

      mockGetEvents
        .mockResolvedValueOnce({
          events: [createMockEvent({ id: 'contract-a' })],
          cursor: 'cursor-a',
        })
        .mockResolvedValueOnce({
          events: [createMockEvent({ id: 'contract-b' })],
          cursor: 'cursor-b',
        });

      const subscriber = new EventSubscriber(multiContractConfig);
      await (subscriber as any).checkForEvents();
      await (subscriber as any).checkForEvents();

      expect(mockGetEvents.mock.calls[2][0]).toMatchObject({ cursor: 'cursor-a' });
      expect(mockGetEvents.mock.calls[3][0]).toMatchObject({ cursor: 'cursor-b' });
    });

    it('fetches events for every configured contract', async () => {
      const secondContract: ContractConfig = {
        address: 'CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
        events: ['TaskCreated'],
      };
      const multiContractConfig: Config = {
        ...testConfig,
        contractAddresses: [contractConfig, secondContract],
      };

      mockGetEvents.mockResolvedValue({ events: [], cursor: '' });

      const subscriber = new EventSubscriber(multiContractConfig);
      await (subscriber as any).checkForEvents();

      expect(mockGetEvents).toHaveBeenCalledTimes(2);
      expect(mockGetEvents.mock.calls[0][0].filters[0].contractIds).toEqual([
        contractConfig.address,
      ]);
      expect(mockGetEvents.mock.calls[1][0].filters[0].contractIds).toEqual([
        secondContract.address,
      ]);
    });

    it('filters events using contract-specific event names', async () => {
      const filteredConfig: Config = {
        ...testConfig,
        contractAddresses: [
          {
            ...contractConfig,
            events: ['TaskCreated'],
          },
        ],
      };

      mockGetEvents.mockResolvedValue({
        events: [
          createMockEvent({
            id: 'matched',
            topic: [xdr.ScVal.scvSymbol('TaskCreated')],
          }),
          createMockEvent({
            id: 'skipped',
            topic: [xdr.ScVal.scvSymbol('WorkSubmitted')],
          }),
        ],
        cursor: 'cursor-filtered',
      });

      const subscriber = new EventSubscriber(filteredConfig);
      await (subscriber as any).checkForEvents();

      expect(countLogCalls('info', 'Processing event')).toBe(1);
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Processing event',
        expect.objectContaining({ eventName: 'TaskCreated' })
      );
    });
  });

  describe('invalid event payloads', () => {
    it('skips events with an empty topic when specific filters are configured', async () => {
      const filteredConfig: Config = {
        ...testConfig,
        contractAddresses: [
          {
            ...contractConfig,
            events: ['TaskCreated'],
          },
        ],
      };

      mockGetEvents.mockResolvedValue({
        events: [createMockEvent({ id: 'empty-topic', topic: [] })],
        cursor: 'cursor-empty-topic',
      });

      const subscriber = new EventSubscriber(filteredConfig);
      await (subscriber as any).checkForEvents();

      expect(countLogCalls('info', 'Processing event')).toBe(0);
    });

    it('warns and skips events missing required fields', async () => {
      const invalidEvent = {
        id: 'invalid',
        type: 'contract',
      } as StellarSDK.rpc.Api.EventResponse;

      mockGetEvents.mockResolvedValue({
        events: [invalidEvent],
        cursor: 'cursor-invalid',
      });

      const subscriber = new EventSubscriber(testConfig);
      await (subscriber as any).checkForEvents();

      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Skipping invalid event payload',
        expect.objectContaining({
          contractAddress: contractConfig.address,
          eventId: 'invalid',
        })
      );
      expect(countLogCalls('info', 'Processing event')).toBe(0);
    });

    it('warns and skips events with undefined value field', async () => {
      const invalidEvent = createMockEvent({ id: 'missing-value' });
      (invalidEvent as any).value = undefined;

      mockGetEvents.mockResolvedValue({
        events: [invalidEvent],
        cursor: 'cursor-missing-value',
      });

      const subscriber = new EventSubscriber(testConfig);
      await (subscriber as any).checkForEvents();

      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Skipping invalid event payload',
        expect.objectContaining({
          eventId: 'missing-value',
          reason: 'Missing event value',
        })
      );
      expect(countLogCalls('info', 'Processing event')).toBe(0);
    });

    it('processes valid events and skips invalid ones in the same batch', async () => {
      mockGetEvents.mockResolvedValue({
        events: [
          createMockEvent({ id: 'valid' }),
          { id: 'invalid', type: 'contract' } as StellarSDK.rpc.Api.EventResponse,
        ],
        cursor: 'cursor-mixed',
      });

      const subscriber = new EventSubscriber(testConfig);
      await (subscriber as any).checkForEvents();

      expect(countLogCalls('info', 'Processing event')).toBe(1);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Skipping invalid event payload',
        expect.objectContaining({ eventId: 'invalid' })
      );
    });
  });

  describe('error scenarios', () => {
    it('logs an error when RPC fetch fails for a contract', async () => {
      const rpcError = new Error('RPC unavailable');
      mockGetEvents.mockRejectedValue(rpcError);

      const subscriber = new EventSubscriber(testConfig);
      await expect((subscriber as any).checkForEvents()).rejects.toThrow(
        'Failed to fetch events for all 1 configured contract(s)'
      );

      expect(mockLogger.error).toHaveBeenCalledWith(
        'Error fetching events for contract',
        expect.objectContaining({
          contractAddress: contractConfig.address,
          error: rpcError,
        })
      );
    });

    it('continues fetching events for remaining contracts after a failure', async () => {
      const secondContract: ContractConfig = {
        address: 'CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
        events: ['*'],
      };
      const multiContractConfig: Config = {
        ...testConfig,
        contractAddresses: [contractConfig, secondContract],
      };

      mockGetEvents
        .mockRejectedValueOnce(new Error('first contract failed'))
        .mockResolvedValueOnce({
          events: [createMockEvent({ id: 'recovered' })],
          cursor: 'cursor-ok',
        });

      const subscriber = new EventSubscriber(multiContractConfig);
      await (subscriber as any).checkForEvents();

      expect(mockGetEvents).toHaveBeenCalledTimes(2);
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Error fetching events for contract',
        expect.objectContaining({ contractAddress: contractConfig.address })
      );
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Received events',
        expect.objectContaining({ contractAddress: secondContract.address })
      );
    });

    it('triggers poll-level reconnection when every contract fetch fails', async () => {
      jest.useFakeTimers();
      mockGetEvents.mockRejectedValue(new Error('RPC down'));

      const subscriber = new EventSubscriber({
        ...testConfig,
        pollIntervalMs: 5000,
        reconnectDelayMs: 100,
      });

      await subscriber.start();
      await jest.advanceTimersByTimeAsync(0);

      expect(mockLogger.error).toHaveBeenCalledWith(
        'Error polling for events',
        expect.any(Object)
      );
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Attempting to reconnect',
        expect.objectContaining({ attempt: 1 })
      );

      await subscriber.stop();
    });

    it('stops the service after exceeding max reconnection attempts', async () => {
      const subscriber = new EventSubscriber({
        ...testConfig,
        maxReconnectAttempts: 3,
      });
      (subscriber as any).reconnectAttempts = 3;

      const stopSpy = jest.spyOn(subscriber, 'stop');
      await (subscriber as any).handleReconnection();

      expect(mockLogger.error).toHaveBeenCalledWith(
        'Max reconnection attempts exceeded, stopping service'
      );
      expect(stopSpy).toHaveBeenCalled();
    });

    it('applies incremental backoff delay between reconnection attempts', async () => {
      jest.useFakeTimers();

      const subscriber = new EventSubscriber({
        ...testConfig,
        reconnectDelayMs: 200,
      });
      (subscriber as any).reconnectAttempts = 1;

      const reconnectPromise = (subscriber as any).handleReconnection();

      expect(mockLogger.warn).toHaveBeenCalledWith('Attempting to reconnect', {
        attempt: 2,
        delayMs: 400,
      });

      await jest.advanceTimersByTimeAsync(400);
      await reconnectPromise;

      expect((subscriber as any).reconnectAttempts).toBe(2);
    });

    it('resets reconnection counter after a successful poll cycle', async () => {
      jest.useFakeTimers();
      mockGetEvents.mockResolvedValue({ events: [], cursor: '' });

      const subscriber = new EventSubscriber({
        ...testConfig,
        pollIntervalMs: 1000,
      });
      (subscriber as any).reconnectAttempts = 2;

      await subscriber.start();
      await jest.advanceTimersByTimeAsync(0);
      await subscriber.stop();

      expect((subscriber as any).reconnectAttempts).toBe(0);
    });
  });

  describe('Discord integration', () => {
    it('sends Discord notification when event is processed', async () => {
      mockDiscordService.sendEventNotification.mockResolvedValueOnce(true);
      
      const discordConfig = {
        webhookUrl: 'https://discord.com/api/webhooks/test/webhook',
        webhookId: 'test',
      };
      const configWithDiscord: Config = {
        ...testConfig,
        discord: discordConfig,
      };

      mockGetEvents.mockResolvedValue({
        events: [createMockEvent({ id: 'event-1' })],
        cursor: 'cursor-1',
      });

      const subscriber = new EventSubscriber(configWithDiscord);
      await (subscriber as any).checkForEvents();

      expect(mockDiscordService.sendEventNotification).toHaveBeenCalledWith(
        expect.any(Object),
        expect.any(Object),
        expect.any(String)
      );
      const correlationId = mockDiscordService.sendEventNotification.mock.calls[0][2];
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Processing event',
        expect.objectContaining({ correlationId })
      );
    });

    it('logs warning when Discord notification fails', async () => {
      const { DiscordNotificationService } = jest.requireMock('./discord-notification');
      const mockSendEventNotification = jest.fn().mockResolvedValue(false);
      DiscordNotificationService.mockImplementation(() => ({
        sendEventNotification: mockSendEventNotification,
      }));

      const discordConfig = {
        webhookUrl: 'https://discord.com/api/webhooks/test/webhook',
        webhookId: 'test',
      };
      const configWithDiscord: Config = {
        ...testConfig,
        discord: discordConfig,
      };

      mockGetEvents.mockResolvedValue({
        events: [createMockEvent({ id: 'event-1' })],
        cursor: 'cursor-1',
      });

      const subscriber = new EventSubscriber(configWithDiscord);
      await (subscriber as any).checkForEvents();

      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Discord notification failed, adding to retry queue',
        expect.objectContaining({ eventId: 'event-1' })
      );
      const failureLog = (mockLogger.warn as jest.Mock).mock.calls.find(
        (call: unknown[]) => call[0] === 'Discord notification failed, adding to retry queue'
      );
      expect(failureLog?.[1]).toEqual(expect.objectContaining({ correlationId: expect.any(String) }));
    });
  });

  describe('notification preferences gate', () => {
    const discordConfig = {
      webhookUrl: 'https://discord.com/api/webhooks/test/webhook',
      webhookId: 'test',
    };
    const configWithDiscord: Config = { ...testConfig, discord: discordConfig };

    beforeEach(() => {
      const { DiscordNotificationService } = jest.requireMock('./discord-notification');
      DiscordNotificationService.mockImplementation(() => mockDiscordService);
      mockDiscordService.sendEventNotification.mockResolvedValue(true);
      mockGetEvents.mockResolvedValue({
        events: [createMockEvent({ id: 'pref-event' })],
        cursor: 'cursor-pref',
      });
    });

    it('skips Discord notification when discord category is disabled for the user', async () => {
      const { preferenceStore } = jest.requireMock('../store/preference-store');
      preferenceStore.isCategoryEnabled.mockReturnValue(false);

      const subscriber = new EventSubscriber(configWithDiscord);
      await (subscriber as any).checkForEvents();

      expect(mockDiscordService.sendEventNotification).not.toHaveBeenCalled();
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Skipping Discord notification: category disabled by user preferences',
        expect.objectContaining({ eventId: 'pref-event' })
      );
    });

    it('sends Discord notification when discord category is enabled', async () => {
      const { preferenceStore } = jest.requireMock('../store/preference-store');
      preferenceStore.isCategoryEnabled.mockReturnValue(true);
      mockDiscordService.sendEventNotification.mockResolvedValue(true);

      const subscriber = new EventSubscriber(configWithDiscord);
      await (subscriber as any).checkForEvents();

      expect(mockDiscordService.sendEventNotification).toHaveBeenCalled();
    });

    it('uses contractConfig.userId when present', async () => {
      const { preferenceStore } = jest.requireMock('../store/preference-store');
      preferenceStore.isCategoryEnabled.mockReturnValue(true);
      mockDiscordService.sendEventNotification.mockResolvedValue(true);

      const configWithUserId: Config = {
        ...configWithDiscord,
        contractAddresses: [{ ...contractConfig, userId: 'alice' }],
      };

      const subscriber = new EventSubscriber(configWithUserId);
      await (subscriber as any).checkForEvents();

      expect(preferenceStore.isCategoryEnabled).toHaveBeenCalledWith('alice', 'discord');
    });

    it('defaults to "global" userId when contractConfig.userId is absent', async () => {
      const { preferenceStore } = jest.requireMock('../store/preference-store');
      preferenceStore.isCategoryEnabled.mockReturnValue(true);
      mockDiscordService.sendEventNotification.mockResolvedValue(true);

      const subscriber = new EventSubscriber(configWithDiscord);
      await (subscriber as any).checkForEvents();

      expect(preferenceStore.isCategoryEnabled).toHaveBeenCalledWith('global', 'discord');
    });
  });

  describe('notification expiration (Task 3: Requirements 2.1, 2.2, 2.3)', () => {
    const DEFAULT_EXPIRATION_MS = 24 * 60 * 60 * 1000; // 24 hours
    const NOW = Date.now();

    it('skips expired events when expiration service is configured', async () => {
      const expiredTime = NOW - (DEFAULT_EXPIRATION_MS + 1000); // 1 second past expiration
      const expiredEvent = createMockEvent({
        id: 'expired-event',
        receivedAt: expiredTime,
      });

      mockGetEvents.mockResolvedValue({
        events: [expiredEvent],
        cursor: 'cursor-expired',
      });

      const configWithExpiration: Config = {
        ...testConfig,
        expiration: {
          defaultExpirationMs: DEFAULT_EXPIRATION_MS,
          enabled: true,
        },
      };

      const subscriber = new EventSubscriber(configWithExpiration);
      await (subscriber as any).checkForEvents();

      // Event should be skipped due to expiration
      expect(countLogCalls('info', 'Processing event')).toBe(0);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Skipping expired notification',
        expect.objectContaining({
          eventId: 'expired-event',
          reason: 'expired',
        })
      );
    });

    it('processes valid (non-expired) events when expiration service is configured', async () => {
      const recentEvent = createMockEvent({
        id: 'recent-event',
        receivedAt: NOW,
      });

      mockGetEvents.mockResolvedValue({
        events: [recentEvent],
        cursor: 'cursor-recent',
      });

      const configWithExpiration: Config = {
        ...testConfig,
        expiration: {
          defaultExpirationMs: DEFAULT_EXPIRATION_MS,
          enabled: true,
        },
      };

      const subscriber = new EventSubscriber(configWithExpiration);
      await (subscriber as any).checkForEvents();

      // Event should be processed
      expect(countLogCalls('info', 'Processing event')).toBe(1);
    });

    it('logs expiration with timestamp details', async () => {
      const expiredTime = NOW - (DEFAULT_EXPIRATION_MS + 1000);
      const expiredEvent = createMockEvent({
        id: 'expired-details',
        receivedAt: expiredTime,
      });

      mockGetEvents.mockResolvedValue({
        events: [expiredEvent],
        cursor: 'cursor-expired-details',
      });

      const configWithExpiration: Config = {
        ...testConfig,
        expiration: {
          defaultExpirationMs: DEFAULT_EXPIRATION_MS,
          enabled: true,
        },
      };

      const subscriber = new EventSubscriber(configWithExpiration);
      await (subscriber as any).checkForEvents();

      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Skipping expired notification',
        expect.objectContaining({
          contractAddress: contractConfig.address,
          eventId: 'expired-details',
          eventName: 'TaskCreated',
          receivedAt: expiredTime,
          currentTime: expect.any(Number),
          reason: 'expired',
        })
      );
    });

    it('processes events when expiration is disabled', async () => {
      const veryOldTime = NOW - (365 * 24 * 60 * 60 * 1000); // 1 year ago
      const oldEvent = createMockEvent({
        id: 'very-old-event',
        receivedAt: veryOldTime,
      });

      mockGetEvents.mockResolvedValue({
        events: [oldEvent],
        cursor: 'cursor-old',
      });

      const configWithDisabledExpiration: Config = {
        ...testConfig,
        expiration: {
          defaultExpirationMs: DEFAULT_EXPIRATION_MS,
          enabled: false,
        },
      };

      const subscriber = new EventSubscriber(configWithDisabledExpiration);
      await (subscriber as any).checkForEvents();

      // Event should be processed even though it's very old
      expect(countLogCalls('info', 'Processing event')).toBe(1);
    });

    it('processes all events when no expiration config is provided', async () => {
      const oldEvent = createMockEvent({
        id: 'no-expiration-config',
        receivedAt: NOW - (365 * 24 * 60 * 60 * 1000),
      });

      mockGetEvents.mockResolvedValue({
        events: [oldEvent],
        cursor: 'cursor-no-expiration',
      });

      // Config without expiration settings
      const configWithoutExpiration: Config = {
        ...testConfig,
      };

      const subscriber = new EventSubscriber(configWithoutExpiration);
      await (subscriber as any).checkForEvents();

      // Event should be processed - no expiration service initialized
      expect(countLogCalls('info', 'Processing event')).toBe(1);
    });

    it('handles mixed batch with both expired and valid events', async () => {
      const expiredEvent = createMockEvent({
        id: 'expired-in-batch',
        receivedAt: NOW - (DEFAULT_EXPIRATION_MS + 1000),
      });
      const validEvent = createMockEvent({
        id: 'valid-in-batch',
        receivedAt: NOW,
      });

      mockGetEvents.mockResolvedValue({
        events: [expiredEvent, validEvent],
        cursor: 'cursor-mixed-batch',
      });

      const configWithExpiration: Config = {
        ...testConfig,
        expiration: {
          defaultExpirationMs: DEFAULT_EXPIRATION_MS,
          enabled: true,
        },
      };

      const subscriber = new EventSubscriber(configWithExpiration);
      await (subscriber as any).checkForEvents();

      // Only the valid event should be processed
      expect(countLogCalls('info', 'Processing event')).toBe(1);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Skipping expired notification',
        expect.objectContaining({
          eventId: 'expired-in-batch',
          reason: 'expired',
        })
      );
    });

    it('respects per-event-type expiration settings', async () => {
      const fastEventExpiredTime = NOW - (5 * 60 * 1000 + 1000); // 5 minutes + 1 second
      const slowEventExpiredTime = NOW - (7 * 24 * 60 * 60 * 1000 + 1000); // 7 days + 1 second

      const fastEvent = createMockEvent({
        id: 'fast-expired',
        receivedAt: fastEventExpiredTime,
      });
      const slowEvent = createMockEvent({
        id: 'slow-not-expired',
        receivedAt: NOW - 60 * 60 * 1000, // 1 hour ago (within default 24h)
        topic: [xdr.ScVal.scvSymbol('OtherEvent')],
      });

      // First call returns fast event, second returns slow event
      mockGetEvents
        .mockResolvedValueOnce({
          events: [fastEvent],
          cursor: 'cursor-fast',
        })
        .mockResolvedValueOnce({
          events: [slowEvent],
          cursor: 'cursor-slow',
        });

      const configWithPerTypeExpiration: Config = {
        ...testConfig,
        expiration: {
          defaultExpirationMs: DEFAULT_EXPIRATION_MS,
          perEventTypeExpiration: {
            TaskCreated: 5 * 60 * 1000, // 5 minutes for TaskCreated
          },
          enabled: true,
        },
      };

      const subscriber = new EventSubscriber(configWithPerTypeExpiration);
      
      // First check - fast event should be expired
      await (subscriber as any).checkForEvents();
      expect(countLogCalls('info', 'Processing event')).toBe(0);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Skipping expired notification',
        expect.objectContaining({
          eventId: 'fast-expired',
          reason: 'expired',
        })
      );

      // Reset mock counters without clearing mockGetEvents implementation
      mockLogger.info.mockClear();
      mockLogger.warn.mockClear();

      // Second check - slow event should NOT be expired (uses default 24h)
      await (subscriber as any).checkForEvents();
      expect(countLogCalls('info', 'Processing event')).toBe(1);
    });

    it('initializes expirationService only when config.expiration is provided', () => {
      const configWithExpiration: Config = {
        ...testConfig,
        expiration: {
          defaultExpirationMs: DEFAULT_EXPIRATION_MS,
          enabled: true,
        },
      };
      const subscriber1 = new EventSubscriber(configWithExpiration);
      expect((subscriber1 as any).expirationService).toBeDefined();
      expect((subscriber1 as any).expirationService).not.toBeNull();

      const configWithoutExpiration: Config = { ...testConfig };
      const subscriber2 = new EventSubscriber(configWithoutExpiration);
      expect((subscriber2 as any).expirationService).toBeNull();
    });
  });
});
