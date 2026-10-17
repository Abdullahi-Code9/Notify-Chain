import { xdr } from '@stellar/stellar-sdk';
import * as StellarSDK from '@stellar/stellar-sdk';
import { NotificationRetryQueue, NotificationFn } from './notification-retry-queue';
import {
  NotificationAnalyticsAggregator,
  setNotificationAnalyticsAggregator,
} from './notification-analytics-aggregator';

jest.mock('../utils/logger', () => ({
  __esModule: true,
  default: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

function createMockEvent(
  overrides: Partial<StellarSDK.rpc.Api.EventResponse> = {}
): StellarSDK.rpc.Api.EventResponse {
  return {
    id: 'event-123',
    type: 'contract',
    ledger: 1000,
    ledgerClosedAt: '2026-01-01T00:00:00Z',
    transactionIndex: 1,
    operationIndex: 0,
    inSuccessfulContractCall: true,
    txHash: 'abc123',
    topic: [xdr.ScVal.scvSymbol('test_event')],
    value: xdr.ScVal.scvString('test value'),
    ...overrides,
  };
}

const mockContractConfig = { address: 'CA123', events: ['test_event'] };

describe('NotificationRetryQueue', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('enqueue', () => {
    it('adds an item to the queue', () => {
      const notificationFn: NotificationFn = jest.fn();
      const queue = new NotificationRetryQueue(notificationFn, { baseDelayMs: 1000 });

      queue.enqueue(createMockEvent(), mockContractConfig);

      expect(queue.size()).toBe(1);
    });

    it('logs when an item is queued', () => {
      const logger = jest.requireMock('../utils/logger').default;
      const notificationFn: NotificationFn = jest.fn();
      const queue = new NotificationRetryQueue(notificationFn, { baseDelayMs: 1000 });

      queue.enqueue(createMockEvent({ id: 'evt-q' }), mockContractConfig, 'req-1');

      expect(logger.info).toHaveBeenCalledWith(
        'Notification queued for retry',
        expect.objectContaining({ eventId: 'evt-q', requestId: 'req-1' })
      );
    });

    it('skips duplicate retry queue entries for the same event', () => {
      const logger = jest.requireMock('../utils/logger').default;
      const notificationFn: NotificationFn = jest.fn();
      const queue = new NotificationRetryQueue(notificationFn, { baseDelayMs: 1000 });
      const event = createMockEvent({ id: 'evt-dup' });

      queue.enqueue(event, mockContractConfig, 'req-1');
      queue.enqueue(event, mockContractConfig, 'req-2');

      expect(queue.size()).toBe(1);
      expect(logger.info).toHaveBeenCalledWith(
        'Skipping duplicate retry queue entry',
        expect.objectContaining({
          eventId: 'evt-dup',
          contractAddress: mockContractConfig.address,
        })
      );
    });
  });

  describe('processQueue', () => {
    it('retries a notification after the base delay', async () => {
      const notificationFn: NotificationFn = jest.fn().mockResolvedValue(true);
      const queue = new NotificationRetryQueue(notificationFn, {
        baseDelayMs: 1000,
        processIntervalMs: 100,
      });
      queue.start();

      queue.enqueue(createMockEvent(), mockContractConfig);

      // Before delay expires — should not have retried yet
      jest.advanceTimersByTime(500);
      await Promise.resolve();
      expect(notificationFn).not.toHaveBeenCalled();

      // After delay expires — should retry
      jest.advanceTimersByTime(600);
      await Promise.resolve();
      await Promise.resolve();
      expect(notificationFn).toHaveBeenCalledTimes(1);

      queue.stop();
    });

    it('removes the item from the queue on success', async () => {
      const notificationFn: NotificationFn = jest.fn().mockResolvedValue(true);
      const queue = new NotificationRetryQueue(notificationFn, {
        baseDelayMs: 100,
        processIntervalMs: 50,
      });
      queue.start();

      queue.enqueue(createMockEvent(), mockContractConfig);

      jest.advanceTimersByTime(200);
      await Promise.resolve();
      await Promise.resolve();

      expect(queue.size()).toBe(0);
      queue.stop();
    });

    it('logs success on a successful retry', async () => {
      const logger = jest.requireMock('../utils/logger').default;
      const notificationFn: NotificationFn = jest.fn().mockResolvedValue(true);
      const queue = new NotificationRetryQueue(notificationFn, {
        baseDelayMs: 100,
        processIntervalMs: 50,
      });
      queue.start();

      queue.enqueue(createMockEvent({ id: 'evt-ok' }), mockContractConfig, 'req-ok');
      jest.advanceTimersByTime(200);
      await Promise.resolve();
      await Promise.resolve();

      expect(logger.info).toHaveBeenCalledWith(
        'Retry succeeded',
        expect.objectContaining({ eventId: 'evt-ok', attempt: 1 })
      );
      queue.stop();
    });
  });

  describe('exponential backoff', () => {
    it('doubles the delay on each successive failure', async () => {
      const notificationFn: NotificationFn = jest.fn().mockResolvedValue(false);
      const queue = new NotificationRetryQueue(notificationFn, {
        baseDelayMs: 1000,
        maxRetries: 5,
        processIntervalMs: 100,
      });
      queue.start();

      queue.enqueue(createMockEvent(), mockContractConfig);

      // Trigger attempt 1 (after 1000 ms base delay)
      jest.advanceTimersByTime(1100);
      await Promise.resolve();
      await Promise.resolve();
      expect(notificationFn).toHaveBeenCalledTimes(1);

      // Trigger attempt 2 (after 2000 ms from attempt 1)
      jest.advanceTimersByTime(2100);
      await Promise.resolve();
      await Promise.resolve();
      expect(notificationFn).toHaveBeenCalledTimes(2);

      queue.stop();
    });

    it('logs a warning with the next retry delay on failure', async () => {
      const logger = jest.requireMock('../utils/logger').default;
      const notificationFn: NotificationFn = jest.fn().mockResolvedValue(false);
      const queue = new NotificationRetryQueue(notificationFn, {
        baseDelayMs: 1000,
        maxRetries: 3,
        processIntervalMs: 100,
        jitter: false,
      });
      queue.start();

      queue.enqueue(createMockEvent({ id: 'evt-backoff' }), mockContractConfig);

      jest.advanceTimersByTime(1100);
      await Promise.resolve();
      await Promise.resolve();

      expect(logger.warn).toHaveBeenCalledWith(
        'Retry failed, scheduling next attempt',
        expect.objectContaining({ eventId: 'evt-backoff', attempt: 1, delayMs: 2000 })
      );
      queue.stop();
    });
  });

  describe('max retries', () => {
    it('stops retrying after maxRetries attempts', async () => {
      const notificationFn: NotificationFn = jest.fn().mockResolvedValue(false);
      const maxRetries = 3;
      const queue = new NotificationRetryQueue(notificationFn, {
        baseDelayMs: 100,
        maxRetries,
        processIntervalMs: 50,
      });
      queue.start();
      queue.enqueue(createMockEvent(), mockContractConfig);

      const flush = async () => {
        for (let i = 0; i < 5; i++) await Promise.resolve();
      };

      // attempt 1 fires at t=100ms (base delay)
      jest.advanceTimersByTime(100);
      await flush();
      expect(notificationFn).toHaveBeenCalledTimes(1);

      // attempt 2 fires at t=300ms (100 + 100*2^1 = 300)
      jest.advanceTimersByTime(200);
      await flush();
      expect(notificationFn).toHaveBeenCalledTimes(2);

      // attempt 3 fires at t=700ms (300 + 100*2^2 = 700)
      jest.advanceTimersByTime(400);
      await flush();
      expect(notificationFn).toHaveBeenCalledTimes(maxRetries);
      expect(queue.size()).toBe(0);

      queue.stop();
    });

    it('logs an error when the notification permanently fails', async () => {
      const logger = jest.requireMock('../utils/logger').default;
      const notificationFn: NotificationFn = jest.fn().mockResolvedValue(false);
      const queue = new NotificationRetryQueue(notificationFn, {
        baseDelayMs: 100,
        maxRetries: 1,
        processIntervalMs: 50,
      });
      queue.start();

      queue.enqueue(createMockEvent({ id: 'evt-dead' }), mockContractConfig, 'req-dead');

      jest.advanceTimersByTime(200);
      await Promise.resolve();
      await Promise.resolve();

      expect(logger.error).toHaveBeenCalledWith(
        'Notification permanently failed after max retries',
        expect.objectContaining({ eventId: 'evt-dead', totalAttempts: 1 })
      );
      queue.stop();
    });
  });

  describe('start / stop', () => {
    it('does not process items when stopped', async () => {
      const notificationFn: NotificationFn = jest.fn().mockResolvedValue(true);
      const queue = new NotificationRetryQueue(notificationFn, {
        baseDelayMs: 100,
        processIntervalMs: 50,
      });

      queue.enqueue(createMockEvent(), mockContractConfig);
      // Never call queue.start()

      jest.advanceTimersByTime(1000);
      await Promise.resolve();

      expect(notificationFn).not.toHaveBeenCalled();
    });

    it('calling start twice does not double-process items', async () => {
      const notificationFn: NotificationFn = jest.fn().mockResolvedValue(true);
      const queue = new NotificationRetryQueue(notificationFn, {
        baseDelayMs: 100,
        processIntervalMs: 50,
      });
      queue.start();
      queue.start(); // second call should be a no-op

      queue.enqueue(createMockEvent(), mockContractConfig);

      jest.advanceTimersByTime(200);
      await Promise.resolve();
      await Promise.resolve();

      expect(notificationFn).toHaveBeenCalledTimes(1);
      queue.stop();
    });
  });

  describe('analytics success counter (regression: no duplicate-counting)', () => {
    let aggregator: NotificationAnalyticsAggregator;

    beforeEach(() => {
      aggregator = new NotificationAnalyticsAggregator();
      setNotificationAnalyticsAggregator(aggregator);
    });

    afterEach(() => {
      setNotificationAnalyticsAggregator(null);
    });

    it('increments success exactly once when an operation succeeds after multiple failed retries', async () => {
      // Fails on attempts 1 and 2, succeeds on attempt 3.
      let callCount = 0;
      const notificationFn: NotificationFn = jest.fn().mockImplementation(async () => {
        callCount++;
        return callCount >= 3;
      });

      const queue = new NotificationRetryQueue(notificationFn, {
        baseDelayMs: 100,
        maxRetries: 5,
        processIntervalMs: 50,
        jitter: false,
      });
      queue.start();

      queue.enqueue(createMockEvent({ id: 'evt-multi-retry' }), mockContractConfig, 'req-regression');

      const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

      // Attempt 1 at t=100 (base delay), fails → retry recorded
      jest.advanceTimersByTime(100);
      await flush();
      // Attempt 2 at t=300 (100 + 100*2^1), fails → retry recorded
      jest.advanceTimersByTime(200);
      await flush();
      // Attempt 3 at t=700 (300 + 100*2^2), succeeds → success recorded
      jest.advanceTimersByTime(400);
      await flush();

      queue.stop();

      const snap = aggregator.snapshot();

      // The notification fn was called exactly 3 times
      expect(notificationFn).toHaveBeenCalledTimes(3);

      // Success must be exactly 1 — not 0 (missing) and not >1 (duplicate)
      expect(snap.overall.success).toBe(1);

      // Three retry-attempt events were emitted (one per call before success is known)
      expect(snap.overall.retry).toBe(3);

      // No failure outcome — the operation ultimately succeeded
      expect(snap.overall.failure).toBe(0);
    });
  });
});
