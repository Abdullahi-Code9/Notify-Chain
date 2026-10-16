/**
 * Lease heartbeat for claimed notification jobs.
 *
 * A claim is a soft distributed lock: the worker that dequeued a job owns it
 * until `lock_expires_at` passes. Both schedulers call `recoverStaleLocks()` at
 * the start of every poll, so a delivery that outlives its lock window (a slow
 * webhook, a stalled socket, a long retry chain) is reset to PENDING and handed
 * to another worker while the first one is still sending it — the same
 * notification goes out twice.
 *
 * `NotificationClaimLease` closes that window from the worker side: while the
 * job is being processed it re-extends the lock at a fraction of the lock
 * window, and it stops renewing the moment the owner-checked renewal comes back
 * false, so a worker that genuinely lost its claim cannot take the job back.
 *
 * The module is deliberately dependency-free — the timer and the renewal
 * function are injected — so the renewal policy is unit-testable without a
 * database, and a repository double that predates the heartbeat API simply
 * yields `null` from {@link startClaimLease}.
 */

/** Owner-checked lease extension: resolves false when the claim is no longer held. */
export type ClaimLeaseRenewal = (
  notificationId: number,
  processorId: string,
  lockTimeoutMs: number,
) => Promise<boolean>;

/** Minimal repository surface the heartbeat needs. */
export interface ClaimLeaseRepository {
  renewLock?: ClaimLeaseRenewal;
}

export interface NotificationClaimLeaseOptions {
  notificationId: number;
  processorId: string;
  lockTimeoutMs: number;
  /** Owner-checked lease extension. Must resolve false when the claim is gone. */
  renew: ClaimLeaseRenewal;
  /** Portion of the lock window that elapses before each renewal. Default 1/3. */
  renewAfterRatio?: number;
  /** Injectable timer so tests can drive the heartbeat deterministically. */
  setIntervalFn?: (handler: () => void, ms: number) => unknown;
  clearIntervalFn?: (handle: unknown) => void;
  /** Called once when the claim is found to belong to someone else. */
  onLeaseLost?: (notificationId: number) => void;
  /** Called on a transient renewal failure; the lease stays held. */
  onRenewalError?: (notificationId: number, error: unknown) => void;
}

export const DEFAULT_LEASE_RENEW_RATIO = 1 / 3;
export const MIN_LEASE_RENEW_INTERVAL_MS = 1_000;

/**
 * How long to wait between lease renewals for a given lock window.
 *
 * Kept strictly below the lock window so at least one renewal lands before the
 * lease can expire, and floored at {@link MIN_LEASE_RENEW_INTERVAL_MS} so a tiny
 * (test) lock window does not spin the heartbeat.
 */
export function calculateLeaseRenewIntervalMs(
  lockTimeoutMs: number,
  renewAfterRatio: number = DEFAULT_LEASE_RENEW_RATIO,
): number {
  const lockWindow = Number.isFinite(lockTimeoutMs) ? Math.floor(lockTimeoutMs) : 0;

  if (lockWindow <= MIN_LEASE_RENEW_INTERVAL_MS * 2) {
    return Math.max(1, Math.floor(lockWindow / 2));
  }

  const ratio =
    renewAfterRatio > 0 && renewAfterRatio < 1 ? renewAfterRatio : DEFAULT_LEASE_RENEW_RATIO;
  const candidate = Math.floor(lockWindow * ratio);

  return Math.min(Math.max(candidate, MIN_LEASE_RENEW_INTERVAL_MS), lockWindow - 1);
}

/**
 * Keeps a single claimed notification's lease alive until {@link stop} is
 * called.
 *
 * Renewals are serialised, so a slow renewal can never overlap the next one, and
 * {@link stop} waits for the in-flight renewal before returning — the caller can
 * safely close the database immediately afterwards.
 */
export class NotificationClaimLease {
  readonly notificationId: number;
  readonly processorId: string;
  readonly lockTimeoutMs: number;
  readonly renewIntervalMs: number;

  private readonly renew: ClaimLeaseRenewal;
  private readonly setIntervalFn: (handler: () => void, ms: number) => unknown;
  private readonly clearIntervalFn: (handle: unknown) => void;
  private readonly onLeaseLost?: (notificationId: number) => void;
  private readonly onRenewalError?: (notificationId: number, error: unknown) => void;

