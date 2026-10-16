import { DisplayEvent } from '../types/display-event';
import { RegistryEventInput } from '../types/registry-event-input';
import { formatScValArray, formatScValValue } from '../utils/scval-format';
import logger from '../utils/logger';

const DEFAULT_MAX_EVENTS = 10000;
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export class EventRegistry {
  private readonly events = new Map<string, DisplayEvent>();
  private readonly maxEvents: number;
  private ttlMs: number;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private lastIngestedLedger: number | null = null;
  private lastIngestedAt: number | null = null;
  private maxLedgerSeen: number | null = null;

  constructor(maxEvents = DEFAULT_MAX_EVENTS, ttlMs = DEFAULT_TTL_MS) {
    if (!Number.isInteger(maxEvents) || maxEvents < 1) {
      throw new Error('maxEvents must be a positive integer');
    }
    if (!Number.isFinite(ttlMs) || ttlMs < 1) {
      throw new Error('ttlMs must be a positive number');
    }
    this.maxEvents = maxEvents;
    this.ttlMs = ttlMs;
  }

  startCleanup(intervalMs = 60_000): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => this.pruneExpired(), intervalMs);
  }

  setTtlMs(ttlMs: number): void {
    if (!Number.isFinite(ttlMs) || ttlMs < 1) {
      throw new Error('ttlMs must be a positive number');
    }
    this.ttlMs = ttlMs;
  }

  stopCleanup(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  pruneExpired(): number {
    const cutoff = Date.now() - this.ttlMs;
    let removed = 0;
    for (const [key, event] of this.events) {
      if (event.receivedAt < cutoff) {
        this.events.delete(key);
        removed++;
      }
    }
    if (removed > 0) {
      logger.info('Pruned expired events from registry', { removed, remaining: this.events.size });
    }
    return removed;
  }

  addFromInput(input: RegistryEventInput): DisplayEvent {
    const eventKey = this.getEventKey(input.eventId, input.contractAddress);
    const existing = this.events.get(eventKey);
    if (existing) {
      return existing;
    }

    const topic = formatScValArray(input.topic);
    const displayEvent: DisplayEvent = {
      eventId: input.eventId,
      contractAddress: input.contractAddress,
      eventName: input.eventName ?? topic[0] ?? null,
      ledger: input.ledger,
      type: input.type,
      topic,
      value: formatScValValue(input.value),
      txHash: input.txHash,
      receivedAt: Date.now(),
    };

    this.events.set(eventKey, displayEvent);
    this.lastIngestedLedger = displayEvent.ledger;
    this.lastIngestedAt = displayEvent.receivedAt;
    this.maxLedgerSeen =
      this.maxLedgerSeen === null
        ? displayEvent.ledger
        : Math.max(this.maxLedgerSeen, displayEvent.ledger);

    if (this.events.size > this.maxEvents) {
      const evicted = this.events.size - this.maxEvents;
      const oldestKeys = Array.from(this.events.keys()).slice(0, evicted);
      oldestKeys.forEach((key) => this.events.delete(key));
      logger.warn('Event registry at capacity, evicting oldest events', {
        maxEvents: this.maxEvents,
        evicted,
      });
    }

    return displayEvent;
  }

  getEvents(limit?: number): DisplayEvent[] {
    const events = Array.from(this.events.values());
    if (limit === undefined || limit >= events.length) {
      return events;
    }
    return events.slice(events.length - limit);
  }

  /**
   * Returns all events whose ledger number falls within [startLedger, endLedger] (inclusive).
   * The caller is responsible for validating the range before calling this method.
   */
  getEventsByLedgerRange(startLedger: number, endLedger: number): DisplayEvent[] {
    return Array.from(this.events.values()).filter(
      (event) => event.ledger >= startLedger && event.ledger <= endLedger,
    );
  }

  count(): number {
    return this.events.size;
  }

  has(eventId: string, contractAddress: string): boolean {
    return this.events.has(this.getEventKey(eventId, contractAddress));
  }

  /**
   * Returns ingestion metadata for the most recently ingested event.
   * Used by observability endpoints (e.g. indexing health).
   */
  getIngestionSnapshot(): {
    lastIngestedLedger: number | null;
    lastIngestedAt: number | null;
    maxLedgerSeen: number | null;
  } {
    return {
      lastIngestedLedger: this.lastIngestedLedger,
      lastIngestedAt: this.lastIngestedAt,
      maxLedgerSeen: this.maxLedgerSeen,
    };
  }

  clear(): void {
    this.events.clear();
    this.lastIngestedLedger = null;
    this.lastIngestedAt = null;
    this.maxLedgerSeen = null;
  }

  private getEventKey(eventId: string, contractAddress: string): string {
    return `${contractAddress}:${eventId}`;
  }
}

export const eventRegistry = new EventRegistry();
