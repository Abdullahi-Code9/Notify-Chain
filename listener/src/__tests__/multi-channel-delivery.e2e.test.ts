import { xdr } from '@stellar/stellar-sdk';
import * as StellarSDK from '@stellar/stellar-sdk';
import { DiscordNotificationService } from '../services/discord-notification';
import { NotificationRetryQueue } from '../services/notification-retry-queue';
import { DiscordConfig, ContractConfig } from '../types';

/**
 * End-to-end tests for notification delivery across multiple supported channels.
 *
 * These tests wire together the *real* delivery path used in production by
 * EventSubscriber.processEvent: each channel owns a real
 * DiscordNotificationService and a real NotificationRetryQueue, and the only
 * thing mocked is the outbound `fetch` (the network boundary).
 *
 * "Channel" here maps to a distinct Discord webhook destination — different
 * webhook URLs deliver to different Discord channels (e.g. #alerts, #ops,
 * #audit), which is how a single deployment fans an event out to several
 * destinations.
 */

jest.mock('../utils/logger', () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

const logger = jest.requireMock('../utils/logger').default;

/**
 * A routable fetch mock. Each registered URL gets a handler that receives the
 * (zero-based) attempt number for that URL, so a channel can be made to fail
 * the first N times and then recover — exactly what retry assertions need.
 */
type FetchHandler = (attempt: number) => Partial<Response> | Promise<Partial<Response>>;

function createFetchRouter() {
  const handlers = new Map<string, FetchHandler>();
  const callCounts = new Map<string, number>();
  const bodies = new Map<string, unknown[]>();

  const okResponse = (): Partial<Response> => ({ ok: true, status: 204, statusText: 'No Content' });

  const fetchMock = jest.fn(async (url: string, init?: RequestInit) => {
    const attempt = callCounts.get(url) ?? 0;
    callCounts.set(url, attempt + 1);

    const recorded = bodies.get(url) ?? [];
    recorded.push(JSON.parse(String(init?.body ?? '{}')));
    bodies.set(url, recorded);

    const handler = handlers.get(url);
    const response = handler ? await handler(attempt) : okResponse();
    return response as Response;
  });

  return {
    fetchMock,
    /** Register per-channel network behaviour keyed by webhook URL. */
    setHandler(url: string, handler: FetchHandler) {
      handlers.set(url, handler);
    },
    callsTo(url: string): number {
      return callCounts.get(url) ?? 0;
    },
    bodiesTo(url: string): any[] {
      return bodies.get(url) ?? [];
    },
  };
}

interface Channel {
  name: string;
  config: DiscordConfig;
  service: DiscordNotificationService;
  retryQueue: NotificationRetryQueue;
}

function failedFetch(status: number, statusText: string, body = 'error'): Partial<Response> {
  return {
    ok: false,
    status,
    statusText,
    text: () => Promise.resolve(body),
  };
}

function createMockEvent(
  overrides: Partial<StellarSDK.rpc.Api.EventResponse> = {}
): StellarSDK.rpc.Api.EventResponse {
  return {
    id: 'event-e2e-1',
    type: 'contract',
    ledger: 5000,
    ledgerClosedAt: '2026-06-18T00:00:00Z',
    transactionIndex: 1,
    operationIndex: 0,
    inSuccessfulContractCall: true,
    txHash: 'tx-e2e-abc',
    topic: [xdr.ScVal.scvSymbol('task_created')],
    value: xdr.ScVal.scvString('bounty #42 opened'),
    ...overrides,
  } as StellarSDK.rpc.Api.EventResponse;
}

const contractConfig: ContractConfig = {
  address: 'CDNJ3YJ5F4U5YF4O5U6Y7I8U9Y0U1I2O3P4I5U6Y7I8',
  events: ['task_created'],
};

describe('Multi-channel notification delivery (e2e)', () => {
  let router: ReturnType<typeof createFetchRouter>;
  let channels: Channel[];

  // Retry queue timings kept tiny so fake timers advance quickly.
  const retryOptions = { baseDelayMs: 100, maxRetries: 3, processIntervalMs: 50 };

  function buildChannel(name: string): Channel {
    const config: DiscordConfig = {
      webhookUrl: `https://discord.com/api/webhooks/${name}/token`,
      webhookId: name,
    };
    const service = new DiscordNotificationService(config);
    const retryQueue = new NotificationRetryQueue(
      (event, cc, requestId) => service.sendEventNotification(event, cc, requestId),
      retryOptions
    );
    return { name, config, service, retryQueue };
  }

  /**
   * Mirrors EventSubscriber.processEvent, fanned out across every channel:
   * attempt immediate delivery, and on failure hand the event to that
   * channel's retry queue. Returns the per-channel immediate-delivery result.
   */
  async function deliverToAllChannels(
    event: StellarSDK.rpc.Api.EventResponse,
    requestId?: string
  ): Promise<Record<string, boolean>> {
    const results: Record<string, boolean> = {};
    for (const channel of channels) {
      const delivered = await channel.service.sendEventNotification(event, contractConfig, requestId);
      results[channel.name] = delivered;
      if (!delivered) {
        logger.warn('Channel delivery failed, adding to retry queue', {
          requestId,
          channel: channel.name,
          eventId: event.id,
        });
        channel.retryQueue.enqueue(event, contractConfig, requestId);
      }
    }
    return results;
  }

  beforeEach(() => {
    jest.clearAllMocks();
    router = createFetchRouter();
    global.fetch = router.fetchMock as unknown as typeof fetch;
    channels = [buildChannel('alerts'), buildChannel('ops'), buildChannel('audit')];
  });

  afterEach(() => {
    channels.forEach((channel) => channel.retryQueue.stop());
  });

  describe('fan-out delivery', () => {
    it('delivers a single event to every configured channel', async () => {
      const results = await deliverToAllChannels(createMockEvent(), 'req-fanout');

      expect(results).toEqual({ alerts: true, ops: true, audit: true });
      for (const channel of channels) {
        expect(router.callsTo(channel.config.webhookUrl)).toBe(1);
      }
    });

    it('routes each channel its own payload at its own webhook URL', async () => {
      await deliverToAllChannels(createMockEvent({ id: 'event-routing' }));

      for (const channel of channels) {
        const [body] = router.bodiesTo(channel.config.webhookUrl);
        expect(body).toBeDefined();
        // Every channel sees the same logical event, addressed to its own URL.
        expect(body.embeds).toHaveLength(1);
        expect(body.embeds[0].title).toContain('task_created');
      }
      // No cross-talk: a channel only ever receives its own delivery.
      expect(router.fetchMock).toHaveBeenCalledTimes(channels.length);
    });
  });

  describe('channel-specific payloads', () => {
    it('builds a Discord embed payload carrying the event details', async () => {
      await deliverToAllChannels(
        createMockEvent({ type: 'contract', value: xdr.ScVal.scvString('payload-check') })
      );

      const [body] = router.bodiesTo(channels[0].config.webhookUrl);
      const embed = body.embeds[0];

      expect(embed.title).toContain('task_created');
      expect(embed.color).toBe(0x00ff00); // contract events are green
      const contractField = embed.fields.find((f: any) => f.name === 'Contract');
      const valueField = embed.fields.find((f: any) => f.name === 'Value');
      expect(contractField.value).toContain('...'); // address is abbreviated
      expect(valueField.value).toBe('payload-check');
    });

    it('reflects the event type in the payload color across channels', async () => {
      await deliverToAllChannels(
        createMockEvent({ id: 'event-system', type: 'system' })
      );

      for (const channel of channels) {
        const [body] = router.bodiesTo(channel.config.webhookUrl);
        expect(body.embeds[0].color).toBe(0x0099ff); // system events are blue
        const typeField = body.embeds[0].fields.find((f: any) => f.name === 'Type');
        expect(typeField.value).toBe('system');
      }
    });
  });

  describe('partial delivery failure', () => {
    it('delivers to healthy channels even when one channel fails', async () => {
      router.setHandler(channels[1].config.webhookUrl, () =>
        failedFetch(500, 'Internal Server Error')
      );

      const results = await deliverToAllChannels(createMockEvent({ id: 'event-partial' }), 'req-partial');

      expect(results).toEqual({ alerts: true, ops: false, audit: true });
    });

    it('logs a meaningful error identifying the failing channel', async () => {
      router.setHandler(channels[1].config.webhookUrl, () =>
        failedFetch(429, 'Too Many Requests', 'rate limited')
      );

      await deliverToAllChannels(createMockEvent({ id: 'event-logged' }), 'req-logged');

      // The service logs the underlying webhook failure with status detail...
      expect(logger.error).toHaveBeenCalledWith(
        'Discord webhook delivery failed',
        expect.objectContaining({
          webhookId: 'ops',
          httpStatus: 429,
          httpCategory: 'rate_limited',
          requestId: 'req-logged',
          eventId: 'event-logged',
        })
      );
      // ...and the fan-out records the channel being queued for retry.
      expect(logger.warn).toHaveBeenCalledWith(
        'Channel delivery failed, adding to retry queue',
        expect.objectContaining({ channel: 'ops', eventId: 'event-logged' })
      );
    });

    it('logs a meaningful error when a channel throws a network error', async () => {
      router.setHandler(channels[2].config.webhookUrl, () => {
        throw new Error('ECONNRESET');
      });

      const results = await deliverToAllChannels(createMockEvent({ id: 'event-network' }), 'req-net');

      expect(results.audit).toBe(false);
      expect(logger.error).toHaveBeenCalledWith(
        'Discord webhook request error',
        expect.objectContaining({ webhookId: 'audit', eventId: 'event-network' })
      );
    });
  });

  describe('retry behaviour', () => {
    beforeEach(() => {
      jest.useFakeTimers();
      channels.forEach((channel) => channel.retryQueue.start());
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    const flush = async () => {
      for (let i = 0; i < 5; i++) await Promise.resolve();
    };

    it('retries only the failed channel and recovers without touching healthy ones', async () => {
      // 'ops' fails its first (immediate) attempt, then succeeds on retry.
      router.setHandler(channels[1].config.webhookUrl, (attempt) =>
        attempt === 0 ? failedFetch(503, 'Service Unavailable') : { ok: true, status: 204 }
      );

      const results = await deliverToAllChannels(createMockEvent({ id: 'event-recover' }), 'req-recover');
      expect(results).toEqual({ alerts: true, ops: false, audit: true });
      expect(channels[1].retryQueue.size()).toBe(1);

      // Advance past the base delay so the retry queue re-attempts 'ops'.
      jest.advanceTimersByTime(150);
      await flush();

      expect(router.callsTo(channels[1].config.webhookUrl)).toBe(2);
      expect(channels[1].retryQueue.size()).toBe(0);
      // Healthy channels were delivered exactly once and never retried.
      expect(router.callsTo(channels[0].config.webhookUrl)).toBe(1);
      expect(router.callsTo(channels[2].config.webhookUrl)).toBe(1);

      expect(logger.info).toHaveBeenCalledWith(
        'Retry succeeded',
        expect.objectContaining({ eventId: 'event-recover', attempt: 1 })
      );
    });

    it('escalates to a permanent-failure log after exhausting retries on a channel', async () => {
      // 'audit' never recovers.
      router.setHandler(channels[2].config.webhookUrl, () => failedFetch(500, 'Internal Server Error'));

      await deliverToAllChannels(createMockEvent({ id: 'event-dead' }), 'req-dead');
      expect(channels[2].retryQueue.size()).toBe(1);

      // Drive the exponential backoff schedule: 100ms, +200ms, +400ms.
      jest.advanceTimersByTime(100);
      await flush();
      jest.advanceTimersByTime(200);
      await flush();
      jest.advanceTimersByTime(400);
      await flush();

      // 1 immediate + 3 retries (maxRetries = 3).
      expect(router.callsTo(channels[2].config.webhookUrl)).toBe(4);
      expect(channels[2].retryQueue.size()).toBe(0);

      expect(logger.error).toHaveBeenCalledWith(
        'Notification permanently failed after max retries',
        expect.objectContaining({ eventId: 'event-dead', totalAttempts: 3 })
      );
    });

    it('keeps retry queues independent per channel', async () => {
      router.setHandler(channels[0].config.webhookUrl, (attempt) =>
        attempt === 0 ? failedFetch(503, 'Service Unavailable') : { ok: true, status: 204 }
      );
      router.setHandler(channels[1].config.webhookUrl, () => failedFetch(500, 'Internal Server Error'));

      await deliverToAllChannels(createMockEvent({ id: 'event-independent' }), 'req-ind');

      expect(channels[0].retryQueue.size()).toBe(1); // alerts: will recover
      expect(channels[1].retryQueue.size()).toBe(1); // ops: keeps failing
      expect(channels[2].retryQueue.size()).toBe(0); // audit: delivered first time

      jest.advanceTimersByTime(150);
      await flush();

      // alerts recovered and drained; ops still has a pending retry scheduled.
      expect(channels[0].retryQueue.size()).toBe(0);
      expect(channels[1].retryQueue.size()).toBe(1);
    });
  });
});
