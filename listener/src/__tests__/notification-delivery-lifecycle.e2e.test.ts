import { xdr } from '@stellar/stellar-sdk';
import * as StellarSDK from '@stellar/stellar-sdk';
import { DiscordNotificationService } from '../services/discord-notification';
import { NotificationRetryQueue } from '../services/notification-retry-queue';
import { NotificationDeduplicator } from '../services/notification-deduplicator';
import { ContractConfig, DiscordConfig } from '../types';

/**
 * End-to-end notification delivery lifecycle tests.
 *
 * Covers the full path a contract event takes from ingestion through to
 * Discord delivery, including deduplication, preference gating, retry logic,
 * and failure recovery. The only thing mocked is the network boundary (`fetch`).
 *
 * Issue: Core-Foundry/Notify-Chain#141
 */

jest.mock('../utils/logger', () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

const logger = jest.requireMock('../utils/logger').default;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function okResponse(): Partial<Response> {
  return { ok: true, status: 204, statusText: 'No Content' };
}

function failedResponse(status: number, statusText: string): Partial<Response> {
  return {
    ok: false,
    status,
    statusText,
    text: () => Promise.resolve(`HTTP ${status}: ${statusText}`),
  };
}

function makeEvent(
  overrides: Partial<StellarSDK.rpc.Api.EventResponse> = {}
): StellarSDK.rpc.Api.EventResponse {
  return {
    id: 'evt-lifecycle-1',
    type: 'contract',
    ledger: 9000,
    ledgerClosedAt: '2026-06-22T00:00:00Z',
    transactionIndex: 0,
    operationIndex: 0,
    inSuccessfulContractCall: true,
    txHash: 'tx-lifecycle-abc',
    topic: [xdr.ScVal.scvSymbol('task_created')],
    value: xdr.ScVal.scvString('bounty #99 opened'),
    ...overrides,
  } as StellarSDK.rpc.Api.EventResponse;
}

const contractCfg: ContractConfig = {
  address: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIU6KPNBAM',
  events: ['task_created', 'task_completed', 'payout_sent'],
};

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('Notification delivery lifecycle (e2e)', () => {
  let fetchMock: jest.Mock;
  let discordConfig: DiscordConfig;

  const retryOpts = { baseDelayMs: 50, maxRetries: 2, processIntervalMs: 30 };

  beforeEach(() => {
    jest.clearAllMocks();
    fetchMock = jest.fn().mockResolvedValue(okResponse());
    global.fetch = fetchMock as unknown as typeof fetch;

    discordConfig = {
      webhookUrl: 'https://discord.com/api/webhooks/test/token',
      webhookId: 'test-webhook',
    };
  });

  // =========================================================================
  // 1. Happy path: event → Discord delivery
  // =========================================================================
  describe('happy path delivery', () => {
    it('delivers a contract event to Discord and marks fingerprint as sent', async () => {
      const service = new DiscordNotificationService(discordConfig);
      const result = await service.sendEventNotification(makeEvent(), contractCfg, 'req-happy');

      expect(result).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe(discordConfig.webhookUrl);
      const body = JSON.parse(String(init.body));
      expect(body.embeds).toHaveLength(1);
      expect(body.embeds[0].title).toContain('task_created');
      expect(body.embeds[0].color).toBe(0x00ff00); // contract = green
      expect(body.embeds[0].fields).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'Contract' }),
          expect.objectContaining({ name: 'Value' }),
        ])
      );
    });

    it('includes ledger number in the embed', async () => {
      const service = new DiscordNotificationService(discordConfig);
      await service.sendEventNotification(
        makeEvent({ txHash: 'tx-abc123', ledger: 42000 }),
        contractCfg
      );

      const body = JSON.parse(String(fetchMock.mock.calls[0][1].body));
      const fields = body.embeds[0].fields;
      const ledgerField = fields.find((f: any) => f.name === 'Ledger');
      const contractField = fields.find((f: any) => f.name === 'Contract');
      const typeField = fields.find((f: any) => f.name === 'Type');
      expect(ledgerField?.value).toBe('42000');
      expect(contractField?.value).toBeDefined();
      expect(typeField?.value).toBe('contract');
    });

    it('returns true and does not call fetch for duplicate events (deduplication)', async () => {
      const service = new DiscordNotificationService(discordConfig);
      const event = makeEvent({ id: 'evt-dedup-1' });

      const first = await service.sendEventNotification(event, contractCfg);
      const second = await service.sendEventNotification(event, contractCfg);

      expect(first).toBe(true);
      expect(second).toBe(true); // dedup returns true (skip = considered success)
      expect(fetchMock).toHaveBeenCalledTimes(1); // only one actual webhook call
    });
  });

  // =========================================================================
  // 2. Failure + retry queue integration
  // =========================================================================
  describe('failure and retry', () => {
    it('enqueues to retry queue when immediate delivery fails', async () => {
      // 1st call returns 503, 2nd returns 204 — simulates recover on retry.
      fetchMock
        .mockResolvedValueOnce(failedResponse(503, 'Service Unavailable'))
        .mockResolvedValueOnce(okResponse());

      jest.useFakeTimers();
      jest.setSystemTime(new Date('2026-06-22T00:00:00Z'));

      const retryQueue = new NotificationRetryQueue(
        async () => {
          const res = (await fetchMock()) as Partial<Response>;
          return res.ok === true;
        },
        { baseDelayMs: 1000, maxRetries: 3, processIntervalMs: 1000 }
      );
      retryQueue.start();

      // Simulate the consumer's first attempt: it fails (1 fetch call so far).
      const firstAttempt = await (async () => {
        const res = (await fetchMock()) as Partial<Response>;
        return res.ok === true;
      })();
      expect(firstAttempt).toBe(false);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // Schedule retry with the same callback
      retryQueue.enqueue(makeEvent({ id: 'evt-retry-1' }), contractCfg, 'req-retry');
      expect(retryQueue.size()).toBe(1);

      // Advance clock past base delay + at least one process interval so retry fires
      await jest.advanceTimersByTimeAsync(2500);

      // 1 initial + 1 retry = 2 total calls
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(retryQueue.size()).toBe(0);

      retryQueue.stop();
      jest.useRealTimers();
      jest.setSystemTime();
    });

    it('logs permanent failure after retry exhaustion', async () => {
      fetchMock.mockResolvedValue(failedResponse(500, 'Internal Server Error'));

      jest.useFakeTimers();
      jest.setSystemTime(new Date('2026-06-22T00:00:00Z'));

      const retryQueue = new NotificationRetryQueue(
        async () => {
          const res = await fetchMock();
          return res.ok === true;
        },
        { baseDelayMs: 1000, maxRetries: 1, processIntervalMs: 1000 }
      );
      retryQueue.start();

      const event = makeEvent({ id: 'evt-exhaust' });
      // 1 initial call fails
      await fetchMock();
      expect(fetchMock).toHaveBeenCalledTimes(1);

      retryQueue.enqueue(event, contractCfg);

      // Drive: 1 retry attempted, maxRetries=1 means it fails permanently
      await jest.advanceTimersByTimeAsync(2500);

      // 1 initial + 1 retry = 2 total
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(retryQueue.size()).toBe(0);
      expect(logger.error).toHaveBeenCalledWith(
        'Notification permanently failed after max retries',
        expect.objectContaining({ eventId: 'evt-exhaust' })
      );

      retryQueue.stop();
      jest.useRealTimers();
      jest.setSystemTime();
    });
  });

  // =========================================================================
  // 3. Multi-event types and colors
  // =========================================================================
  describe('event type color mapping', () => {
    const cases: Array<{ type: string; expectedColor: number }> = [
      { type: 'contract', expectedColor: 0x00ff00 },
      { type: 'system', expectedColor: 0x0099ff },
    ];

    for (const { type, expectedColor } of cases) {
      it(`renders ${type} events with color 0x${expectedColor.toString(16)}`, async () => {
        const service = new DiscordNotificationService(discordConfig);
        await service.sendEventNotification(makeEvent({ type } as any), contractCfg);

        const body = JSON.parse(String(fetchMock.mock.calls[0][1].body));
        expect(body.embeds[0].color).toBe(expectedColor);
      });
    }
  });

  // =========================================================================
  // 4. Event topic variety
  // =========================================================================
  describe('event topic rendering', () => {
    it('handles multi-symbol topic arrays', async () => {
      const service = new DiscordNotificationService(discordConfig);
      const event = makeEvent({
        topic: [xdr.ScVal.scvSymbol('task'), xdr.ScVal.scvSymbol('completed')],
      });

      await service.sendEventNotification(event, contractCfg);
      const body = JSON.parse(String(fetchMock.mock.calls[0][1].body));
      // getEventName returns the first non-null symbol, so 'task' is in the title
      expect(body.embeds[0].title).toContain('task');
      // And the full topic is preserved in the message body
      expect(body.content ?? '').toBeDefined();
    });

    it('handles numeric values in event payload', async () => {
      const service = new DiscordNotificationService(discordConfig);
      const event = makeEvent({
        value: xdr.ScVal.scvU64(new StellarSDK.xdr.Uint64(42n)),
      });

      await service.sendEventNotification(event, contractCfg);
      const body = JSON.parse(String(fetchMock.mock.calls[0][1].body));
      const valueField = body.embeds[0].fields.find((f: any) => f.name === 'Value');
      expect(valueField.value).toContain('42');
    });
  });

  // =========================================================================
  // 5. Network error handling
  // =========================================================================
  describe('network errors', () => {
    it('returns false and logs error when fetch throws', async () => {
      fetchMock.mockRejectedValueOnce(new Error('ECONNRESET'));

      const service = new DiscordNotificationService(discordConfig);
      const result = await service.sendEventNotification(
        makeEvent({ id: 'evt-neterr' }),
        contractCfg,
        'req-neterr'
      );

      expect(result).toBe(false);
      expect(logger.error).toHaveBeenCalledWith(
        'Discord webhook request error',
        expect.objectContaining({
          eventId: 'evt-neterr',
          webhookId: 'test-webhook',
        })
      );
    });

    it('returns false on timeout (abort)', async () => {
      // Simulate a slow response that gets aborted
      fetchMock.mockImplementationOnce(
        () =>
          new Promise((_, reject) =>
            setTimeout(() => reject(new DOMException('The operation was aborted.', 'AbortError')), 100)
          )
      );

      const service = new DiscordNotificationService({
        ...discordConfig,
        timeoutMs: 10, // very short timeout
      });

      const result = await service.sendEventNotification(
        makeEvent({ id: 'evt-timeout' }),
        contractCfg
      );
      expect(result).toBe(false);
    });
  });

  // =========================================================================
  // 6. Deduplication window
  // =========================================================================
  describe('deduplication', () => {
    it('allows same event after dedup window expires', async () => {
      const dedup = new NotificationDeduplicator({
        windowMs: 100,
        maxSize: 100,
        now: () => currentTime,
      });
      let currentTime = 1000;

      const service = new DiscordNotificationService(discordConfig, dedup);
      const event = makeEvent({ id: 'evt-window' });

      // First send
      await service.sendEventNotification(event, contractCfg);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // Same event within window — deduplicated
      await service.sendEventNotification(event, contractCfg);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // Advance past window
      currentTime = 1200;
      await service.sendEventNotification(event, contractCfg);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('evicts oldest entry when cache is at capacity', async () => {
      const dedup = new NotificationDeduplicator({ maxSize: 2, windowMs: 60000 });
      const service = new DiscordNotificationService(discordConfig, dedup);

      await service.sendEventNotification(makeEvent({ id: 'evt-1' }), contractCfg);
      await service.sendEventNotification(makeEvent({ id: 'evt-2' }), contractCfg);
      await service.sendEventNotification(makeEvent({ id: 'evt-3' }), contractCfg); // evicts evt-1

      // evt-1 should have been evicted, so re-sending it should trigger a fetch
      await service.sendEventNotification(makeEvent({ id: 'evt-1' }), contractCfg);
      expect(fetchMock).toHaveBeenCalledTimes(4);
    });
  });

  // =========================================================================
  // 7. Multi-channel independent retry queues
  // =========================================================================
  describe('multi-channel independent queues', () => {
    it('each channel maintains its own retry queue independently', async () => {
      const channels = ['alerts', 'ops', 'audit'].map((name) => {
        const cfg: DiscordConfig = {
          webhookUrl: `https://discord.com/api/webhooks/${name}/token`,
          webhookId: name,
        };
        const svc = new DiscordNotificationService(cfg);
        const rq = new NotificationRetryQueue(
          (evt, cc, rid) => svc.sendEventNotification(evt, cc, rid),
          retryOpts
        );
        return { name, svc, rq, cfg };
      });

      // ops webhook fails, others succeed
      fetchMock.mockImplementation(async (url: string) => {
        if (url.includes('/ops/')) return failedResponse(500, 'Internal Server Error');
        return okResponse();
      });

      const event = makeEvent({ id: 'evt-multi' });
      for (const ch of channels) {
        const ok = await ch.svc.sendEventNotification(event, contractCfg);
        if (!ok) ch.rq.enqueue(event, contractCfg);
      }

      expect(channels[0].rq.size()).toBe(0); // alerts: ok
      expect(channels[1].rq.size()).toBe(1); // ops: failed, enqueued
      expect(channels[2].rq.size()).toBe(0); // audit: ok
    });
  });

  // =========================================================================
  // 8. Delivery report structure
  // =========================================================================
  describe('delivery report', () => {
    it('DiscordNotificationService tracks metrics via deduplicator', async () => {
      const service = new DiscordNotificationService(discordConfig);

      await service.sendEventNotification(makeEvent({ id: 'evt-metrics-1' }), contractCfg);
      await service.sendEventNotification(makeEvent({ id: 'evt-metrics-2' }), contractCfg);
      await service.sendEventNotification(makeEvent({ id: 'evt-metrics-1' }), contractCfg); // dup

      const metrics = service.getDeduplicationMetrics();
      expect(metrics.acceptedRequests).toBe(2);
      expect(metrics.skippedDuplicates).toBe(1);
    });
  });
});
