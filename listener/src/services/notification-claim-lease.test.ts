import {
  ClaimLeaseRepository,
  DEFAULT_LEASE_RENEW_RATIO,
  MIN_LEASE_RENEW_INTERVAL_MS,
  NotificationClaimLease,
  calculateLeaseRenewIntervalMs,
  startClaimLease,
} from './notification-claim-lease';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Lets queued microtasks (the serialised renewal chain) settle. */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Deterministic stand-in for setInterval/clearInterval. */
class FakeTimers {
  readonly scheduled: Array<{ handler: () => void; ms: number; handle: unknown }> = [];
  readonly cleared: unknown[] = [];

  readonly setIntervalFn = (handler: () => void, ms: number): unknown => {
    const handle = { id: this.scheduled.length };
    this.scheduled.push({ handler, ms, handle });
    return handle;
  };

  readonly clearIntervalFn = (handle: unknown): void => {
    this.cleared.push(handle);
  };

  fire(index: number = 0): void {
    this.scheduled[index].handler();
  }

  get intervalMs(): number {
    return this.scheduled[0].ms;
  }
}

// ---------------------------------------------------------------------------
// calculateLeaseRenewIntervalMs
// ---------------------------------------------------------------------------

describe('calculateLeaseRenewIntervalMs', () => {
  it('renews at a third of the lock window by default', () => {
    expect(calculateLeaseRenewIntervalMs(30_000)).toBe(10_000);
    expect(calculateLeaseRenewIntervalMs(60_000)).toBe(20_000);
    expect(DEFAULT_LEASE_RENEW_RATIO).toBeCloseTo(1 / 3);
  });

  it('never schedules a renewal at or after the lease expiry', () => {
    for (const lockTimeoutMs of [100, 1_000, 3_000, 5_000, 30_000, 60_000]) {
      const interval = calculateLeaseRenewIntervalMs(lockTimeoutMs);
      expect(interval).toBeGreaterThan(0);
      expect(interval).toBeLessThan(lockTimeoutMs);
    }
  });

  it('floors tiny lock windows so the heartbeat cannot spin', () => {
    // Half the window, never below one millisecond.
    expect(calculateLeaseRenewIntervalMs(1_000)).toBe(500);
    expect(calculateLeaseRenewIntervalMs(MIN_LEASE_RENEW_INTERVAL_MS * 2)).toBe(
      MIN_LEASE_RENEW_INTERVAL_MS,
    );
  });

  it('ignores an out-of-range ratio', () => {
    expect(calculateLeaseRenewIntervalMs(30_000, 0)).toBe(10_000);
    expect(calculateLeaseRenewIntervalMs(30_000, 1)).toBe(10_000);
    expect(calculateLeaseRenewIntervalMs(30_000, 2)).toBe(10_000);
  });
});

// ---------------------------------------------------------------------------
// NotificationClaimLease
// ---------------------------------------------------------------------------

