/**
 * Quarantine for repeatedly malformed events (issue #950).
 *
 * This is not the notification dead-letter queue. It isolates an event id so
 * later polls can skip it without failing the rest of the batch. An operator
 * must call `recover` before that event is eligible again; nothing is retried
 * automatically.
 */

import { sanitizeCredentials } from '../utils/credential-sanitizer';

export interface MalformedEventSignal {
  eventId: string;
  contractAddress: string;
  ledger?: number | null;
  reason: string;
  category: string;
}

export interface QuarantineRecord {
  eventId: string;
  contractAddress: string;
  ledger: number | null;
  reason: string;
  category: string;
  consecutiveFailures: number;
  quarantineCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  quarantinedAt: string | null;
  recoveredAt: string | null;
  status: 'observing' | 'quarantined' | 'recovered';
}

export interface QuarantineObservation {
  recorded: boolean;
  blocked: boolean;
  record?: QuarantineRecord;
}

function keyFor(eventId: string, contractAddress: string): string {
  return `${contractAddress}\n${eventId}`;
}

export class EventQuarantineController {
  private readonly records = new Map<string, QuarantineRecord>();

  constructor(private readonly threshold = 3) {
    if (!Number.isInteger(threshold) || threshold < 1) {
      throw new Error('Quarantine threshold must be an integer greater than or equal to 1');
    }
  }

  /**
   * Count one malformed observation. At the threshold the event is quarantined
   * and `isBlocked` starts returning true. Other event keys are left alone.
   */
  recordMalformed(signal: MalformedEventSignal): QuarantineObservation {
    const eventId = signal.eventId?.trim() ?? '';
    const contractAddress = signal.contractAddress?.trim() ?? '';
    if (eventId === '' || contractAddress === '') {
      return { recorded: false, blocked: false };
    }

    const now = new Date().toISOString();
    const key = keyFor(eventId, contractAddress);
    const existing = this.records.get(key);
    const reason = sanitizeCredentials(signal.reason || 'malformed event');
    const category = sanitizeCredentials(signal.category || 'malformed_payload');
    const ledger =
      typeof signal.ledger === 'number' && Number.isInteger(signal.ledger) ? signal.ledger : null;

    if (!existing) {
      const record: QuarantineRecord = {
        eventId,
        contractAddress,
        ledger,
        reason,
        category,
        consecutiveFailures: 1,
        quarantineCount: this.threshold === 1 ? 1 : 0,
        firstSeenAt: now,
        lastSeenAt: now,
        quarantinedAt: this.threshold === 1 ? now : null,
        recoveredAt: null,
        status: this.threshold === 1 ? 'quarantined' : 'observing',
      };
      this.records.set(key, record);
      return { recorded: true, blocked: record.status === 'quarantined', record };
    }

    existing.lastSeenAt = now;
    existing.reason = reason;
    existing.category = category;
    if (ledger !== null) existing.ledger = ledger;

    if (existing.status === 'quarantined') {
      existing.consecutiveFailures += 1;
      return { recorded: true, blocked: true, record: existing };
    }

    existing.consecutiveFailures += 1;
    if (existing.consecutiveFailures >= this.threshold) {
      existing.status = 'quarantined';
      existing.quarantinedAt = now;
      existing.quarantineCount += 1;
    }

    return { recorded: true, blocked: existing.status === 'quarantined', record: existing };
  }

  isBlocked(eventId: string | undefined, contractAddress: string): boolean {
    if (!eventId) return false;
    return this.records.get(keyFor(eventId, contractAddress))?.status === 'quarantined';
  }

  /**
   * Explicit operator recovery. Quarantined events stay blocked until this
   * is called. The diagnostic record is kept.
   */
  recover(eventId: string, contractAddress: string): QuarantineRecord {
    const record = this.records.get(keyFor(eventId, contractAddress));
    if (!record || record.status !== 'quarantined') {
      throw new Error('Event is not quarantined');
    }

    record.status = 'recovered';
    record.recoveredAt = new Date().toISOString();
    record.consecutiveFailures = 0;
    return record;
  }

  get(eventId: string, contractAddress: string): QuarantineRecord | undefined {
    return this.records.get(keyFor(eventId, contractAddress));
  }

  list(): QuarantineRecord[] {
    return Array.from(this.records.values());
  }
}
