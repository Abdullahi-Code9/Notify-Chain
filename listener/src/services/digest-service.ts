/**
 * Periodic digest summaries.
 *
 * Instead of delivering an immediate alert per event, a recipient can opt into
 * periodic summaries. Events are accumulated per recipient and emitted as a
 * single digest when either:
 *
 *   - the configured `intervalMs` elapses (hourly, daily, …), or
 *   - `maxEventsPerDigest` events have accumulated, whichever comes first.
 *
 * Every digest preserves the individual event references (`eventIds` plus a
 * full `events` array) so a summary is always traceable back to the original
 * records. The human-readable text is produced through the i18n translator so
 * it follows the configured locale.
 */

import logger from '../utils/logger';
import { Translator, getDefaultTranslator } from '../i18n';
import type { DigestConfig } from '../types';

export type { DigestConfig };

/** A single event included in a digest. */
export interface DigestEvent {
  /** Stable identifier of the originating event record (traceability anchor). */
  eventId: string;
  contractAddress: string;
  eventName: string;
  ledger?: number;
  /** Scheduled-notification id, when the event was persisted as one. */
  notificationId?: number;
  occurredAt?: Date;
  [key: string]: unknown;
}

/** An emitted digest summary for a single recipient. */
export interface DigestSummary {
  recipient: string;
  /** ISO timestamp the accumulation window opened. */
  intervalStart: string;
  /** ISO timestamp the digest was generated. */
  intervalEnd: string;
  eventCount: number;
  /** Individual events, in arrival order — traceable to their records. */
  events: DigestEvent[];
  /** Ids of every event included, for quick lookup/traceability. */
  eventIds: string[];
  /** ISO timestamp the digest was generated. */
  generatedAt: string;
  /** Localized digest title. */
  title: string;
  /** Localized one-line summary. */
  text: string;
  /** Localized per-event lines. */
  lines: string[];
}

export type DigestHandler = (digest: DigestSummary) => void | Promise<void>;

export interface DigestServiceOptions {
  config: DigestConfig;
  /** Invoked once per emitted digest. */
  onDigest: DigestHandler;
  /** Translator used for user-facing text. Defaults to the shared translator. */
  translator?: Translator;
  /** Injectable clock (ms since epoch). Defaults to `Date.now`. */
  now?: () => number;
}

interface PendingDigest {
  events: DigestEvent[];
  windowStart: number;
}

export class DigestService {
  private readonly config: DigestConfig;
  private readonly onDigest: DigestHandler;
  private readonly translator: Translator;
  private readonly now: () => number;
  private readonly pending = new Map<string, PendingDigest>();
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(options: DigestServiceOptions) {
    this.config = options.config;
    this.onDigest = options.onDigest;
    this.translator = options.translator ?? getDefaultTranslator();
    this.now = options.now ?? (() => Date.now());
  }

  get enabled(): boolean {
    return this.config.enabled;
  }

  /** Number of buffered events for a recipient, or across all recipients. */
  getPendingCount(recipient?: string): number {
    if (recipient !== undefined) return this.pending.get(recipient)?.events.length ?? 0;
    let total = 0;
    for (const group of this.pending.values()) total += group.events.length;
    return total;
  }

  /**
   * Accumulate an event for `recipient`.
   *
   * @returns The emitted digest when accumulation reached `maxEventsPerDigest`,
   *          otherwise `null`. Always `null` when digests are disabled.
   */
  async recordEvent(
    recipient: string,
    event: DigestEvent,
    now: number = this.now(),
  ): Promise<DigestSummary | null> {
    if (this.stopped) throw new Error('DigestService has been stopped');
    if (!this.config.enabled) return null;

    let group = this.pending.get(recipient);
    if (!group) {
      group = { events: [], windowStart: now };
      this.pending.set(recipient, group);
    }

    group.events.push(event);

    if (group.events.length >= this.config.maxEventsPerDigest) {
      return this.flush(recipient, now);
    }

    return null;
  }

  /**
   * Emit digests for every recipient whose interval has elapsed as of `now`.
   * Deterministic and timer-free, for use by the scheduler and by tests.
   *
   * @returns The emitted digests.
   */
  async collectDue(now: number = this.now()): Promise<DigestSummary[]> {
    const due: string[] = [];
    for (const [recipient, group] of this.pending.entries()) {
      if (now - group.windowStart >= this.config.intervalMs) due.push(recipient);
    }

    const summaries: DigestSummary[] = [];
    for (const recipient of due) {
      const summary = await this.flush(recipient, now);
      if (summary) summaries.push(summary);
    }
    return summaries;
  }

  /**
   * Flush one recipient (when given) or every recipient with buffered events.
   *
   * @returns The emitted digests.
   */
  async flush(recipient?: string, now: number = this.now()): Promise<DigestSummary | null> {
    if (recipient !== undefined) {
      return this.flushRecipient(recipient, now);
    }
    for (const key of Array.from(this.pending.keys())) {
      await this.flushRecipient(key, now);
    }
    return null;
  }

  /** Start the periodic sweep that emits interval-based digests. */
  start(): void {
    if (!this.config.enabled || this.timer || this.stopped) return;

    this.timer = setInterval(() => {
      void this.collectDue()
        .then((summaries) => {
          for (const summary of summaries) {
            // Text is pre-formatted; delivery is the handler's responsibility.
            logger.debug('Digest emitted', {
              recipient: summary.recipient,
              eventCount: summary.eventCount,
            });
          }
        })
        .catch((error) => logger.error('Digest sweep failed', { error }));
    }, this.config.intervalMs);
    this.timer.unref?.();
  }

  /** Stop the sweep and drop buffered events without emitting them. */
  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.pending.clear();
  }

  private async flushRecipient(recipient: string, now: number): Promise<DigestSummary | null> {
    const group = this.pending.get(recipient);
    if (!group || group.events.length === 0) {
      this.pending.delete(recipient);
      return null;
    }
    this.pending.delete(recipient);

    const summary = this.buildSummary(recipient, group.events, group.windowStart, now);
    await this.onDigest(summary);
    return summary;
  }

  private buildSummary(
    recipient: string,
    events: DigestEvent[],
    windowStart: number,
    windowEnd: number,
  ): DigestSummary {
    const intervalStart = new Date(windowStart).toISOString();
    const intervalEnd = new Date(windowEnd).toISOString();

    const lines = events.map((event) =>
      this.translator.t('digest.event.line', {
        eventName: event.eventName,
        contractAddress: event.contractAddress,
        ledger: event.ledger ?? 'n/a',
      }),
    );

    return {
      recipient,
      intervalStart,
      intervalEnd,
      eventCount: events.length,
      events: [...events],
      eventIds: events.map((event) => event.eventId),
      generatedAt: intervalEnd,
      title: this.translator.t('digest.title'),
      text: this.translator.t('digest.summary', {
        count: events.length,
        intervalStart,
        intervalEnd,
      }),
      lines,
    };
  }
}
