/**
 * Retry policy integration tests (#842)
 *
 * Verifies that the configurable policy is actually honoured by every retry
 * path:
 *   - RetryScheduler (DB-backed, production path)
 *   - NotificationRetryQueue (in-memory Discord fallback)
 *   - EventProcessingQueue (in-memory event pipeline)
 *
 * The headline behaviour is the second acceptance criterion: permanent
 * failures must not consume the retry budget.
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { RetryScheduler, RETRY_SCHEDULER_DEFAULTS } from './retry-scheduler';
import { NotificationRetryQueue, Priority, type NotificationFn } from './notification-retry-queue';
import { EventProcessingQueue, type EventProcessor } from './event-processing-queue';
import { DeliveryError, RetryFailureType } from './retry-policy';
import { NotificationStatus, NotificationType } from '../types/scheduled-notification';
import { Database } from '../database/database';
import { ScheduledNotificationRepository } from './scheduled-notification-repository';

jest.mock('../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../utils/request-id', () => ({
  generateRequestId: () => 'test-req-id',
  generateCorrelationId: () => 'test-correlation-id',
}));
jest.mock('./worker-manager', () => ({
  getWorkerManager: () => ({
    isShutdownInProgress: () => false,
    startJob: () => true,
    completeJob: () => {},
    initiateGracefulShutdown: jest.fn().mockImplementation(() => Promise.resolve()),
  }),
}));

// ── helpers ─────────────────────────────────────────────────────────────────

function makeRepo(overrides: Record<string, any> = {}): any {
  return {
    recoverStaleLocks: jest.fn().mockImplementation(() => Promise.resolve(0)),
    fetchDueRetries: jest.fn().mockImplementation(() => Promise.resolve([])),
    markAsCompleted: jest.fn().mockImplementation(() => Promise.resolve()),
    markAsFailedOrRetry: jest.fn().mockImplementation(() => Promise.resolve()),
    logExecution: jest.fn().mockImplementation(() => Promise.resolve()),
    ...overrides,
  };
}

function makeWebhookNotification(overrides: Record<string, any> = {}) {
  return {
    id: 42,
    payload: JSON.stringify({ event: 'order.created' }),
    notificationType: NotificationType.WEBHOOK,
    targetRecipient: 'https://example.com/webhook',
    executeAt: new Date(),
    status: NotificationStatus.PROCESSING,
    retryCount: 1,
    maxRetries: 5,
    priority: 5,
    ...overrides,
  };
}

function webhookFailing(statusCode: number): any {
  return {
    deliver: jest.fn<() => Promise<any>>().mockResolvedValue({
      success: false,
      statusCode,
      errorReason: `HTTP ${statusCode}`,
    }),
  };
}

interface RetryArgs {
  id: number;
  error: Error;
  retries: number;
  max: number;
  next: unknown;
}

function lastRetryArgs(repo: any): RetryArgs {
  const [id, error, retries, max, next] = (repo.markAsFailedOrRetry as jest.Mock).mock
    .calls[0] as unknown as [number, Error, number, number, unknown];
  return { id, error, retries, max, next };
}

function makeEvent(id = 'evt-1'): any {
  return {
    id,
    type: 'contract',
    ledger: 1000,
    inSuccessfulContractCall: true,
    txHash: 'abc123',
    topic: [{ switch: () => 'scvSymbol', sym: () => 'test_event', toString: () => 'test_event' }],
    value: { switch: () => 'scvString', str: () => 'test value' },
  };
}

const contractConfig = { address: 'CABC', events: ['*'] };

// ═══════════════════════════════════════════════════════════════════════════
// RetryScheduler
// ═══════════════════════════════════════════════════════════════════════════

describe('RetryScheduler — retry policy (#842)', () => {
  let logger: any;

  beforeEach(() => {
    jest.clearAllMocks();
    logger = (jest.requireMock('../utils/logger') as any).default;
  });

  // ── Permanent failures are not retried (acceptance criterion) ─────────────

  describe('permanent failures are not retried', () => {
    it.each([
      [400, 'client error'],
      [401, 'auth error'],
      [403, 'auth error'],
      [404, 'not found'],
      [422, 'client error'],
    ])('stops immediately on HTTP %i (%s) even with attempts remaining', async (statusCode) => {
      const notification = makeWebhookNotification({ retryCount: 0, maxRetries: 5 });
      const repo = makeRepo({
        fetchDueRetries: jest.fn().mockImplementation(() => Promise.resolve([notification])),
      });

      const scheduler = new RetryScheduler(
        repo,
        { ...RETRY_SCHEDULER_DEFAULTS, jitter: false },
        null,
        webhookFailing(statusCode),
      );
      await scheduler.runOnce();

      const { next, max } = lastRetryArgs(repo);
      expect(next).toBeUndefined();
      // retryCount 0 → this was attempt 1. The budget is collapsed to the attempt
      // that just failed so `markAsFailedOrRetry` retires the row as FAILED
      // rather than leaving it PENDING with a NULL `next_retry_at` (which
      // `fetchDueRetries` would immediately re-select).
      expect(max).toBe(1);
      expect(repo.logExecution).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'FAILED' }),
      );
    });

    it('reports the permanent reason distinctly from an exhausted budget', async () => {
      const notification = makeWebhookNotification({ retryCount: 0, maxRetries: 5 });
      const repo = makeRepo({
        fetchDueRetries: jest.fn().mockImplementation(() => Promise.resolve([notification])),
      });

      const scheduler = new RetryScheduler(repo, RETRY_SCHEDULER_DEFAULTS, null, webhookFailing(404));
      await scheduler.runOnce();

      expect(logger.error).toHaveBeenCalledWith(
        'Notification failed permanently, not retried',
        expect.objectContaining({ id: 42, failureType: RetryFailureType.NotFound }),
      );
      expect(logger.warn).not.toHaveBeenCalledWith(
        'Retry failed, scheduling next attempt',
        expect.anything(),
      );
    });

    it('treats a missing Discord service as a permanent configuration failure', async () => {
      const notification = {
        ...makeWebhookNotification(),
        notificationType: NotificationType.DISCORD,
        payload: JSON.stringify({ event: {}, contractConfig }),
      };
      const repo = makeRepo({
        fetchDueRetries: jest.fn().mockImplementation(() => Promise.resolve([notification])),
      });

      // discordService intentionally omitted
      const scheduler = new RetryScheduler(repo, RETRY_SCHEDULER_DEFAULTS, null, webhookFailing(500));
      await scheduler.runOnce();

      expect(lastRetryArgs(repo).next).toBeUndefined();
      expect(logger.error).toHaveBeenCalledWith(
        'Notification failed permanently, not retried',
        expect.objectContaining({ failureType: RetryFailureType.ConfigurationError }),
      );
    });

    it('treats an unsupported notification type as a permanent configuration failure', async () => {
      const notification = makeWebhookNotification({ notificationType: NotificationType.SMS });
      const repo = makeRepo({
        fetchDueRetries: jest.fn().mockImplementation(() => Promise.resolve([notification])),
      });

      const scheduler = new RetryScheduler(repo, RETRY_SCHEDULER_DEFAULTS, null, webhookFailing(500));
      await scheduler.runOnce();

      expect(lastRetryArgs(repo).next).toBeUndefined();
      expect(logger.error).toHaveBeenCalledWith(
        'Notification failed permanently, not retried',
        expect.objectContaining({ failureType: RetryFailureType.ConfigurationError }),
      );
    });

    it('treats a missing targetRecipient as a permanent configuration failure', async () => {
      const notification = makeWebhookNotification({ targetRecipient: '' });
      const repo = makeRepo({
        fetchDueRetries: jest.fn().mockImplementation(() => Promise.resolve([notification])),
      });

      const scheduler = new RetryScheduler(
        repo,
        RETRY_SCHEDULER_DEFAULTS,
        null,
        { deliver: jest.fn() } as any,
      );
      await scheduler.runOnce();

      const { error, next } = lastRetryArgs(repo);
      expect(error.message).toContain('targetRecipient');
      expect(next).toBeUndefined();
    });
  });

  // ── Transient failures still retry ────────────────────────────────────────

  describe('transient failures keep retrying', () => {
    it.each([429, 500, 502, 503, 504])('schedules a retry on HTTP %i', async (statusCode) => {
      const notification = makeWebhookNotification({ retryCount: 1, maxRetries: 5 });
      const repo = makeRepo({
        fetchDueRetries: jest.fn().mockImplementation(() => Promise.resolve([notification])),
      });

      const scheduler = new RetryScheduler(
        repo,
        { ...RETRY_SCHEDULER_DEFAULTS, baseDelayMs: 1_000, jitter: false },
        null,
        webhookFailing(statusCode),
      );
      await scheduler.runOnce();

      expect(lastRetryArgs(repo).next).toBeInstanceOf(Date);
      expect(repo.logExecution).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'RETRY' }),
      );
    });

    it('retries a thrown network error', async () => {
      const notification = makeWebhookNotification({ retryCount: 0, maxRetries: 5 });
      const repo = makeRepo({
        fetchDueRetries: jest.fn().mockImplementation(() => Promise.resolve([notification])),
      });

      const webhookService = {
        deliver: jest.fn<() => Promise<any>>().mockRejectedValue(
          Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
        ),
      } as any;

      const scheduler = new RetryScheduler(repo, RETRY_SCHEDULER_DEFAULTS, null, webhookService);
      await scheduler.runOnce();

      expect(lastRetryArgs(repo).next).toBeInstanceOf(Date);
      expect(logger.warn).toHaveBeenCalledWith(
        'Retry failed, scheduling next attempt',
        expect.objectContaining({ failureType: RetryFailureType.NetworkError }),
      );
    });

    it('still retries an unclassifiable delivery rejection, preserving prior behaviour', async () => {
      const notification = makeWebhookNotification({
        notificationType: NotificationType.DISCORD,
        payload: JSON.stringify({ event: {}, contractConfig }),
        retryCount: 0,
        maxRetries: 5,
      });
      const repo = makeRepo({
        fetchDueRetries: jest.fn().mockImplementation(() => Promise.resolve([notification])),
      });

      // A bare `false` carries no failure type, so it must fall back to Unknown.
      const discordService = {
        sendEventNotification: jest.fn<() => Promise<boolean>>().mockResolvedValue(false),
      } as any;
      const scheduler = new RetryScheduler(repo, RETRY_SCHEDULER_DEFAULTS, discordService);
      await scheduler.runOnce();

      expect(lastRetryArgs(repo).next).toBeInstanceOf(Date);
      expect(logger.warn).toHaveBeenCalledWith(
        'Retry failed, scheduling next attempt',
        expect.objectContaining({ failureType: RetryFailureType.Unknown }),
      );
    });
  });

  // ── Configurable attempt ceiling ──────────────────────────────────────────

  describe('configurable maximum attempts', () => {
    it('leaves the per-notification maxRetries in charge when no ceiling is set', async () => {
      const notification = makeWebhookNotification({ retryCount: 4, maxRetries: 5 });
      const repo = makeRepo({
        fetchDueRetries: jest.fn().mockImplementation(() => Promise.resolve([notification])),
      });

      const scheduler = new RetryScheduler(repo, RETRY_SCHEDULER_DEFAULTS, null, webhookFailing(503));
      await scheduler.runOnce();

      // attempt 5 of 5 → exhausted, and maxRetries is passed through unchanged
      expect(lastRetryArgs(repo)).toMatchObject({ max: 5, next: undefined });
      expect(logger.error).toHaveBeenCalledWith(
        'Notification permanently failed after max retries',
        expect.anything(),
      );
    });

    it('caps a notification that asks for more attempts than the policy allows', async () => {
      const notification = makeWebhookNotification({ retryCount: 2, maxRetries: 9 });
      const repo = makeRepo({
        fetchDueRetries: jest.fn().mockImplementation(() => Promise.resolve([notification])),
      });

      const scheduler = new RetryScheduler(
        repo,
        { ...RETRY_SCHEDULER_DEFAULTS, maxAttempts: 2, jitter: false },
        null,
        webhookFailing(503),
      );
      await scheduler.runOnce();

      // Capped at 2, so attempt 3 of 2 is already over budget.
      expect(lastRetryArgs(repo)).toMatchObject({ max: 2, next: undefined });
    });

    it('never retries when the policy sets maxAttempts to 1', async () => {
      const notification = makeWebhookNotification({ retryCount: 0, maxRetries: 5 });
      const repo = makeRepo({
        fetchDueRetries: jest.fn().mockImplementation(() => Promise.resolve([notification])),
      });

      const scheduler = new RetryScheduler(
        repo,
        { ...RETRY_SCHEDULER_DEFAULTS, maxAttempts: 1 },
        null,
        webhookFailing(503),
      );
      await scheduler.runOnce();

      expect(lastRetryArgs(repo)).toMatchObject({ max: 1, next: undefined });
      expect(repo.logExecution).toHaveBeenCalledWith(expect.objectContaining({ status: 'FAILED' }));
    });

    it('allows a raised ceiling to extend a notification with a small budget', async () => {
      const notification = makeWebhookNotification({ retryCount: 2, maxRetries: 5 });
      const repo = makeRepo({
        fetchDueRetries: jest.fn().mockImplementation(() => Promise.resolve([notification])),
      });

      const scheduler = new RetryScheduler(
        repo,
        { ...RETRY_SCHEDULER_DEFAULTS, maxAttempts: 10, baseDelayMs: 1_000, jitter: false },
        null,
        webhookFailing(503),
      );
      await scheduler.runOnce();

      expect(lastRetryArgs(repo)).toMatchObject({ max: 5 });
      expect(lastRetryArgs(repo).next).toBeInstanceOf(Date);
    });
  });

  // ── End-to-end: the row really leaves the retry queue (#842) ──────────────
  //
  // The mocked-repository suites above assert the arguments the scheduler hands
  // to `markAsFailedOrRetry`. This block drives the real repository so the
  // resulting row state is verified, which is what actually stops the retry
  // loop: `fetchDueRetries` re-selects any PENDING row whose `next_retry_at` is
  // NULL, so a permanent failure that merely cleared `nextRetryAt` while leaving
  // budget on the clock would be picked straight back up.

  describe('permanent failures retire the row end-to-end', () => {
    let db: Database;
    let repository: ScheduledNotificationRepository;

    beforeEach(async () => {
      db = new Database(':memory:');
      await db.initialize();
      repository = new ScheduledNotificationRepository(db);
    });

    afterEach(async () => {
      await db.close();
    });

    async function seedRow(maxRetries: number): Promise<number> {
      const id = await repository.create({
        payload: { event: 'order.created' },
        notificationType: NotificationType.WEBHOOK,
        targetRecipient: 'https://example.com/webhook',
        executeAt: new Date(),
        maxRetries,
      });
      // Put the row in the state `fetchDueRetries` selects: PENDING with at
      // least one prior failure.
      await repository.markAsFailedOrRetry(id, new Error('earlier transient failure'), 0, maxRetries, new Date());
      return id;
    }

    it('marks a 404 FAILED and stops re-selecting it on the next poll', async () => {
      const id = await seedRow(5);
      const scheduler = new RetryScheduler(
        repository,
        { ...RETRY_SCHEDULER_DEFAULTS, jitter: false },
        null,
        webhookFailing(404),
      );

      await scheduler.runOnce();

      const row = (await repository.getById(id))!;
      expect(row.status).toBe(NotificationStatus.FAILED);
      expect(row.nextRetryAt).toBeNull();

      // The decisive assertion: another poll must not hand the row back.
      await scheduler.runOnce();
      const unchanged = (await repository.getById(id))!;
      expect(unchanged.status).toBe(NotificationStatus.FAILED);
      expect(unchanged.retryCount).toBe(row.retryCount);
    });

    it('keeps retrying a 503, so the row stays PENDING until the budget runs out', async () => {
      const id = await seedRow(3);
      const scheduler = new RetryScheduler(
        repository,
        { ...RETRY_SCHEDULER_DEFAULTS, baseDelayMs: 1, jitter: false },
        null,
        webhookFailing(503),
      );

      await scheduler.runOnce();

      const row = (await repository.getById(id))!;
      expect(row.status).toBe(NotificationStatus.PENDING);
      expect(row.retryCount).toBe(2);
      expect(row.nextRetryAt).not.toBeNull();
    });
  });

  // ── Configurable eligible failure types ───────────────────────────────────

  describe('configurable eligible failure types', () => {
    it('retries 4xx when the operator adds client errors to the eligible set', async () => {
      const notification = makeWebhookNotification({ retryCount: 0, maxRetries: 5 });
      const repo = makeRepo({
        fetchDueRetries: jest.fn().mockImplementation(() => Promise.resolve([notification])),
      });

      const scheduler = new RetryScheduler(
        repo,
        {
          ...RETRY_SCHEDULER_DEFAULTS,
          jitter: false,
          retryableFailureTypes: [RetryFailureType.ClientError],
        },
        null,
        webhookFailing(422),
      );
      await scheduler.runOnce();

      expect(lastRetryArgs(repo).next).toBeInstanceOf(Date);
      expect(repo.logExecution).toHaveBeenCalledWith(expect.objectContaining({ status: 'RETRY' }));
    });

    it('stops retrying 5xx when the operator narrows the eligible set', async () => {
      const notification = makeWebhookNotification({ retryCount: 0, maxRetries: 5 });
      const repo = makeRepo({
        fetchDueRetries: jest.fn().mockImplementation(() => Promise.resolve([notification])),
      });

      const scheduler = new RetryScheduler(
        repo,
        {
          ...RETRY_SCHEDULER_DEFAULTS,
          retryableFailureTypes: [RetryFailureType.Timeout],
        },
        null,
        webhookFailing(503),
      );
      await scheduler.runOnce();

      expect(lastRetryArgs(repo).next).toBeUndefined();
      expect(logger.error).toHaveBeenCalledWith(
        'Notification failed permanently, not retried',
        expect.objectContaining({ failureType: RetryFailureType.ServerError }),
      );
    });

    it('exposes the resolved policy for inspection', () => {
      const scheduler = new RetryScheduler(
        makeRepo(),
        {
          maxAttempts: 4,
          retryableFailureTypes: [RetryFailureType.ServerError],
        },
      );

      const policy = scheduler.getRetryPolicy();
      expect(policy.resolveMaxAttempts(10)).toBe(4);
      expect(policy.isRetryable(RetryFailureType.ServerError)).toBe(true);
      expect(policy.isRetryable(RetryFailureType.Unknown)).toBe(false);
    });

    it('logs the active policy on start', async () => {
      const scheduler = new RetryScheduler(
        makeRepo(),
        {
          enabled: true,
          pollIntervalMs: 999_999,
          maxAttempts: 3,
          retryableFailureTypes: [RetryFailureType.Timeout],
        },
      );

      await scheduler.start();

      expect(logger.info).toHaveBeenCalledWith(
        'RetryScheduler started',
        expect.objectContaining({
          maxAttempts: 3,
          retryableFailureTypes: [RetryFailureType.Timeout],
        }),
      );
      await scheduler.stop();
    });
  });

  // ── Configurable delay ────────────────────────────────────────────────────

  describe('configurable delay', () => {
    it.each([
      [1_000, 2],
      [500, 3],
      [10, 10],
    ])('applies base %i with multiplier %i', async (baseDelayMs, multiplier) => {
      const notification = makeWebhookNotification({ retryCount: 1, maxRetries: 5 });
      const repo = makeRepo({
        fetchDueRetries: jest.fn().mockImplementation(() => Promise.resolve([notification])),
      });

      const scheduler = new RetryScheduler(
        repo,
        { ...RETRY_SCHEDULER_DEFAULTS, baseDelayMs, multiplier, jitter: false },
        null,
        webhookFailing(503),
      );

      const before = Date.now();
      await scheduler.runOnce();
      const after = Date.now();

      const expected = baseDelayMs * Math.pow(multiplier, 1);
      const next = lastRetryArgs(repo).next as Date;
      expect(next.getTime()).toBeGreaterThanOrEqual(before + expected - 50);
      expect(next.getTime()).toBeLessThanOrEqual(after + expected + 50);
    });

    it('caps the delay at maxDelayMs', async () => {
      const notification = makeWebhookNotification({ retryCount: 8, maxRetries: 12 });
      const repo = makeRepo({
        fetchDueRetries: jest.fn().mockImplementation(() => Promise.resolve([notification])),
      });

      const scheduler = new RetryScheduler(
        repo,
        {
          ...RETRY_SCHEDULER_DEFAULTS,
          baseDelayMs: 1_000,
          multiplier: 2,
          maxDelayMs: 2_000,
          jitter: false,
        },
        null,
        webhookFailing(503),
      );

      const before = Date.now();
      await scheduler.runOnce();
      const after = Date.now();

      // Asserted as a window rather than an exact timestamp: this block uses
      // real timers, so the scheduler's internal `Date.now()` lands somewhere
      // between `before` and `after`. The uncapped delay would be
      // 1_000 * 2^8 = 256_000ms, far outside this window, so the assertion still
      // proves the cap was applied.
      const next = lastRetryArgs(repo).next as Date;
      expect(next.getTime()).toBeGreaterThanOrEqual(before + 2_000);
      expect(next.getTime()).toBeLessThanOrEqual(after + 2_000);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// NotificationRetryQueue
// ═══════════════════════════════════════════════════════════════════════════

describe('NotificationRetryQueue — retry policy (#842)', () => {
  let logger: any;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    logger = (jest.requireMock('../utils/logger') as any).default;
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  const flush = async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  };

  it('does not requeue an item whose delivery threw a permanent failure', async () => {
    const notificationFn = jest.fn<NotificationFn>().mockRejectedValue(
      new DeliveryError('HTTP 404', RetryFailureType.NotFound, { statusCode: 404 }),
    );
    const queue = new NotificationRetryQueue(notificationFn, {
      baseDelayMs: 10,
      maxRetries: 5,
      processIntervalMs: 10,
      jitter: false,
    });
    queue.start();
    queue.enqueue(makeEvent('evt-permanent'), contractConfig, 'req-1', Priority.High);

    jest.advanceTimersByTime(20);
    await flush();

    // Attempted once, then dropped — no requeue despite 4 attempts of budget left.
    expect(notificationFn).toHaveBeenCalledTimes(1);
    expect(queue.size()).toBe(0);
    expect(queue.getMetrics().totalSkippedPermanent).toBe(1);
    expect(logger.error).toHaveBeenCalledWith(
      'Notification failed permanently, not retried',
      expect.objectContaining({ eventId: 'evt-permanent' }),
    );
    queue.stop();
  });

  it('keeps requeueing an item whose delivery threw a transient failure', async () => {
    const notificationFn = jest.fn<NotificationFn>().mockRejectedValue(
      Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
    );
    const queue = new NotificationRetryQueue(notificationFn, {
      baseDelayMs: 10,
      maxRetries: 3,
      processIntervalMs: 10,
      jitter: false,
    });
    queue.start();
    queue.enqueue(makeEvent('evt-transient'), contractConfig);

    jest.advanceTimersByTime(20);
    await flush();
    expect(notificationFn).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(40);
    await flush();
    expect(notificationFn).toHaveBeenCalledTimes(2);
    expect(queue.getMetrics().totalSkippedPermanent).toBe(0);
    queue.stop();
  });

  it('honours a policy attempt ceiling that is lower than maxRetries', async () => {
    const notificationFn = jest.fn<NotificationFn>().mockResolvedValue(false);
    const queue = new NotificationRetryQueue(notificationFn, {
      baseDelayMs: 10,
      maxRetries: 5,
      processIntervalMs: 10,
      jitter: false,
      retryPolicy: { maxAttempts: 1 },
    });
    queue.start();
    queue.enqueue(makeEvent('evt-ceiling'), contractConfig);

    jest.advanceTimersByTime(20);
    await flush();

    expect(notificationFn).toHaveBeenCalledTimes(1);
    expect(queue.size()).toBe(0);
    queue.stop();
  });

  it('honours a narrowed eligible failure set', async () => {
    const notificationFn = jest.fn<NotificationFn>().mockRejectedValue(
      new DeliveryError('HTTP 503', RetryFailureType.ServerError, { statusCode: 503 }),
    );
    const queue = new NotificationRetryQueue(notificationFn, {
      baseDelayMs: 10,
      maxRetries: 5,
      processIntervalMs: 10,
      jitter: false,
      retryPolicy: { retryableFailureTypes: [RetryFailureType.Timeout] },
    });
    queue.start();
    queue.enqueue(makeEvent('evt-narrowed'), contractConfig);

    jest.advanceTimersByTime(20);
    await flush();

    expect(notificationFn).toHaveBeenCalledTimes(1);
    expect(queue.size()).toBe(0);
    expect(queue.getMetrics().totalSkippedPermanent).toBe(1);
    queue.stop();
  });

  it('exposes the resolved policy', () => {
    const queue = new NotificationRetryQueue(jest.fn<NotificationFn>().mockResolvedValue(true), {
      retryPolicy: { maxAttempts: 3 },
    });

    expect(queue.getRetryPolicy().resolveMaxAttempts(10)).toBe(3);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// EventProcessingQueue
// ═══════════════════════════════════════════════════════════════════════════

describe('EventProcessingQueue — retry policy (#842)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  const flush = async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  };

  it('does not requeue an event whose processor threw a permanent failure', async () => {
    const processor = jest.fn<EventProcessor>().mockRejectedValue(
      new DeliveryError('unauthorized', RetryFailureType.AuthError, { statusCode: 401 }),
    );
    const queue = new EventProcessingQueue(processor, {
      baseDelayMs: 10,
      maxRetries: 5,
      pollIntervalMs: 10,
      retryPolicy: { maxAttempts: 1 },
    });
    queue.start();
    queue.enqueue(makeEvent('evt-auth'), contractConfig);

    jest.advanceTimersByTime(20);
    await flush();

    expect(queue.size()).toBe(0);
    expect(queue.pendingCount()).toBe(0);
    expect(queue.getMetrics().totalSkippedPermanent).toBe(1);
    queue.stop();
  });

  it('requeues an event whose processor threw a transient failure', async () => {
    const processor = jest.fn<EventProcessor>().mockRejectedValue(
      new DeliveryError('HTTP 503', RetryFailureType.ServerError, { statusCode: 503 }),
    );
    const queue = new EventProcessingQueue(processor, {
      baseDelayMs: 10,
      maxRetries: 3,
      pollIntervalMs: 10,
    });
    queue.start();
    queue.enqueue(makeEvent('evt-5xx'), contractConfig);

    jest.advanceTimersByTime(20);
    await flush();
    expect(processor).toHaveBeenCalledTimes(1);
    expect(queue.getMetrics().totalSkippedPermanent).toBe(0);
    queue.stop();
  });

  it('honours a policy attempt ceiling on false-returning processors', async () => {
    const processor = jest.fn<EventProcessor>().mockResolvedValue(false);
    const queue = new EventProcessingQueue(processor, {
      baseDelayMs: 10,
      maxRetries: 5,
      pollIntervalMs: 10,
      retryPolicy: { maxAttempts: 2 },
    });
    queue.start();
    queue.enqueue(makeEvent('evt-cap'), contractConfig);

    jest.advanceTimersByTime(20);
    await flush();
    expect(processor).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(40);
    await flush();
    expect(processor).toHaveBeenCalledTimes(2);
    expect(queue.size()).toBe(0);
    queue.stop();
  });

  it('exposes the resolved policy', () => {
    const queue = new EventProcessingQueue(jest.fn<EventProcessor>().mockResolvedValue(true), {
      retryPolicy: { retryableFailureTypes: [RetryFailureType.ServerError] },
    });

    expect(queue.getRetryPolicy().isRetryable(RetryFailureType.ServerError)).toBe(true);
    expect(queue.getRetryPolicy().isRetryable(RetryFailureType.Timeout)).toBe(false);
  });
});