describe('NotificationClaimLease', () => {
  it('requires a renew function', () => {
    expect(
      () =>
        new NotificationClaimLease({
          notificationId: 1,
          processorId: 'worker-a',
          lockTimeoutMs: 30_000,
          renew: undefined as any,
        }),
    ).toThrow(TypeError);
  });

  it('schedules renewals at the derived interval only once', () => {
    const timers = new FakeTimers();
    const lease = new NotificationClaimLease({
      notificationId: 7,
      processorId: 'worker-a',
      lockTimeoutMs: 30_000,
      renew: jest.fn().mockResolvedValue(true),
      setIntervalFn: timers.setIntervalFn,
      clearIntervalFn: timers.clearIntervalFn,
    });

    lease.start();
    lease.start();

    expect(timers.scheduled).toHaveLength(1);
    expect(timers.intervalMs).toBe(10_000);
  });

  it('renews with the claim identity when the timer fires', async () => {
    const timers = new FakeTimers();
    const renew = jest.fn().mockResolvedValue(true);
    const lease = new NotificationClaimLease({
      notificationId: 42,
      processorId: 'worker-a',
      lockTimeoutMs: 9_000,
      renew,
      setIntervalFn: timers.setIntervalFn,
      clearIntervalFn: timers.clearIntervalFn,
    });

    lease.start();
    timers.fire();
    await flushMicrotasks();

    expect(renew).toHaveBeenCalledTimes(1);
    expect(renew).toHaveBeenCalledWith(42, 'worker-a', 9_000);
    expect(lease.getRenewalCount()).toBe(1);
    expect(lease.isLeaseLost()).toBe(false);
  });

  it('serialises renewals so a slow heartbeat cannot overlap itself', async () => {
    const timers = new FakeTimers();
    let inFlight = 0;
    let maxInFlight = 0;
    const renew = jest.fn().mockImplementation(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await flushMicrotasks();
      inFlight -= 1;
      return true;
    });

    const lease = new NotificationClaimLease({
      notificationId: 42,
      processorId: 'worker-a',
      lockTimeoutMs: 30_000,
      renew,
      setIntervalFn: timers.setIntervalFn,
      clearIntervalFn: timers.clearIntervalFn,
    });

    lease.start();
    timers.fire();
    timers.fire();
    timers.fire();
    await flushMicrotasks();
    await flushMicrotasks();

    expect(maxInFlight).toBe(1);
    expect(lease.getRenewalCount()).toBe(3);
  });

  it('marks the lease lost and stops renewing when the claim is gone', async () => {
    const timers = new FakeTimers();
    const renew = jest.fn().mockResolvedValue(false);
    const onLeaseLost = jest.fn();

    const lease = new NotificationClaimLease({
      notificationId: 99,
      processorId: 'worker-a',
      lockTimeoutMs: 30_000,
      renew,
      onLeaseLost,
      setIntervalFn: timers.setIntervalFn,
      clearIntervalFn: timers.clearIntervalFn,
    });

    lease.start();
    timers.fire();
    await flushMicrotasks();

    expect(lease.isLeaseLost()).toBe(true);
    expect(onLeaseLost).toHaveBeenCalledTimes(1);
    expect(onLeaseLost).toHaveBeenCalledWith(99);
    expect(lease.getRenewalCount()).toBe(0);

    // A lost claim must never be re-acquired by the old owner.
    timers.fire();
    await flushMicrotasks();
    expect(renew).toHaveBeenCalledTimes(1);
    expect(onLeaseLost).toHaveBeenCalledTimes(1);
  });

  it('keeps the lease on a transient renewal error and retries next tick', async () => {
    const timers = new FakeTimers();
    const failure = new Error('database is locked');
    const renew = jest
      .fn()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(true);
    const onRenewalError = jest.fn();

    const lease = new NotificationClaimLease({
      notificationId: 5,
      processorId: 'worker-a',
      lockTimeoutMs: 30_000,
      renew,
      onRenewalError,
      setIntervalFn: timers.setIntervalFn,
      clearIntervalFn: timers.clearIntervalFn,
    });

    lease.start();
    timers.fire();
    await flushMicrotasks();

    expect(lease.isLeaseLost()).toBe(false);
    expect(onRenewalError).toHaveBeenCalledWith(5, failure);

    timers.fire();
    await flushMicrotasks();

    expect(lease.getRenewalCount()).toBe(1);
    expect(lease.isLeaseLost()).toBe(false);
  });

  it('stops the heartbeat and waits for the in-flight renewal', async () => {
    const timers = new FakeTimers();
    let resolveRenewal!: (value: boolean) => void;
    const renew = jest.fn().mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          resolveRenewal = resolve;
        }),
    );

    const lease = new NotificationClaimLease({
      notificationId: 3,
      processorId: 'worker-a',
      lockTimeoutMs: 30_000,
      renew,
      setIntervalFn: timers.setIntervalFn,
      clearIntervalFn: timers.clearIntervalFn,
    });

    lease.start();
    timers.fire();
    await flushMicrotasks();

    let stopped = false;
    const stopPromise = lease.stop().then(() => {
      stopped = true;
    });

    await flushMicrotasks();
    // stop() must not resolve while a renewal is still touching the database.
    expect(stopped).toBe(false);

    resolveRenewal(true);
    await stopPromise;
    expect(stopped).toBe(true);
    expect(lease.isStopped()).toBe(true);
    expect(timers.cleared).toHaveLength(1);

    // No further renewals once stopped, even if the timer callback is replayed.
    timers.fire();
    await flushMicrotasks();
    expect(renew).toHaveBeenCalledTimes(1);
  });

  it('stop() is idempotent and safe before start()', async () => {
    const lease = new NotificationClaimLease({
      notificationId: 3,
      processorId: 'worker-a',
      lockTimeoutMs: 30_000,
      renew: jest.fn().mockResolvedValue(true),
    });

    await lease.stop();
    await lease.stop();
    lease.start();

    expect(lease.isStopped()).toBe(true);
  });

  it('heartbeatNow() renews without waiting for the timer', async () => {
    const renew = jest.fn().mockResolvedValue(true);
    const lease = new NotificationClaimLease({
      notificationId: 11,
      processorId: 'worker-a',
      lockTimeoutMs: 30_000,
      renew,
    });

    await expect(lease.heartbeatNow()).resolves.toBe(true);
    expect(renew).toHaveBeenCalledTimes(1);
    expect(lease.getRenewalCount()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// startClaimLease
// ---------------------------------------------------------------------------

describe('startClaimLease', () => {
  it('returns null for a repository without heartbeat support', () => {
    const repository: ClaimLeaseRepository = {};
    expect(
      startClaimLease({
        repository,
        notificationId: 1,
        processorId: 'worker-a',
        lockTimeoutMs: 30_000,
      }),
    ).toBeNull();
  });

  it('binds the repository and starts the heartbeat', async () => {
    const repository = {
      lockExpiresAt: [] as string[],
      async renewLock(id: number, processorId: string, lockTimeoutMs: number): Promise<boolean> {
        this.lockExpiresAt.push(`${processorId}:${id}:${lockTimeoutMs}`);
        return true;
      },
    };

    const lease = startClaimLease({
      repository,
      notificationId: 8,
      processorId: 'worker-a',
      lockTimeoutMs: 30_000,
    });

    expect(lease).not.toBeNull();
    await expect(lease!.heartbeatNow()).resolves.toBe(true);
    expect(repository.lockExpiresAt).toEqual(['worker-a:8:30000']);
    await lease!.stop();
  });
});
