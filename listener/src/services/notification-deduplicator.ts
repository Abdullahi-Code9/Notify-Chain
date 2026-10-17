import logger from '../utils/logger';
import crypto from 'crypto';

const DEFAULT_MAX_SIZE = 10000;
const DEFAULT_WINDOW_MS = 60000;

/**
 * Generates a deterministic fingerprint for a notification event.
 * Uses SHA256 hash for collision resistance and includes:
 * - Contract address (identifies source contract)
 * - Event ID (unique event identifier)
 *
 * This fingerprint serves as the primary deduplication key.
 */
export function generateFingerprint(eventId: string, contractAddress: string): string {
  const raw = `${contractAddress}:${eventId}`;
  return crypto.createHash('sha256').update(raw).digest('hex');
}

/**
 * Generates an extended fingerprint that includes event metadata.
 * Useful for detecting duplicate notifications with different metadata.
 */
export function generateExtendedFingerprint(
  eventId: string,
  contractAddress: string,
  eventType: string,
  ledgerNumber: number
): string {
  const raw = `${contractAddress}:${eventId}:${eventType}:${ledgerNumber}`;
  return crypto.createHash('sha256').update(raw).digest('hex');
}

export interface NotificationDeduplicatorOptions {
  maxSize?: number;
  windowMs?: number;
  now?: () => number;
}

export interface NotificationDeduplicationMetrics {
  acceptedRequests: number;
  skippedDuplicates: number;
  evictedEntries: number;
  expiredEntries: number;
  cacheSize: number;
  deduplicationWindowMs: number;
  hitRatio: number;
  totalChecks: number;
}

/**
 * Tracks detailed deduplication events for monitoring and debugging.
 */
export interface DeduplicationEvent {
  timestamp: number;
  fingerprint: string;
  isDuplicate: boolean;
  reason?: string;
  metadata?: Record<string, any>;
}

export class NotificationDeduplicator {
  private readonly seen: Map<string, number>;
  private readonly maxSize: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private acceptedRequests = 0;
  private skippedDuplicates = 0;
  private evictedEntries = 0;
  private expiredEntries = 0;
  private totalChecks = 0;
  private readonly events: DeduplicationEvent[] = [];
  private readonly maxEventHistory = 1000;

  constructor(options: NotificationDeduplicatorOptions | number = {}) {
    const normalizedOptions = typeof options === 'number' ? { maxSize: options } : options;
    this.seen = new Map();
    this.maxSize = Math.max(1, normalizedOptions.maxSize ?? DEFAULT_MAX_SIZE);
    this.windowMs = Math.max(1, normalizedOptions.windowMs ?? DEFAULT_WINDOW_MS);
    this.now = normalizedOptions.now ?? Date.now;
  }

  /**
   * Check if a fingerprint represents a duplicate notification.
   * Logs detailed deduplication events for monitoring.
   */
  isDuplicate(fingerprint: string): boolean {
    this.totalChecks++;
    this.pruneExpired();
    const expiresAt = this.seen.get(fingerprint);
    const duplicate = expiresAt !== undefined && expiresAt > this.now();

    if (duplicate) {
      this.skippedDuplicates++;
      this.recordEvent({
        timestamp: this.now(),
        fingerprint,
        isDuplicate: true,
        reason: 'Duplicate within deduplication window',
      });
      logger.debug('Duplicate notification detected', {
        fingerprint,
        windowMs: this.windowMs,
        metricsSkipped: this.skippedDuplicates,
      });
    }

    return duplicate;
  }

  /**
   * Mark a notification as sent and track it for future deduplication.
   */
  markSent(fingerprint: string, metadata?: Record<string, any>): void {
    this.pruneExpired();
    if (this.seen.size >= this.maxSize) {
      const oldest = this.seen.keys().next().value as string;
      this.seen.delete(oldest);
      this.evictedEntries++;
      logger.warn('Notification deduplicator cache full, evicted oldest entry', {
        evicted: oldest,
        cacheSize: this.maxSize,
        totalEvictions: this.evictedEntries,
      });
    }
    this.seen.set(fingerprint, this.now() + this.windowMs);
    this.acceptedRequests++;

    this.recordEvent({
      timestamp: this.now(),
      fingerprint,
      isDuplicate: false,
      reason: 'Notification accepted and tracked',
      metadata,
    });

    logger.debug('Notification marked as sent', {
      fingerprint,
      cacheSize: this.seen.size,
      acceptedTotal: this.acceptedRequests,
    });
  }

  /**
   * Get current cache size without triggering a full prune.
   */
  size(): number {
    this.pruneExpired();
    return this.seen.size;
  }

  /**
   * Get comprehensive deduplication metrics including hit ratio.
   */
  getMetrics(): NotificationDeduplicationMetrics {
    const hitRatio = this.totalChecks > 0
      ? Math.round((this.skippedDuplicates / this.totalChecks) * 10000) / 100
      : 0;

    return {
      acceptedRequests: this.acceptedRequests,
      skippedDuplicates: this.skippedDuplicates,
      evictedEntries: this.evictedEntries,
      expiredEntries: this.expiredEntries,
      cacheSize: this.size(),
      deduplicationWindowMs: this.windowMs,
      hitRatio,
      totalChecks: this.totalChecks,
    };
  }

  /**
   * Get recent deduplication events for monitoring and debugging.
   */
  getRecentEvents(limit: number = 100): DeduplicationEvent[] {
    return this.events.slice(-limit);
  }

  /**
   * Clear all events from the history.
   */
  clearEventHistory(): void {
    this.events.length = 0;
  }

  /**
   * Reset the deduplicator to its initial state: empty cache, metrics, and events.
   */
  clear(): void {
    this.seen.clear();
    this.events.length = 0;
    this.resetMetrics();
  }

  /**
   * Reset all metrics (useful for testing or metrics reporting).
   */
  resetMetrics(): void {
    this.acceptedRequests = 0;
    this.skippedDuplicates = 0;
    this.evictedEntries = 0;
    this.expiredEntries = 0;
    this.totalChecks = 0;
  }

  /**
   * Record a deduplication event for monitoring.
   * Maintains a rolling history of events for debugging.
   */
  private recordEvent(event: DeduplicationEvent): void {
    this.events.push(event);
    if (this.events.length > this.maxEventHistory) {
      this.events.shift();
    }
  }

  /**
   * Remove expired entries from the deduplication cache.
   */
  private pruneExpired(): void {
    const now = this.now();
    for (const [fingerprint, expiresAt] of this.seen) {
      if (expiresAt > now) {
        continue;
      }

      this.seen.delete(fingerprint);
      this.expiredEntries++;
    }
  }
}
