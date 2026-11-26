/** Per-destination notification fan-out guard (#1260). */
import { createHash } from 'crypto';
import logger from './logger';

export interface AmplificationGuardOptions {
  windowMs?: number;
  maxPerDestination?: number;
  duplicateWindowMs?: number;
  clock?: () => number;
}

export class NotificationAmplificationError extends Error {
  readonly statusCode = 429;
  readonly errorCode = 'RATE_LIMITED';
  constructor(readonly reason: 'limit' | 'duplicate') {
    super(reason === 'duplicate' ? 'An equivalent notification was requested recently' : 'Notification destination has exceeded its delivery limit');
    this.name = 'NotificationAmplificationError';
  }
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

export class NotificationAmplificationGuard {
  private readonly windowMs: number;
  private readonly maxPerDestination: number;
  private readonly duplicateWindowMs: number;
  private readonly clock: () => number;
  private readonly attempts = new Map<string, number[]>();
  private readonly fingerprints = new Map<string, number>();
  private blockedCount = 0;

  constructor(options: AmplificationGuardOptions = {}) {
    this.windowMs = options.windowMs ?? 60_000;
    this.maxPerDestination = options.maxPerDestination ?? 20;
    this.duplicateWindowMs = options.duplicateWindowMs ?? this.windowMs;
    this.clock = options.clock ?? Date.now;
  }

  check(destination: string, fingerprint = destination): void {
    const now = this.clock();
    const destinationHash = hash(destination);
    const recent = (this.attempts.get(destinationHash) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.maxPerDestination) {
      this.block();
      logger.warn('Notification delivery throttled', { destinationHash, reason: 'limit', windowMs: this.windowMs });
      throw new NotificationAmplificationError('limit');
    }
    const fp = hash(fingerprint);
    const last = this.fingerprints.get(fp);
    if (last !== undefined && now - last < this.duplicateWindowMs) {
      this.block();
      logger.warn('Notification delivery throttled', { destinationHash, reason: 'duplicate', windowMs: this.duplicateWindowMs });
      throw new NotificationAmplificationError('duplicate');
    }
    recent.push(now);
    this.attempts.set(destinationHash, recent);
    this.fingerprints.set(fp, now);
  }

  private block(): void { this.blockedCount += 1; }
  getMetrics(): { blockedCount: number; windowMs: number; maxPerDestination: number } {
    return { blockedCount: this.blockedCount, windowMs: this.windowMs, maxPerDestination: this.maxPerDestination };
  }
  reset(): void { this.attempts.clear(); this.fingerprints.clear(); this.blockedCount = 0; }
}