  private handle: unknown = null;
  private started = false;
  private stopped = false;
  private leaseLost = false;
  private renewals = 0;
  private pendingRenewal: Promise<unknown> = Promise.resolve();

  constructor(options: NotificationClaimLeaseOptions) {
    if (typeof options.renew !== 'function') {
      throw new TypeError('NotificationClaimLease requires a renew function');
    }

    this.notificationId = options.notificationId;
    this.processorId = options.processorId;
    this.lockTimeoutMs = options.lockTimeoutMs;
    this.renewIntervalMs = calculateLeaseRenewIntervalMs(
      options.lockTimeoutMs,
      options.renewAfterRatio,
    );

    this.renew = options.renew;
    this.setIntervalFn = options.setIntervalFn ?? ((handler, ms) => setInterval(handler, ms));
    this.clearIntervalFn =
      options.clearIntervalFn ?? ((handle) => clearInterval(handle as ReturnType<typeof setInterval>));
    this.onLeaseLost = options.onLeaseLost;
    this.onRenewalError = options.onRenewalError;
  }

  /** Begin renewing the lease on `renewIntervalMs`. Idempotent. */
  start(): void {
    if (this.started || this.stopped) return;

    this.started = true;
    this.handle = this.setIntervalFn(() => {
      this.scheduleRenewal();
    }, this.renewIntervalMs);
  }

  /**
   * Renew the lease once, right now. Awaits any timer-driven renewal already in
   * flight first, so the caller sees a strictly ordered result.
   */
  async heartbeatNow(): Promise<boolean> {
    await this.pendingRenewal;
    return this.performRenewal();
  }

  /** Stop renewing and wait for the in-flight renewal to settle. Idempotent. */
  async stop(): Promise<void> {
    if (this.stopped) return;

    this.stopped = true;

    if (this.handle !== null) {
      this.clearIntervalFn(this.handle);
      this.handle = null;
    }

    await this.pendingRenewal;
  }

  /** True once a renewal came back false: another owner holds the job. */
  isLeaseLost(): boolean {
    return this.leaseLost;
  }

  isStopped(): boolean {
    return this.stopped;
  }

  getRenewalCount(): number {
    return this.renewals;
  }

  private scheduleRenewal(): void {
    if (this.stopped || this.leaseLost) return;

    // The catch keeps the serialisation chain alive: a throwing callback must
    // not silently stop the heartbeat for the rest of the delivery.
    this.pendingRenewal = this.pendingRenewal
      .then(() => this.performRenewal())
      .catch(() => false);
  }

  private async performRenewal(): Promise<boolean> {
    if (this.stopped || this.leaseLost) return false;

    try {
      const renewed = await this.renew(this.notificationId, this.processorId, this.lockTimeoutMs);

      if (renewed) {
        this.renewals += 1;
        return true;
      }

      this.leaseLost = true;
      this.onLeaseLost?.(this.notificationId);
      return false;
    } catch (error) {
      // Transient failure: the original lease is still valid and the next
      // heartbeat may well succeed, so the claim is not treated as lost.
      this.onRenewalError?.(this.notificationId, error);
      return false;
    }
  }
}

export interface StartClaimLeaseOptions {
  repository: ClaimLeaseRepository;
  notificationId: number;
  processorId: string;
  lockTimeoutMs: number;
  onLeaseLost?: (notificationId: number) => void;
  onRenewalError?: (notificationId: number, error: unknown) => void;
  setIntervalFn?: (handler: () => void, ms: number) => unknown;
  clearIntervalFn?: (handle: unknown) => void;
}

/**
 * Build and start a lease heartbeat for `notificationId`.
 *
 * Returns null when the repository has no `renewLock` (e.g. a unit-test double
 * written before the heartbeat existed) so callers keep working unchanged.
 */
export function startClaimLease(
  options: StartClaimLeaseOptions,
): NotificationClaimLease | null {
  const { repository } = options;

  if (typeof repository.renewLock !== 'function') {
    return null;
  }

  const lease = new NotificationClaimLease({
    notificationId: options.notificationId,
    processorId: options.processorId,
    lockTimeoutMs: options.lockTimeoutMs,
    renew: repository.renewLock.bind(repository),
    onLeaseLost: options.onLeaseLost,
    onRenewalError: options.onRenewalError,
    setIntervalFn: options.setIntervalFn,
    clearIntervalFn: options.clearIntervalFn,
  });

  lease.start();
  return lease;
}
