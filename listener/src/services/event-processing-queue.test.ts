import * as StellarSDK from '@stellar/stellar-sdk';
import {
  EventProcessingQueue,
  EventProcessor,
} from './event-processing-queue';

jest.mock('../utils/logger', () => ({
  __esModule: true,
  default: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

// Stub xdr.ScVal values — EventProcessingQueue never inspects the xdr payload,
// it only passes the event object through to the processor.
const stubScVal = { _switch: { name: 'scvSymbol' } } as unknown as StellarSDK.xdr.ScVal;

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
    topic: [stubScVal],
    value: stubScVal,
    ...overrides,
  };
}

const mockContractConfig = { address: 'CA123', events: ['test_event'] };

describe('EventProcessingQueue', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('enqueue', () => {
    it('adds an event to the queue', () => {
      const processor: EventProcessor = jest.fn();
      const queue = new EventProcessingQueue(processor, { baseDelayMs: 1000 });

      queue.enqueue(createMockEvent(), mockContractConfig);

      expect(queue.size()).toBe(1);
      expect(queue.pendingCount()).toBe(1);
    });

    it('returns true when an event is queued', () => {
      const processor: EventProcessor = jest.fn();
      const queue = new EventProcessingQueue(processor, { baseDelayMs: 1000 });

      const result = queue.enqueue(createMockEvent(), mockContractConfig);

      expect(result).toBe(true);
    });

    it('logs when an event is queued', () => {
      const logger = jest.requireMock('../utils/logger').default;
      const processor: EventProcessor = jest.fn();
      const queue = new EventProcessingQueue(processor, { baseDelayMs: 1000 });

      queue.enqueue(createMockEvent({ id: 'evt-q' }), mockContractConfig, 'req-1');

      expect(logger.info).toHaveBeenCalledWith(
        'Event queued for processing',
        expect.objectContaining({ eventId: 'evt-q', requestId: 'req-1' })
      );
    });

    it('skips duplicate events with the same event id and contract address', () => {
      const logger = jest.requireMock('../utils/logger').default;
      const processor: EventProcessor = jest.fn();
      const queue = new EventProcessingQueue(processor, { baseDelayMs: 1000 });
      const event = createMockEvent({ id: 'evt-dup' });

      const firstResult = queue.enqueue(event, mockContractConfig, 'req-1');
      const secondResult = queue.enqueue(event, mockContractConfig, 'req-2');

      expect(queue.size()).toBe(1);
      expect(firstResult).toBe(true);
      expect(secondResult).toBe(false);
      expect(logger.info).toHaveBeenCalledWith(
        'Skipping duplicate event queue entry',
        expect.objectContaining({
          eventId: 'evt-dup',
          contractAddress: mockContractConfig.address,
        })
      );
    });

    it('allows the same event id from different contract addresses', () => {
      const processor: EventProcessor = jest.fn();
      const queue = new EventProcessingQueue(processor, { baseDelayMs: 1000 });
      const event = createMockEvent({ id: 'evt-same' });
      const otherConfig = { address: 'CB456', events: ['test_event'] };

      queue.enqueue(event, mockContractConfig);
      queue.enqueue(event, otherConfig);

      expect(queue.size()).toBe(2);
    });

    it('allows different event ids from the same contract address', () => {
      const processor: EventProcessor = jest.fn();
      const queue = new EventProcessingQueue(processor, { baseDelayMs: 1000 });

      queue.enqueue(createMockEvent({ id: 'evt-1' }), mockContractConfig);
      queue.enqueue(createMockEvent({ id: 'evt-2' }), mockContractConfig);

      expect(queue.size()).toBe(2);
    });

    it('returns false for a duplicate and does not add to the queue', () => {
      const processor: EventProcessor = jest.fn();
      const queue = new EventProcessingQueue(processor, { baseDelayMs: 1000 });

      queue.enqueue(createMockEvent({ id: 'evt-only' }), mockContractConfig);
      const result = queue.enqueue(
        createMockEvent({ id: 'evt-only' }),
        mockContractConfig
      );

      expect(result).toBe(false);
      expect(queue.size()).toBe(1);
    });
  });

  describe('processing', () => {
    it('processes a queued event after the base delay', async () => {
      const processor: EventProcessor = jest.fn().mockResolvedValue(true);
      const queue = new EventProcessingQueue(processor, {
        baseDelayMs: 1000,
        pollIntervalMs: 100,
      });
      queue.start();

      queue.enqueue(createMockEvent(), mockContractConfig);

      // Before delay expires — should not have processed yet
      jest.advanceTimersByTime(500);
      await Promise.resolve();
      expect(processor).not.toHaveBeenCalled();

      // After delay expires — should process
      jest.advanceTimersByTime(600);
      await Promise.resolve();
      await Promise.resolve();
      expect(processor).toHaveBeenCalledTimes(1);

      queue.stop();
    });

    it('calls the processor with the correct arguments', async () => {
      const processor: EventProcessor = jest.fn().mockResolvedValue(true);
      const queue = new EventProcessingQueue(processor, {
        baseDelayMs: 100,
        pollIntervalMs: 50,
      });
      queue.start();

      const event = createMockEvent({ id: 'evt-args' });
      queue.enqueue(event, mockContractConfig, 'req-args');

      jest.advanceTimersByTime(200);
      await Promise.resolve();
      await Promise.resolve();

      expect(processor).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'evt-args' }),
        mockContractConfig,
        'req-args'
      );

      queue.stop();
    });

    it('removes the event from the queue on success', async () => {
      const processor: EventProcessor = jest.fn().mockResolvedValue(true);
      const queue = new EventProcessingQueue(processor, {
        baseDelayMs: 100,
        pollIntervalMs: 50,
      });
      queue.start();

      queue.enqueue(createMockEvent(), mockContractConfig);

      jest.advanceTimersByTime(200);
      await Promise.resolve();
      await Promise.resolve();

      expect(queue.size()).toBe(0);

      queue.stop();
    });

    it('logs success on a successful processing', async () => {
      const logger = jest.requireMock('../utils/logger').default;
      const processor: EventProcessor = jest.fn().mockResolvedValue(true);
      const queue = new EventProcessingQueue(processor, {
        baseDelayMs: 100,
        pollIntervalMs: 50,
      });
      queue.start();

      queue.enqueue(createMockEvent({ id: 'evt-ok' }), mockContractConfig, 'req-ok');

      jest.advanceTimersByTime(200);
      await Promise.resolve();
      await Promise.resolve();

      expect(logger.info).toHaveBeenCalledWith(
        'Event processing succeeded',
        expect.objectContaining({ eventId: 'evt-ok' })
      );

      queue.stop();
    });

    it('processes events in enqueue order (FIFO)', async () => {
      const callOrder: string[] = [];
      const processor: EventProcessor = jest.fn().mockImplementation(async (event) => {
        callOrder.push(event.id);
        return true;
      });
      const queue = new EventProcessingQueue(processor, {
        baseDelayMs: 50,
        pollIntervalMs: 50,
      });
      queue.start();

      queue.enqueue(createMockEvent({ id: 'first' }), mockContractConfig);
      queue.enqueue(createMockEvent({ id: 'second' }), mockContractConfig);

      // First cycle: process 'first' (available=1, only one at a time)
      jest.advanceTimersByTime(100);
      await Promise.resolve();
      await Promise.resolve();

      // Second cycle: process 'second'
      jest.advanceTimersByTime(100);
      await Promise.resolve();
      await Promise.resolve();

      expect(callOrder).toEqual(['first', 'second']);

      queue.stop();
    });
  });

  describe('exponential backoff', () => {
    it('doubles the delay on each successive failure', async () => {
      const processor: EventProcessor = jest.fn().mockResolvedValue(false);
      const queue = new EventProcessingQueue(processor, {
        baseDelayMs: 1000,
        maxRetries: 5,
        pollIntervalMs: 100,
      });
      queue.start();

      queue.enqueue(createMockEvent(), mockContractConfig);

      // Trigger attempt 1 (after 1000 ms base delay)
      jest.advanceTimersByTime(1100);
      await Promise.resolve();
      await Promise.resolve();
      expect(processor).toHaveBeenCalledTimes(1);

      // Trigger attempt 2 (after 2000 ms from attempt 1)
      jest.advanceTimersByTime(2100);
      await Promise.resolve();
      await Promise.resolve();
      expect(processor).toHaveBeenCalledTimes(2);

      queue.stop();
    });

    it('logs a warning with the next retry delay on failure', async () => {
      const logger = jest.requireMock('../utils/logger').default;
      const processor: EventProcessor = jest.fn().mockResolvedValue(false);
      const queue = new EventProcessingQueue(processor, {
        baseDelayMs: 1000,
        maxRetries: 3,
        pollIntervalMs: 100,
      });
      queue.start();

      queue.enqueue(createMockEvent({ id: 'evt-backoff' }), mockContractConfig);

      jest.advanceTimersByTime(1100);
      await Promise.resolve();
      await Promise.resolve();

      expect(logger.warn).toHaveBeenCalledWith(
        'Event processing failed, scheduling retry',
        expect.objectContaining({ eventId: 'evt-backoff', attempt: 1, delayMs: 2000 })
      );

      queue.stop();
    });
  });

  describe('max retries', () => {
    it('stops retrying after maxRetries attempts', async () => {
      const processor: EventProcessor = jest.fn().mockResolvedValue(false);
      const maxRetries = 3;
      const queue = new EventProcessingQueue(processor, {
        baseDelayMs: 100,
        maxRetries,
        pollIntervalMs: 50,
      });
      queue.start();
      queue.enqueue(createMockEvent(), mockContractConfig);

      const flush = async () => {
        for (let i = 0; i < 5; i++) await Promise.resolve();
      };

      // attempt 1 fires at t=100ms (base delay)
      jest.advanceTimersByTime(100);
      await flush();
      expect(processor).toHaveBeenCalledTimes(1);

      // attempt 2 fires at t=300ms (100 + 100*2^1 = 300)
      jest.advanceTimersByTime(200);
      await flush();
      expect(processor).toHaveBeenCalledTimes(2);

      // attempt 3 fires at t=700ms (300 + 100*2^2 = 700)
      jest.advanceTimersByTime(400);
      await flush();
      expect(processor).toHaveBeenCalledTimes(maxRetries);
      expect(queue.size()).toBe(0);

      queue.stop();
    });

    it('logs an error when the event permanently fails', async () => {
      const logger = jest.requireMock('../utils/logger').default;
      const processor: EventProcessor = jest.fn().mockResolvedValue(false);
      const queue = new EventProcessingQueue(processor, {
        baseDelayMs: 100,
        maxRetries: 1,
        pollIntervalMs: 50,
      });
      queue.start();

      queue.enqueue(createMockEvent({ id: 'evt-dead' }), mockContractConfig, 'req-dead');

      jest.advanceTimersByTime(200);
      await Promise.resolve();
      await Promise.resolve();

      expect(logger.error).toHaveBeenCalledWith(
        'Event processing permanently failed after max retries',
        expect.objectContaining({ eventId: 'evt-dead', totalAttempts: 1 })
      );

      queue.stop();
    });
  });

  describe('error handling', () => {
    it('retries when the processor throws an error', async () => {
      const processor: EventProcessor = jest
        .fn()
        .mockRejectedValueOnce(new Error('Unexpected error'))
        .mockResolvedValueOnce(true);
      const queue = new EventProcessingQueue(processor, {
        baseDelayMs: 100,
        maxRetries: 3,
        pollIntervalMs: 50,
      });
      queue.start();

      queue.enqueue(createMockEvent({ id: 'evt-err' }), mockContractConfig);

      jest.advanceTimersByTime(200);
      await Promise.resolve();
      await Promise.resolve();
      expect(processor).toHaveBeenCalledTimes(1);
      expect(queue.size()).toBe(1); // still in queue for retry

      jest.advanceTimersByTime(400);
      await Promise.resolve();
      await Promise.resolve();
      expect(processor).toHaveBeenCalledTimes(2);
      expect(queue.size()).toBe(0); // succeeded on retry

      queue.stop();
    });

    it('logs error on processor crash and schedules retry', async () => {
      const logger = jest.requireMock('../utils/logger').default;
      const processor: EventProcessor = jest
        .fn()
        .mockRejectedValue(new Error('Crash'));
      const queue = new EventProcessingQueue(processor, {
        baseDelayMs: 100,
        maxRetries: 2,
        pollIntervalMs: 50,
      });
      queue.start();

      queue.enqueue(createMockEvent({ id: 'evt-crash' }), mockContractConfig);

      jest.advanceTimersByTime(200);
      await Promise.resolve();
      await Promise.resolve();

      expect(logger.error).toHaveBeenCalledWith(
        'Event processing crashed, scheduling retry',
        expect.objectContaining({
          eventId: 'evt-crash',
          attempt: 1,
          delayMs: 200,
        })
      );

      queue.stop();
    });

    it('clears fingerprint on permanent failure after processor crash', async () => {
      const processor: EventProcessor = jest
        .fn()
        .mockRejectedValue(new Error('Permanent crash'));
      const queue = new EventProcessingQueue(processor, {
        baseDelayMs: 100,
        maxRetries: 1,
        pollIntervalMs: 50,
      });
      queue.start();

      queue.enqueue(createMockEvent({ id: 'evt-perm' }), mockContractConfig);

      jest.advanceTimersByTime(200);
      await Promise.resolve();
      await Promise.resolve();

      // After permanent failure, re-enqueueing the same event should work
      const reenqueueResult = queue.enqueue(
        createMockEvent({ id: 'evt-perm' }),
        mockContractConfig
      );
      expect(reenqueueResult).toBe(true);

      queue.stop();
    });
  });

  describe('concurrency', () => {
    it('respects maxConcurrency = 1 (default)', async () => {
      let concurrent = 0;
      let maxObserved = 0;
      const processor: EventProcessor = jest.fn().mockImplementation(async () => {
        concurrent++;
        maxObserved = Math.max(maxObserved, concurrent);
        await new Promise((resolve) => setTimeout(resolve, 500));
        concurrent--;
        return true;
      });
      const queue = new EventProcessingQueue(processor, {
        baseDelayMs: 50,
        pollIntervalMs: 50,
      });
      queue.start();

      queue.enqueue(createMockEvent({ id: 'evt-con-1' }), mockContractConfig);
      queue.enqueue(createMockEvent({ id: 'evt-con-2' }), mockContractConfig);

      // Let first item start processing
      jest.advanceTimersByTime(200);
      await Promise.resolve();
      await Promise.resolve();

      // At this point, only one item should be in flight
      expect(processor).toHaveBeenCalledTimes(1);
      expect(maxObserved).toBe(1);

      queue.stop();
    });

    it('processes up to maxConcurrency items simultaneously', async () => {
      let concurrent = 0;
      let maxObserved = 0;
      const processor: EventProcessor = jest.fn().mockImplementation(async () => {
        concurrent++;
        maxObserved = Math.max(maxObserved, concurrent);
        await new Promise((resolve) => setTimeout(resolve, 500));
        concurrent--;
        return true;
      });
      const queue = new EventProcessingQueue(processor, {
        baseDelayMs: 50,
        maxConcurrency: 3,
        pollIntervalMs: 50,
      });
      queue.start();

      queue.enqueue(createMockEvent({ id: 'evt-1' }), mockContractConfig);
      queue.enqueue(createMockEvent({ id: 'evt-2' }), mockContractConfig);
      queue.enqueue(createMockEvent({ id: 'evt-3' }), mockContractConfig);

      // Let the cycle start processing
      jest.advanceTimersByTime(200);
      await Promise.resolve();
      await Promise.resolve();

      expect(maxObserved).toBe(3);

      queue.stop();
    });
  });

  describe('start / stop', () => {
    it('does not process items when stopped', async () => {
      const processor: EventProcessor = jest.fn().mockResolvedValue(true);
      const queue = new EventProcessingQueue(processor, {
        baseDelayMs: 100,
        pollIntervalMs: 50,
      });

      queue.enqueue(createMockEvent(), mockContractConfig);
      // Never call queue.start()

      jest.advanceTimersByTime(1000);
      await Promise.resolve();

      expect(processor).not.toHaveBeenCalled();
    });

    it('calling start twice does not double-process items', async () => {
      const processor: EventProcessor = jest.fn().mockResolvedValue(true);
      const queue = new EventProcessingQueue(processor, {
        baseDelayMs: 100,
        pollIntervalMs: 50,
      });
      queue.start();
      queue.start(); // second call should be a no-op

      queue.enqueue(createMockEvent(), mockContractConfig);

      jest.advanceTimersByTime(200);
      await Promise.resolve();
      await Promise.resolve();

      expect(processor).toHaveBeenCalledTimes(1);

      queue.stop();
    });

    it('stops processing items after stop is called', async () => {
      const processor: EventProcessor = jest.fn().mockResolvedValue(true);
      const queue = new EventProcessingQueue(processor, {
        baseDelayMs: 100,
        pollIntervalMs: 50,
      });
      queue.start();

      queue.enqueue(createMockEvent({ id: 'evt-stop' }), mockContractConfig);

      queue.stop();

      jest.advanceTimersByTime(1000);
      await Promise.resolve();

      expect(processor).not.toHaveBeenCalled();
    });
  });
});
