/**
 * High-volume event batching.
 *
 * Selected event groups (identified by a caller-supplied group key, by default
 * `<contractAddress>:<eventName>`) can be coalesced into a single batched
 * message instead of one delivery per trigger. A batch is emitted when either:
 *
 *   - the configured `maxBatchSize` is reached, or
 *   - the `windowMs` collection window elapses (whichever comes first).
 *
 * Batching is entirely optional: when `config.enabled` is false — or when the
 * batch size is 1, making batching meaningless — every event is delivered
 * immediately as a single-event batch, preserving the original behaviour.
 *
 * Individual events always stay addressable inside the batch via
 * {@link BatchedEventGroup.eventIds}, so a batched message remains traceable
 * back to each originating record.
 */

import logger from '../utils/logger';
import type { EventBatchingConfig } from '../types';

export type { EventBatchingConfig };

/** A single event eligible for inclusion in a batch. */
export interface BatchableEvent {
  /** Stable identifier of the originating event record (traceability anchor). */
  eventId: string;
  /** Contract the event originated from. */
  contractAddress: string;
  /** Event name, e.g. `task_created`. */
  eventName: string;
  /** Ledger the event was recorded in, when known. */
  ledger?: number;
  /** When the event occurred, when known. */
  occurredAt?: Date;
  /** Any additional, event-specific data to carry through to the batch. */
  [key: string]: unknown;
}

/** A coalesced group of events ready for delivery. */
export interface BatchedEventGroup {
  /** Grouping key used to accumulate these events. */
  groupKey: string;
  /** Whether this group actually coalesced more than one event. */
  batched: boolean;
  /** The individual events, in the order they were added. */
  events: BatchableEvent[];
  /** Count of events in the batch. */
  eventCount: number;
  /** Ids of every event in the batch, for traceability. */
  eventIds: string[];
  /** ISO timestamp when the collection window opened. */
  windowStart: string;
  /** ISO timestamp when the batch was emitted. */
  windowEnd: string;
  /** ISO timestamp when the batch was emitted (alias of `windowEnd`). */
  batchedAt: string;
}

export type BatchFlushHandler = (
  batch: BatchedEventGroup,
) => void | Promise<void>;

export interface EventBatcherOptions {
  config: EventBatchingConfig;
  /** Invoked once per emitted batch. */
  onFlush: BatchFlushHandler;
  /** Injectable clock (ms since epoch). Defaults to `Date.now`. */
  now?: () => number;
}

/** Default grouping key: one group per (contract, event name) pair. */
export function defaultGroupKey(event: Pick<BatchableEvent, 'contractAddress' | 'eventName'>): string {
  return `${event.contractAddress}:${event.eventName}`;
}

interface PendingGroup {
  events: BatchableEvent[];
  windowStart: number;
  timer: NodeJS.Timeout | null;
}

export class EventBatcher {
  private readonly config: EventBatchingConfig;
  private readonly onFlush: BatchFlushHandler;
  private readonly now: () => number;
  private readonly groups = new Map<string, PendingGroup>();
  private stopped = false;

  constructor(options: EventBatcherOptions) {
    this.config = options.config;
    this.onFlush = options.onFlush;
    this.now = options.now ?? (() => Date.now());
  }

  /** True when incoming events are delivered immediately rather than batched. */
  get isImmediateMode(): boolean {
    return !this.config.enabled || this.config.maxBatchSize <= 1;
  }

  /** Total number of events currently buffered across all groups. */
  get pendingCount(): number {
    let total = 0;
    for (const group of this.groups.values()) total += group.events.length;
    return total;
  }

  /** Number of events buffered for a specific group. */
  getPendingCount(groupKey: string): number {
    return this.groups.get(groupKey)?.events.length ?? 0;
  }

  /**
   * Add an event to its group, flushing automatically when the batch size or
   * the collection window is reached.
   *
   * In immediate mode the event is delivered synchronously as a single-event
   * batch and nothing is buffered.
   */
  async add(event: BatchableEvent, groupKey?: string): Promise<void> {
    if (this.stopped) {
      throw new Error('EventBatcher has been stopped');
    }

    const key = groupKey ?? defaultGroupKey(event);

    if (this.isImmediateMode) {
      await this.emit(this.buildBatch(key, [event], this.now(), this.now()));
      return;
    }

    let group = this.groups.get(key);
    if (!group) {
      const openedAt = this.now();
      group = { events: [], windowStart: openedAt, timer: null };
      this.groups.set(key, group);
      group.timer = this.scheduleWindowFlush(key);
    }

    group.events.push(event);

    if (group.events.length >= this.config.maxBatchSize) {
      await this.flush(key);
    }
  }

  /**
   * Flush one group (when `groupKey` is given) or every group.
   *
   * @returns The number of batches emitted.
   */
  async flush(groupKey?: string): Promise<number> {
    const keys = groupKey !== undefined ? [groupKey] : Array.from(this.groups.keys());
    let flushed = 0;
    for (const key of keys) {
      if (await this.flushGroup(key)) flushed++;
    }
    return flushed;
  }

  /**
   * Flush every group whose collection window has elapsed as of `now`.
   *
   * This is the deterministic, timer-free counterpart to the window timer and
   * is what the periodic sweep (or a test) calls to advance time.
   *
   * @returns The number of batches emitted.
   */
  async flushDue(now: number = this.now()): Promise<number> {
    let flushed = 0;
    for (const [key, group] of Array.from(this.groups.entries())) {
      if (now - group.windowStart >= this.config.windowMs) {
        if (await this.flushGroup(key)) flushed++;
      }
    }
    return flushed;
  }

  /** Clear all timers and drop any buffered events without emitting them. */
  stop(): void {
    this.stopped = true;
    for (const group of this.groups.values()) {
      if (group.timer) clearTimeout(group.timer);
    }
    this.groups.clear();
  }

  private scheduleWindowFlush(groupKey: string): NodeJS.Timeout {
    const timer = setTimeout(() => {
      // The window may have been reset by a flush; `flushGroup` is a no-op for
      // groups that no longer exist.
      void this.flushGroup(groupKey).catch((error) => {
        logger.error('EventBatcher window flush failed', { groupKey, error });
      });
    }, this.config.windowMs);
    // A pending flush must not keep the process alive on shutdown.
    timer.unref?.();
    return timer;
  }

  private async flushGroup(groupKey: string): Promise<boolean> {
    const group = this.groups.get(groupKey);
    if (!group || group.events.length === 0) {
      if (group?.timer) clearTimeout(group.timer);
      this.groups.delete(groupKey);
      return false;
    }

    if (group.timer) clearTimeout(group.timer);
    this.groups.delete(groupKey);

    const now = this.now();
    const batch = this.buildBatch(groupKey, group.events, group.windowStart, now);
    await this.emit(batch);
    return true;
  }

  private buildBatch(
    groupKey: string,
    events: BatchableEvent[],
    windowStart: number,
    windowEnd: number,
  ): BatchedEventGroup {
    return {
      groupKey,
      batched: events.length > 1,
      events: [...events],
      eventCount: events.length,
      eventIds: events.map((event) => event.eventId),
      windowStart: new Date(windowStart).toISOString(),
      windowEnd: new Date(windowEnd).toISOString(),
      batchedAt: new Date(windowEnd).toISOString(),
    };
  }

  private async emit(batch: BatchedEventGroup): Promise<void> {
    await this.onFlush(batch);
  }
}
