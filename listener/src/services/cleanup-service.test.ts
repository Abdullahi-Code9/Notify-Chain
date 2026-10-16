import { CleanupService } from './cleanup-service';
import { EventRegistry } from '../store/event-registry';

jest.mock('../utils/logger', () => ({
  __esModule: true,
  default: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

// ── helpers ────────────────────────────────────────────────────────────────

function makeDb(changes = 0) {
  return {
    run: jest.fn().mockResolvedValue({ lastID: 0, changes }),
    get: jest.fn().mockResolvedValue({ count: changes }),
  } as unknown as import('../database/database').Database;
}

function addEvent(registry: EventRegistry, overrides: Partial<{ receivedAt: number }> = {}) {
  const event = registry.addFromInput({
    eventId: `evt-${Math.random()}`,
    contractAddress: 'CABC',
    eventName: 'TestEvent',
    ledger: 1,
    type: 'contract',
    topic: [],
    value: { switch: () => ({ name: 'scvVoid' }), value: () => undefined } as any,
  });
  if (overrides.receivedAt !== undefined) {
    (event as any).receivedAt = overrides.receivedAt;
  }
  return event;
}

// ── EventRegistry TTL tests ────────────────────────────────────────────────

describe('EventRegistry TTL cleanup', () => {
  it('pruneExpired removes events older than ttlMs', () => {
    const registry = new EventRegistry(100, 1000);
    addEvent(registry, { receivedAt: Date.now() - 2000 }); // expired
    addEvent(registry, { receivedAt: Date.now() - 500 });  // fresh

    const removed = registry.pruneExpired();

    expect(removed).toBe(1);
    expect(registry.count()).toBe(1);
  });

  it('pruneExpired keeps all events when none are expired', () => {
    const registry = new EventRegistry(100, 10_000);
    addEvent(registry);
    addEvent(registry);

    expect(registry.pruneExpired()).toBe(0);
    expect(registry.count()).toBe(2);
  });

  it('startCleanup and stopCleanup control the interval', () => {
    jest.useFakeTimers();
    const registry = new EventRegistry(100, 500);
    const spy = jest.spyOn(registry, 'pruneExpired');

    registry.startCleanup(200);
    jest.advanceTimersByTime(600);
    expect(spy).toHaveBeenCalledTimes(3);

    registry.stopCleanup();
    jest.advanceTimersByTime(600);
    expect(spy).toHaveBeenCalledTimes(3); // no more calls

    jest.useRealTimers();
  });
});

// ── CleanupService DB tests ────────────────────────────────────────────────

describe('CleanupService', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('starts and fires db cleanup on interval', async () => {
    const db = makeDb(3);
    const registry = new EventRegistry();
    const service = new CleanupService(db, registry, { intervalMs: 500, notificationRetentionMs: 1000, rateLimitEventRetentionMs: 1000 });

    service.start();
    jest.advanceTimersByTime(600);

    // Allow pending promises to resolve
    await Promise.resolve();

    expect(db.run).toHaveBeenCalled();
  });

  it('runDbCleanup deletes old notifications and rate_limit_events', async () => {
    const db = makeDb(5);
    const registry = new EventRegistry();
    const service = new CleanupService(db, registry, { intervalMs: 60000, notificationRetentionMs: 1000, rateLimitEventRetentionMs: 500, executionLogRetentionMs: 500 });

    const result = await service.runDbCleanup();

    // Four DELETE calls, including processed event metadata.
    expect(db.run).toHaveBeenCalledTimes(4);
    expect(db.run).toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM scheduled_notifications'),
      expect.any(Array),
    );
    expect(db.run).toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM rate_limit_events'),
      expect.any(Array),
    );
    expect(db.run).toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM notification_execution_log'),
      expect.any(Array),
    );
    expect(db.run).toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM processed_events'),
      expect.any(Array),
    );
    expect(result.notifications).toBe(5);
    expect(result.rateLimitEvents).toBe(5);
    expect(result.executionLogs).toBe(5);
    expect(result.processedEvents).toBe(5);
  });

  it('uses the configured retention duration for processed event metadata', async () => {
    const db = makeDb();
    const registry = new EventRegistry();
    const service = new CleanupService(db, registry, {
      processedEventRetentionMs: 60_000,
    });

    await service.runDbCleanup();

    expect(db.run).toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM processed_events'),
      [60],
    );
  });

  it('stop clears the interval and stops registry cleanup', async () => {
    const db = makeDb();
    const registry = new EventRegistry();
    const stopRegistrySpy = jest.spyOn(registry, 'stopCleanup');
    const service = new CleanupService(db, registry, { intervalMs: 200, notificationRetentionMs: 1000, rateLimitEventRetentionMs: 1000 });

    service.start();
    await service.stop();

    jest.advanceTimersByTime(1000);
    // db.run should not be called after stop (interval cleared)
    expect(db.run).not.toHaveBeenCalled();
    expect(stopRegistrySpy).toHaveBeenCalled();
  });

  it('calling start twice does not create duplicate intervals', () => {
    const db = makeDb();
    const registry = new EventRegistry();
    const service = new CleanupService(db, registry, { intervalMs: 300, notificationRetentionMs: 1000, rateLimitEventRetentionMs: 1000 });

    service.start();
    service.start(); // second call is a no-op

    jest.advanceTimersByTime(400);
    // Should only fire once despite two start() calls
    expect(db.run).toHaveBeenCalledTimes(3); // one interval tick × 3 SQL statements
  });
});
