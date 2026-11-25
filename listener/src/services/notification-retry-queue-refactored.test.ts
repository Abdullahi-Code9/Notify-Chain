/**
 * Refactored Notification Retry Queue Tests
 * 
 * Uses NotificationFixtureBuilder to eliminate duplicate event creation
 * and provide deterministic test data for retry queue tests.
 */

import { NotificationRetryQueue, NotificationFn } from './notification-retry-queue';
import { NotificationFixtureBuilder } from '../test-utils/notification-fixture-builder';

jest.mock('../utils/logger', () => ({
  __esModule: true,
  default: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

describe('NotificationRetryQueue (Refactored)', () => {
  // ✅ Using deterministic contract config
  const mockContractConfig = NotificationFixtureBuilder
    .aContractConfig()
    .build();

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

      // ✅ Simple fixture creation
      const event = NotificationFixtureBuilder.aStellarEvent().build();
      queue.enqueue(event, mockContractConfig);

      expect(queue.size()).toBe(1);
    });

    it('logs when an item is queued', () => {
      const logger = jest.requireMock('../utils/logger').default;
      const notificationFn: NotificationFn = jest.fn();
      const queue = new NotificationRetryQueue(notificationFn, { baseDelayMs: 1000 });

      // ✅ Deterministic event ID
      const event = NotificationFixtureBuilder
        .aStellarEvent()
        .withId('evt-q')
        .build();

      queue.enqueue(event, mockContractConfig, 'req-1');

      expect(logger.info).toHaveBeenCalledWith(
        'Notification queued for retry',
        expect.objectContaining({ eventId: 'evt-q', requestId: 'req-1' })
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

      const event = NotificationFixtureBuilder.aStellarEvent().build();
      queue.enqueue(event, mockContractConfig);

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

      const event = NotificationFixtureBuilder.aStellarEvent().build();
      queue.enqueue(event, mockContractConfig);

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

      // ✅ Deterministic event ID
      const event = NotificationFixtureBuilder
        .aStellarEvent()
        .withId('evt-ok')
        .build();

      queue.enqueue(event, mockContractConfig, 'req-ok');
      
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

      const event = NotificationFixtureBuilder.aStellarEvent().build();
      queue.enqueue(event, mockContractConfig);

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

      const event = NotificationFixtureBuilder
        .aStellarEvent()
        .withId('evt-backoff')
        .build();

      queue.enqueue(event, mockContractConfig);

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

      const event = NotificationFixtureBuilder.aStellarEvent().build();
      queue.enqueue(event, mockContractConfig);

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

      const event = NotificationFixtureBuilder
        .aStellarEvent()
        .withId('evt-dead')
        .build();

      queue.enqueue(event, mockContractConfig, 'req-dead');

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

      const event = NotificationFixtureBuilder.aStellarEvent().build();
      queue.enqueue(event, mockContractConfig);
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

      const event = NotificationFixtureBuilder.aStellarEvent().build();
      queue.enqueue(event, mockContractConfig);

      jest.advanceTimersByTime(200);
      await Promise.resolve();
      await Promise.resolve();

      expect(notificationFn).toHaveBeenCalledTimes(1);
      queue.stop();
    });
  });

  describe('multiple events with different characteristics', () => {
    it('processes events with different topics', async () => {
      const notificationFn: NotificationFn = jest.fn().mockResolvedValue(true);
      const queue = new NotificationRetryQueue(notificationFn, {
        baseDelayMs: 100,
        processIntervalMs: 50,
      });
      queue.start();

      // ✅ Easy to create multiple events with different topics
      const events = ['transfer', 'mint', 'burn'].map(topic =>
        NotificationFixtureBuilder
          .aStellarEvent()
          .withTopicSymbol(topic)
          .build()
      );

      events.forEach(event => queue.enqueue(event, mockContractConfig));

      jest.advanceTimersByTime(200);
      for (let i = 0; i < 10; i++) {
        await Promise.resolve();
      }

      expect(notificationFn).toHaveBeenCalledTimes(3);
      queue.stop();
    });
  });
});
